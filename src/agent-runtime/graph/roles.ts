import { ROLE_SKILLS, OPENSPEC_VERSION, OpenSpecTools, OpenSpecParticipationError, openSpecRepairPrompt } from '../openspec.js'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { PipelineContext } from '../../installer/runtime/pipeline-state.js'
import type { ExecutorRegistry } from '../executors.js'
import { AgentExecutionError, unknownUsage, type AgentEvent, type AgentResult, type AgentRole, type AgentUsage, type RuntimeConfig } from '../executor-types.js'
import { sumCacheUsage } from '../efficiency-types.js'
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
  openspec?: Record<AgentRole, import('../openspec.js').OpenSpecRoleContext>
  onAgentEvent?: (role: AgentRole, event: AgentEvent) => void
}

const REPAIRABLE = /Invalid|Expected|requires|Duplicate|malformed/i

export function sumUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  const add = (x: number | null, y: number | null): number | null => x === null || y === null ? null : x + y
  return { inputTokens: add(a.inputTokens, b.inputTokens), outputTokens: add(a.outputTokens, b.outputTokens), costUsd: add(a.costUsd, b.costUsd), ...sumCacheUsage([a, b]) }
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
    const started = performance.now()
    let toolCalls = 0, succeeded = false, usage = unknownUsage()
    const onEvent = forward(role, structured)
    try {
      if (deps.openspec?.[role]) note(role, `OpenSpec ${OPENSPEC_VERSION}: ${ROLE_SKILLS[role]} (official skill document through scoped tools).`)
      const result = await registry.execute(selected.provider, {
        role, prompt, openspec: deps.openspec?.[role], cwd: context.artifactRoot, allowedRoots: context.repositories.map(repo => repo.path),
        model: selected.model, maxTurns: selected.maxTurns, signal: step.signal,
        timeoutMs: config.limits?.timeoutMs,
        maxTokens: budget.maxTokens, maxCostUsd: budget.maxCostUsd,
        ...extra, onEvent: event => { if (event.kind === 'tool-start') toolCalls++; onEvent(event) },
      })
      usage = result.usage
      step.reportUsage(result.usage)
      succeeded = true
      return result
    } catch (error) {
      usage = error instanceof AgentExecutionError ? error.usage : unknownUsage()
      step.reportUsage(usage)
      throw error
    } finally {
      await step.reportInvocation?.({ provider: selected.provider, ...(selected.model ? { model: selected.model } : {}), status: succeeded ? 'succeeded' : 'failed', durationMs: Math.max(0, performance.now() - started), toolCalls, usage })
    }
  }

  return async <T>(role: AgentRole, step: WorkflowStepContext, options: InvokeOptions, accept: Accept<T>): Promise<InvokeOutcome<T>> => {
    const structured = options.structured === true
    const workflow = deps.openspec?.[role] ? new OpenSpecTools(deps.openspec[role]) : undefined
    const cursor = workflow?.participationCursor() ?? 0
    const evaluate = (result: AgentResult): InvokeOutcome<T> => {
      let output: Record<string, unknown> | undefined, parseError: unknown
      if (structured) {
        try { output = result.structured ?? parseAgentObject(result.text) } catch (error) { parseError = error }
      }
      // A genuine architect question can precede artifact creation. Completed
      // role results must prove this invocation used the workflow, not an old visit.
      if (!(role === 'architect' && output?.confidence === 'low')) workflow?.assertParticipation(cursor)
      if (structured && !output && !options.lenient) throw new Error('Invalid structured role response: ' + (parseError instanceof Error ? parseError.message : 'missing object'))
      return { ok: true, value: accept(output, result.text, result), text: result.text, result }
    }
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
      let problem: string, omittedWorkflow = false
      try { return evaluate(result) }
      catch (error) {
        problem = error instanceof Error ? error.message : String(error)
        omittedWorkflow = error instanceof OpenSpecParticipationError
        if (!omittedWorkflow && !REPAIRABLE.test(problem)) return { ok: false, error: problem }
      }
      // A single repair budget covers protocol omissions and malformed output.
      // Use the same provider session when possible; sessionless APIs receive the
      // complete original role prompt and existing artifacts, never another role.
      if (!omittedWorkflow && !result.sessionId) return { ok: false, error: problem }
      const repair = omittedWorkflow ? openSpecRepairPrompt(workflow!.context) : repairInstructions(role, problem)
      note(role, omittedWorkflow
        ? `The ${role} omitted its required OpenSpec workflow; requesting one correction in the same role before accepting the result.`
        : `The ${role} reply was not a valid result (${problem}); asking the same session to resend it.`)
      const repaired = await execute(role, step,
        result.sessionId ? repair : (options.fallbackPrompt ?? options.prompt) + '\n' + repair,
        structured, { resumeSessionId: result.sessionId, outputSchema: options.outputSchema })
      try { return evaluate(repaired) }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }

    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
