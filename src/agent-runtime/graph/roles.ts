import { resolveRoleDescriptor } from '../config.js'
import { isBuiltinRole } from '../executor-types.js'
import { repositoryContextSnapshot, renderRepositoryContext } from '../repository-context.js'
import { readRoleState, writeRoleState, type RoleStatePort } from '../role-state.js'
import { fingerprint } from '../durable-store.js'
import { selectRoleRoute, type InvocationKind } from '../role-routing.js'
import { openSpecSkill, OPENSPEC_VERSION, OpenSpecTools, OpenSpecParticipationError, openSpecRepairPrompt } from '../openspec.js'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { frozenAcceptanceCriteria, pipelineStateDirectory, type PipelineContext } from '../../pipeline/pipeline-state.js'
import type { ExecutorRegistry } from '../executors.js'
import { AgentExecutionError, unknownUsage, type AgentEvent, type AgentEventRole, type AgentResult, type AgentRole, type RuntimeConfig, type RuntimeAgentConfig } from '../executor-types.js'
import { ROLE_INSTRUCTIONS_VERSION, repairInstructions } from '../prompts.js'
import type { WorkflowStepContext } from '../workflow-types.js'
import { parseAgentObject } from './artifacts.js'

/** Executor failures that mean "this session cannot be continued", not "the role failed". */
const SESSION_FALLBACK_CODES = new Set(['session_not_found', 'session_expired', 'session_unsupported'])

export interface InvokeOptions {
  kind?: InvocationKind
  prompt: string
  /** Parse the reply as one JSON object and hand it to `accept`. */
  structured?: boolean
  /** Structured, but an unparseable reply is accepted as prose instead of repaired (`accept` gets `undefined`). */
  lenient?: boolean
  outputSchema?: Record<string, unknown>
  resumeSessionId?: string
  /** Full prompt for a fresh session when the resumed session is unavailable. */
  fallbackPrompt?: string
  /** Run this invocation on another configured engine (the fixer) with the matching stance; sessions never carry across engines. */
  agentOverride?: RuntimeAgentConfig
  stance?: 'fixer'
}
export type InvokeOutcome<T> =
  | { ok: true; value: T; text: string; result: AgentResult }
  | { ok: false; error: string; code?: string }
/** Validates and converts a role's reply. Throwing `Invalid|Expected|requires|Duplicate|malformed` requests one repair turn. */
export type Accept<T> = (output: Record<string, unknown> | undefined, text: string, result: AgentResult) => T
export type RoleInvoker = <T>(role: AgentRole, step: WorkflowStepContext, options: InvokeOptions, accept: Accept<T>) => Promise<InvokeOutcome<T>>

export interface RoleInvokerDeps {
  context: PipelineContext
  config: RuntimeConfig
  registry: ExecutorRegistry
  openspec?: Record<AgentRole, import('../openspec.js').OpenSpecRoleContext>
  /** Engine hosts isolate sessions/routes by scope and node instead of a role-global file. */
  roleState?: RoleStatePort
  /** `fixer` labels the developer step's events during a correction round on the fixer stance, so a log reader sees who is acting. */
  onAgentEvent?: (role: AgentEventRole, event: AgentEvent) => void
}

