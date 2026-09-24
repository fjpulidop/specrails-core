import { readVerificationEvidence } from '../pipeline/pipeline-state.js'
import { assertEffortSupported, unknownCapabilities } from './capabilities.js'
import { OpenSpecTools, OPENSPEC_TOOL_DEFINITION, openSpecPrompt } from './openspec.js'
import { AgentExecutionError, unknownUsage, validateAgentRequest, type AgentExecutor, type AgentLimits, type AgentRequest, type AgentEvent, type AgentResult, type RuntimeProviderConfig } from './executor-types.js'
import { WorkspaceTools } from './workspace-tools.js'
import { ChatClient, record, type ChatMessage } from './compact/chat-client.js'
import { DEFAULT_CONTEXT_WINDOW_TOKENS, runToolLoop } from './compact/guarded-loop.js'
import { extractPromptInputs } from './compact/prompt-inputs.js'
import type { CompactEnv } from './compact/step.js'
import { runCompactArchitect } from './compact/architect.js'
import { runCompactDeveloper } from './compact/developer.js'
import { runCompactReviewer } from './compact/reviewer.js'

type ApiProvider = Extract<RuntimeProviderConfig, { kind: 'openai-compatible' }>
export interface OpenAICompatibleOptions { fetch?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv; /** Test seams: the role budget used when the request carries none, and the compact idle bound. */ defaultTimeoutMs?: number; idleTimeoutMs?: number }
export function parseStructuredText(text: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, ''))) } catch { return undefined }
}
/** The agent loop an openai-compatible provider runs: compact host-driven pipelines by default. */
/** The OpenAI `reasoning_effort` tiers a compatible endpoint accepts. */
const OPENAI_EFFORTS = ['low', 'medium', 'high'] as const
function resolveAgentLoop(provider: ApiProvider): 'compact' | 'free' { return provider.agentLoop ?? 'compact' }
/** Compact runs: abort when NOTHING happens for this long (no tool call, reply or usage) — the real hang detector now that the wall clock is per task group. A non-streaming 16k reply at 20 tok/s is ~13 min, hence the margin. */
const IDLE_TIMEOUT_MS = 20 * 60_000
function resolveContextWindow(provider: ApiProvider): number { return provider.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS }
/** The per-turn output budget the connection declares; undefined keeps the loop's default. */
function resolveOutputBudget(provider: ApiProvider): number | undefined { return provider.maxOutputTokens }

