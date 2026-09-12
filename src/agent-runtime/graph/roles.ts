import path from 'node:path'
import type { PipelineContext } from '../../installer/runtime/pipeline-state.js'
import type { ExecutorRegistry } from '../executors.js'
import { AgentExecutionError, type AgentEvent, type AgentResult, type AgentRole, type AgentUsage, type RuntimeConfig } from '../executor-types.js'
import { repairInstructions } from '../prompts.js'
import type { WorkflowStepContext } from '../workflow-types.js'
import { parseAgentObject } from './artifacts.js'

/** Executor failures that mean "this session cannot be continued", not "the role failed". */
export const SESSION_FALLBACK_CODES = new Set(['provider_execution_error', 'provider_spawn_error', 'incomplete_response', 'invalid_response', 'provider_not_found'])

export interface InvokeOptions {
  prompt: string
  /** Parse the reply as one JSON object and hand it to `accept`. */
  structured?: boolean
  /** Structured, but an unparseable reply is accepted as prose instead of repaired (`accept` gets `undefined`). */
  lenient?: boolean
  outputSchema?: Record<string, unknown>
  resumeSessionId?: string
  /** Full prompt for a fresh session when the resumed session is unavailable. */
  fallbackPrompt?: string
}
export type InvokeOutcome<T> =
  | { ok: true; value: T; text: string; result: AgentResult }
  | { ok: false; error: string }
/** Validates and converts a role's reply. Throwing `Invalid|Expected|requires|Duplicate|malformed` requests one repair turn. */
export type Accept<T> = (output: Record<string, unknown> | undefined, text: string, result: AgentResult) => T
export type RoleInvoker = <T>(role: AgentRole, step: WorkflowStepContext, options: InvokeOptions, accept: Accept<T>) => Promise<InvokeOutcome<T>>

export interface RoleInvokerDeps {
  context: PipelineContext
  config: RuntimeConfig
  registry: ExecutorRegistry
  onAgentEvent?: (role: AgentRole, event: AgentEvent) => void
}

const REPAIRABLE = /Invalid|Expected|requires|Duplicate|malformed/i

export function sumUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  const add = (x: number | null, y: number | null): number | null => x === null || y === null ? null : x + y
  return { inputTokens: add(a.inputTokens, b.inputTokens), outputTokens: add(a.outputTokens, b.outputTokens), costUsd: add(a.costUsd, b.costUsd) }
}

/**
 * One role turn against the configured executor: budget-aware request, live
 * event forwarding with repository-relative paths, structured parsing with a
 * single in-session repair turn, and session fallback for corrections. Usage
 * is reported to the step as soon as each provider call returns, so a later
 * interrupt or failure never loses spend.
 */
export function createRoleInvoker(deps: RoleInvokerDeps): RoleInvoker {
  const { context, config, registry } = deps
  const roots = [...context.repositories.map(repo => repo.path)].sort((a, b) => b.length - a.length)
  const relativize = (detail: string): string => {
    // Host logs read better with repository-relative paths; the tool call itself is unchanged.
    for (const root of roots) {
      if (detail === root) return context.repositories.length > 1 ? path.basename(root) : '.'
      if (detail.startsWith(root + path.sep)) return (context.repositories.length > 1 ? path.basename(root) + path.sep : '') + detail.slice(root.length + 1)
    }
    return detail
  }
  const forward = (role: AgentRole, structured: boolean) => (event: AgentEvent): void => {
    // The final JSON of a structured role is an artifact, not narration; the host
    // reports what it did with it instead of echoing it into the log.
    if (structured && event.kind === 'text' && /^\s*(\{|```)/.test(event.text ?? '')) return
    const shaped = event.kind === 'tool-start' && event.detail ? { ...event, detail: relativize(event.detail) } : event
    try { deps.onAgentEvent?.(role, shaped) } catch { /* Observer cannot replay agent effects. */ }
  }
  const note = (role: AgentRole, text: string): void => { try { deps.onAgentEvent?.(role, { kind: 'text', text }) } catch { /* Observer cannot replay agent effects. */ } }
  const execute = async (role: AgentRole, step: WorkflowStepContext, prompt: string, structured: boolean, extra: { resumeSessionId?: string; outputSchema?: Record<string, unknown> }): Promise<AgentResult> => {
    const selected = config.agents[role]
    const budget = step.remainingBudget()
    try {
      const result = await registry.execute(selected.provider, {
        role, prompt, cwd: context.artifactRoot, allowedRoots: context.repositories.map(repo => repo.path),
        model: selected.model, maxTurns: selected.maxTurns, signal: step.signal,
        timeoutMs: config.limits?.timeoutMs,
        maxTokens: budget.maxTokens, maxCostUsd: budget.maxCostUsd,
        ...extra, onEvent: forward(role, structured),
      })
      step.reportUsage(result.usage)
      return result
    } catch (error) {
      if (error instanceof AgentExecutionError) step.reportUsage(error.usage)
      throw error
    }
  }

  return async <T>(role: AgentRole, step: WorkflowStepContext, options: InvokeOptions, accept: Accept<T>): Promise<InvokeOutcome<T>> => {
    const structured = options.structured === true
    try {
      let result: AgentResult
      if (options.resumeSessionId && options.fallbackPrompt) {
        // A correction pass continues the role's own session: the work it did and
        // the reasons behind it are already in context.
        try { result = await execute(role, step, options.prompt, structured, { resumeSessionId: options.resumeSessionId, outputSchema: options.outputSchema }) }
        catch (error) {
          if (!(error instanceof AgentExecutionError) || !SESSION_FALLBACK_CODES.has(error.code)) throw error
          note(role, `Previous ${role} session is unavailable; starting a fresh ${role} turn with the same instructions.`)
          result = await execute(role, step, options.fallbackPrompt, structured, { outputSchema: options.outputSchema })
        }
      } else {
        result = await execute(role, step, options.prompt, structured, { resumeSessionId: options.resumeSessionId, outputSchema: options.outputSchema })
      }
      if (!structured) return { ok: true, value: accept(undefined, result.text, result), text: result.text, result }
      let output: Record<string, unknown> | undefined, problem: string | undefined
      try { output = result.structured ?? parseAgentObject(result.text) } catch (error) { problem = error instanceof Error ? error.message : String(error) }
      if (!output && options.lenient) return { ok: true, value: accept(undefined, result.text, result), text: result.text, result }
      if (output) {
        try { return { ok: true, value: accept(output, result.text, result), text: result.text, result } }
        catch (error) {
          problem = error instanceof Error ? error.message : String(error)
          if (!REPAIRABLE.test(problem)) return { ok: false, error: problem }
        }
      }
      // One bounded repair turn inside the same session: the role keeps its work
      // and only resends the object. Without a session the role starts over once.
      if (!result.sessionId) return { ok: false, error: problem ?? 'Unusable structured reply' }
      note(role, `The ${role} reply was not a valid result (${problem}); asking the same session to resend it.`)
      const repaired = await execute(role, step, repairInstructions(role, problem!), structured, { resumeSessionId: result.sessionId, outputSchema: options.outputSchema })
      try { return { ok: true, value: accept(repaired.structured ?? parseAgentObject(repaired.text), repaired.text, repaired), text: repaired.text, result: repaired } }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