const REPAIRABLE = /Invalid|Expected|requires|Duplicate|malformed/i

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
  const forward = (role: AgentEventRole, structured: boolean) => (event: AgentEvent): void => {
    // The final JSON of a structured role is an artifact, not narration; the host
    // reports what it did with it instead of echoing it into the log.
    if (structured && event.kind === 'text' && /^\s*(\{|```)/.test(event.text ?? '')) return
    const shaped = event.kind === 'tool-start' && event.detail ? { ...event, detail: relativize(event.detail) } : event
    try { deps.onAgentEvent?.(role, shaped) } catch { /* Observer cannot replay agent effects. */ }
  }
  const note = (role: AgentEventRole, text: string): void => { try { deps.onAgentEvent?.(role, { kind: 'text', text }) } catch { /* Observer cannot replay agent effects. */ } }
  const execute = async (role: AgentRole, step: WorkflowStepContext, prompt: string, structured: boolean, extra: { kind?: InvocationKind; resumeSessionId?: string; outputSchema?: Record<string, unknown>; fallbackPrompt?: string; agentOverride?: RuntimeAgentConfig; stance?: 'fixer' }): Promise<AgentResult> => {
    const directory = deps.openspec?.[role]?.stateDirectory ?? path.join(pipelineStateDirectory(context), 'agent-workflow')
    const saved = deps.roleState?.read() ?? readRoleState(directory)
    const persist = (): void => deps.roleState ? deps.roleState.write(saved) : writeRoleState(directory, saved)
    const budget = step.remainingBudget()
    if (budget.maxTokens === 0 || budget.maxCostUsd === 0 || step.signal.aborted) throw new AgentExecutionError('No budget remains for another role invocation', step.signal.aborted ? 'aborted' : 'budget_exhausted', { inputTokens: 0, outputTokens: 0, costUsd: 0 })
    const kind = extra.kind ?? (extra.resumeSessionId ? 'correction' : 'initial')
    const descriptor = resolveRoleDescriptor(config, role)
    const route = selectRoleRoute(role, extra.agentOverride ?? (isBuiltinRole(role) ? config.agents[role] : descriptor), kind, step.checkpoint, extra.agentOverride ? undefined : saved.routes[role])
    const selected = route.selection
    const capabilities = await registry.capabilities(selected.provider, selected.model)
    const identity = fingerprint({ role, selected, transport: capabilities.transport, instructionsVersion: ROLE_INSTRUCTIONS_VERSION, provider: config.providers.find(provider => provider.id === selected.provider) ?? selected.provider, definition: (extra.agentOverride ? config.rolePrompts?.fixer : config.rolePrompts?.[role] ?? descriptor.prompt) ?? null, ...(isBuiltinRole(role) ? {} : { policy: descriptor }), openspec: deps.openspec?.[role] ?? null, context })
    const previous = saved.sessions[role]
    const resumeSessionId = capabilities.continuation === 'supported' && previous?.identity === identity && previous.sessionId === extra.resumeSessionId ? extra.resumeSessionId : undefined
    const snapshot = repositoryContextSnapshot(context)
    const incremental = Boolean(resumeSessionId && capabilities.resumeRequiresFullContext !== true && config.efficiency?.contextMode !== 'full')
    const packet = renderRepositoryContext(snapshot, incremental ? previous?.context : undefined)
    const rolePrompt = (!resumeSessionId || capabilities.resumeRequiresFullContext) && extra.fallbackPrompt ? extra.fallbackPrompt : prompt
    const obligations = '\nCurrent frozen acceptance obligations (all remain required):\n' + JSON.stringify(frozenAcceptanceCriteria(context))
    const fullPrompt = rolePrompt + (step.operatorSteering ?? '') + obligations + '\n\n' + packet
    if (extra.agentOverride) note(role, `Fixer route: ${selected.provider}/${selected.model ?? 'provider default'} — correction round on the fixer engine`)
    else if (saved.routes[role]?.tier !== route.tier) note(role, `Role route: ${selected.provider}/${selected.model ?? 'provider default'} — ${route.reason}`)
    if (!extra.agentOverride) { saved.routes[role] = { tier: route.tier, reason: route.reason, attemptId: step.attemptId }; persist() }
    const measurement = { provider: selected.provider, ...(selected.model ? { model: selected.model } : {}),
      contextMode: incremental ? 'incremental' as const : 'full' as const, promptBytes: Buffer.byteLength(fullPrompt), contextBytes: Buffer.byteLength(packet), handoffBytes: Buffer.byteLength(rolePrompt), requestedEffort: selected.effort ?? null,
      kind, tier: route.tier, routeReason: route.reason }
    const invocationIdentity = await step.reportInvocationStarted?.(measurement)
    const started = performance.now()
    let toolCalls = 0, succeeded = false, usageReported = false, usage = unknownUsage()
    // Tool calls and notes of a correction round are attributed to the FIXER so
    // the log reads `[fixer] read_file …`, not as another developer pass.
    const onEvent = forward(extra.stance === 'fixer' ? 'fixer' : role, structured)
    try {
      if (deps.openspec?.[role]) note(role, `OpenSpec ${OPENSPEC_VERSION}: ${openSpecSkill(deps.openspec![role]!)} (official skill document through scoped tools).`)
      const result = await registry.execute(selected.provider, {
        role, access: descriptor.access, artifacts: descriptor.artifacts, instructions: 'role', prompt: fullPrompt, openspec: deps.openspec?.[role] ? { ...deps.openspec[role], ...(role === 'architect' ? {} : { evidenceScope: { backlogRoot: context.backlogRoot, runId: context.runId } }) } : undefined, cwd: context.artifactRoot, allowedRoots: context.repositories.map(repo => repo.path),
        model: selected.model, effort: selected.effort, ...(selected.thinking ? { thinking: selected.thinking } : {}), maxTurns: selected.maxTurns, signal: step.signal,
        timeoutMs: config.limits?.timeoutMs,
        maxTokens: budget.maxTokens, maxCostUsd: budget.maxCostUsd,
        ...(config.guardrails ? { guardrails: config.guardrails } : {}),
        ...(extra.stance ? { stance: extra.stance } : {}),
        resumeSessionId, outputSchema: extra.outputSchema, onEvent: event => { if (event.kind === 'tool-start') toolCalls++; onEvent(event) },
      })
      usage = result.usage
      step.reportUsage(result.usage)
      usageReported = true
      if (result.sessionId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result.sessionId)) saved.sessions[role] = { identity, sessionId: result.sessionId, context: snapshot }
      else delete saved.sessions[role]
      persist()
      succeeded = true
      return result
    } catch (error) {
      if (!usageReported) {
        usage = error instanceof AgentExecutionError ? error.usage : unknownUsage()
        step.reportUsage(usage)
      }
      throw error
    } finally {
      await step.reportInvocation?.({ ...measurement, ...invocationIdentity, status: succeeded ? 'succeeded' : 'failed', durationMs: Math.max(0, performance.now() - started), toolCalls, usage })
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
        try { result = await execute(role, step, options.prompt, structured, { kind: options.kind, resumeSessionId: options.resumeSessionId, outputSchema: options.outputSchema, fallbackPrompt: options.fallbackPrompt, agentOverride: options.agentOverride, stance: options.stance }) }
        catch (error) {
          if (!(error instanceof AgentExecutionError) || !SESSION_FALLBACK_CODES.has(error.code)) throw error
          note(role, `Previous ${role} session is unavailable; starting a fresh ${role} turn with the same instructions.`)
          result = await execute(role, step, options.fallbackPrompt, structured, { kind: 'session-fallback', outputSchema: options.outputSchema, agentOverride: options.agentOverride, stance: options.stance })
        }
      } else {
        result = await execute(role, step, options.prompt, structured, { kind: options.kind, resumeSessionId: options.resumeSessionId, outputSchema: options.outputSchema, fallbackPrompt: options.fallbackPrompt, agentOverride: options.agentOverride, stance: options.stance })
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
      const repair = omittedWorkflow ? openSpecRepairPrompt(workflow!.context) : repairInstructions(role, problem)
      note(role, omittedWorkflow
        ? `The ${role} omitted its required OpenSpec workflow; requesting one correction in the same role before accepting the result.`
        : `The ${role} reply was not a valid result (${problem}); asking the same session to resend it.`)
      const repaired = await execute(role, step,
        result.sessionId ? repair : (options.fallbackPrompt ?? options.prompt) + '\n' + repair,
        structured, { kind: 'repair', resumeSessionId: result.sessionId, outputSchema: options.outputSchema,
          fallbackPrompt: (options.fallbackPrompt ?? options.prompt) + '\nPrevious response (bounded):\n' + result.text.slice(-32_000) + '\n' + repair,
        })
      try { return evaluate(repaired) }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }

    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof AgentExecutionError ? { code: error.code } : {}) }
    }
  }
}