/** No SDK, gateway, tracing backend, paid probe, or mandatory key. */
export class OpenAICompatibleExecutor implements AgentExecutor {
  constructor(private readonly provider: ApiProvider, private readonly options: OpenAICompatibleOptions = {}) {}
  capabilities() { return { ...unknownCapabilities('openai-compatible'), continuation: 'unsupported' as const, ...(this.provider.supportsReasoningEffort ? { effortSupport: 'supported' as const, supportedEfforts: [...OPENAI_EFFORTS] } : { effortSupport: 'unsupported' as const, supportedEfforts: [] }), agentLoop: resolveAgentLoop(this.provider), contextWindowTokens: resolveContextWindow(this.provider) } }
  validateLimits(limits: AgentLimits): void {
    if (limits.maxCostUsd !== undefined) throw new AgentExecutionError('A strict USD cap requires an executor with a native spending limit; OpenAI-compatible endpoints do not provide one. Use a token cap or an executor with native cost enforcement.', 'cost_limit_unsupported')
  }
  async execute(request: AgentRequest): Promise<AgentResult> {
    validateAgentRequest(request)
    assertEffortSupported(request, this.capabilities())
    this.validateLimits(request)
    if (!request.model?.trim()) throw new AgentExecutionError('OpenAI-compatible execution requires a model', 'invalid_model')
    const controller = new AbortController()
    const toolset = new WorkspaceTools(request.cwd, request.allowedRoots, request.role)
    const openspec = request.openspec ? new OpenSpecTools(request.openspec, controller.signal) : undefined
    const evidenceScope = request.openspec?.evidenceScope && request.role !== 'architect' ? request.openspec.evidenceScope : undefined
    const definitions = [...toolset.definitions(), ...(openspec ? [OPENSPEC_TOOL_DEFINITION] : []), ...(evidenceScope ? [{ type: 'function', function: { name: 'read_verification_evidence', description: 'Read host verification evidence and source files with opaque IDs and bounded cursors. List to discover IDs.', parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, section: { type: 'string', enum: ['summary', 'stdout', 'stderr', 'source'] }, sourceId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }] : [])]
    const maxTurns = request.maxTurns ?? 100
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new AgentExecutionError('maxTurns must be a positive integer', 'invalid_limit')
    // The compact pipelines are several bounded model calls per role (the
    // architect alone is ~8); a role budget sized for one agentic call would
    // cut them off. Scale the DEFAULT only — an explicit timeout is respected.
    const compact = resolveAgentLoop(this.provider) === 'compact' && request.openspec !== undefined
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? (compact ? 45 * 60_000 : 15 * 60_000)
    const idleTimeoutMs = this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AgentExecutionError('timeoutMs must be a positive integer', 'invalid_limit')
    const env = this.options.env ?? process.env
    const key = this.provider.apiKeyEnv ? env[this.provider.apiKeyEnv] : undefined
    if (this.provider.apiKeyEnv && !key) throw new AgentExecutionError(`Credential environment variable ${this.provider.apiKeyEnv} is not set`, 'missing_credential')
    const endpoint = new URL(this.provider.baseUrl.replace(/\/+$/, '') + '/chat/completions')
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new AgentExecutionError('Invalid OpenAI-compatible endpoint', 'invalid_endpoint')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (key) headers.Authorization = `Bearer ${key}`
    const abort = (): void => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
    // The wall clock is a BUDGET PER UNIT OF WORK, not per role: a compact
    // developer re-arms it at every task group (`env.resetDeadline`), so a
    // local model at ~5 min per turn is not killed at minute 45 of a three-
    // group role while it is still producing (observed: groups 1–2 verified
    // green, group 3 cut mid-patch, whole run failed). A genuine hang is the
    // idle watchdog's job: no tool call, reply or usage for IDLE_TIMEOUT_MS.
    let timer = setTimeout(() => controller.abort(new Error('Agent timeout')), timeoutMs)
    const resetDeadline = (): void => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('Agent timeout')), timeoutMs) }
    let lastActivity = Date.now()
    const idle = compact ? setInterval(() => { if (Date.now() - lastActivity > idleTimeoutMs) controller.abort(new Error('Agent idle timeout')) }, Math.min(15_000, Math.max(50, Math.floor(idleTimeoutMs / 4)))) : undefined
    idle?.unref?.()
    const onEvent = request.onEvent || idle ? (event: AgentEvent): void => { lastActivity = Date.now(); request.onEvent?.(event) } : undefined
    const client = new ChatClient({ endpoint, headers, fetch: this.options.fetch ?? globalThis.fetch, signal: controller.signal, model: request.model, maxTokens: request.maxTokens, maxCostUsd: request.maxCostUsd, onEvent, thinking: request.thinking ?? 'off', ...(this.provider.supportsReasoningEffort && request.effort ? { reasoningEffort: request.effort } : {}), effortSupported: this.provider.supportsReasoningEffort === true })
    const contextWindowTokens = resolveContextWindow(this.provider)
    const maxOutputTokens = resolveOutputBudget(this.provider)
    let compactMode = false
    try {
      // Compact pipelines need the official workflow to drive; a plain role task
      // without an OpenSpec binding runs the guarded loop instead.
      if (resolveAgentLoop(this.provider) === 'compact' && openspec) {
        compactMode = true
        const compact: CompactEnv = { client, request, inputs: extractPromptInputs(request.prompt), toolset, openspec, contextWindowTokens, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), resetDeadline, signal: controller.signal, onEvent, guardrails: request.guardrails, stance: request.stance }
        return request.role === 'architect' ? await runCompactArchitect(compact) : request.role === 'developer' ? await runCompactDeveloper(compact) : await runCompactReviewer(compact)
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: `You execute one ${request.role} task. Use only the provided workspace tools. Allowed roots: ${JSON.stringify(toolset.roots)}. Working directory: ${toolset.cwd}. Return the complete requested final result. Do not coordinate another workflow. Execute only the assigned role and its supplied OpenSpec workflow.` },
        { role: 'user', content: (request.openspec ? openSpecPrompt(request.openspec) : '') + request.prompt },
      ]
      const { text } = await runToolLoop({
        client, messages, tools: definitions, maxTurns, contextWindowTokens, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), onEvent, signal: controller.signal,
        execute: async (name, args) => name === 'read_verification_evidence' && evidenceScope ? JSON.stringify(readVerificationEvidence(evidenceScope, args as Parameters<typeof readVerificationEvidence>[1])) : name === 'openspec_workflow' && openspec ? JSON.stringify(await openspec.execute(args as Parameters<OpenSpecTools['execute']>[0])) : toolset.execute(name, args),
      })
      request.onEvent?.({ kind: 'text', text })
      return { text, usage: client.usage, structured: parseStructuredText(text) }
    } catch (error) {
      if (error instanceof AgentExecutionError) throw error
      if (controller.signal.aborted) {
        const idled = (controller.signal.reason as Error | undefined)?.message === 'Agent idle timeout'
        throw new AgentExecutionError(request.signal?.aborted ? 'Agent cancelled' : idled ? `Agent idle timeout: no tool call, reply or usage for ${Math.round(idleTimeoutMs / 60_000)} minutes` : `Agent timed out after ${Math.round(timeoutMs / 60_000)} minutes${compact ? ' on one task group' : ''}`, request.signal?.aborted ? 'aborted' : 'timeout', client.responses ? client.usage : unknownUsage())
      }
      // Host-driven OpenSpec calls fail with their own message; the graph repairs or reports it.
      if (compactMode && !(error instanceof TypeError)) throw new AgentExecutionError('Compact pipeline step failed: ' + (error instanceof Error ? error.message : String(error)), 'compact_step_failed', client.responses ? client.usage : unknownUsage())
      // Do not persist provider response bodies, URLs or credentials echoed by errors.
      const code = (error as { cause?: { code?: unknown } }).cause?.code
      const diagnostic = typeof code === 'string' && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(code) ? ` (${code})` : ''
      throw new AgentExecutionError('OpenAI-compatible request failed' + diagnostic, 'provider_request_error', client.responses ? client.usage : unknownUsage())
    } finally { clearTimeout(timer); if (idle) clearInterval(idle); request.signal?.removeEventListener('abort', abort) }
  }
}
