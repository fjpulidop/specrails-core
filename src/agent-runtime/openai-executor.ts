import { readVerificationEvidence } from '../installer/runtime/pipeline-state.js'
import { toolEvent } from './tool-event.js'
import { assertEffortSupported, unknownCapabilities } from './capabilities.js'
import { OpenSpecTools, OPENSPEC_TOOL_DEFINITION, openSpecPrompt } from './openspec.js'
import { AgentExecutionError, unknownUsage, validateAgentRequest, type AgentExecutor, type AgentLimits, type AgentRequest, type AgentResult, type AgentUsage, type RuntimeProviderConfig } from './executor-types.js'
import { sumCacheUsage } from './efficiency-types.js'
import { WorkspaceTools } from './workspace-tools.js'

type ApiProvider = Extract<RuntimeProviderConfig, { kind: 'openai-compatible' }>
export interface OpenAICompatibleOptions { fetch?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null }
function add(left: number | null, right: number | null): number | null { return left === null || right === null ? null : left + right }
export function parseStructuredText(text: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, ''))) } catch { return undefined }
}
/** No SDK, gateway, tracing backend, paid probe, or mandatory key. */
export class OpenAICompatibleExecutor implements AgentExecutor {
  constructor(private readonly provider: ApiProvider, private readonly options: OpenAICompatibleOptions = {}) {}
  capabilities() { return { ...unknownCapabilities('openai-compatible'), continuation: 'unsupported' as const, effortSupport: 'unsupported' as const, supportedEfforts: [] } }
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
    const definitions = [...toolset.definitions(), ...(openspec ? [OPENSPEC_TOOL_DEFINITION] : []), ...(request.openspec?.evidenceScope && request.role !== 'architect' ? [{ type: 'function', function: { name: 'read_verification_evidence', description: 'Read host verification evidence and source files with opaque IDs and bounded cursors. List to discover IDs.', parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, section: { type: 'string', enum: ['summary', 'stdout', 'stderr', 'source'] }, sourceId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }] : [])]
    const maxTurns = request.maxTurns ?? 100
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new AgentExecutionError('maxTurns must be a positive integer', 'invalid_limit')
    const timeoutMs = request.timeoutMs ?? 15 * 60_000
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
    const timer = setTimeout(() => controller.abort(new Error('Agent timeout')), timeoutMs)
    let usage: AgentUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    let responses = 0
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: `You execute one ${request.role} task. Use only the provided workspace tools. Allowed roots: ${JSON.stringify(toolset.roots)}. Working directory: ${toolset.cwd}. Return the complete requested final result. Do not coordinate another workflow. Execute only the assigned role and its supplied OpenSpec workflow.` },
      { role: 'user', content: (request.openspec ? openSpecPrompt(request.openspec) : '') + request.prompt },
    ]
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        controller.signal.throwIfAborted()
        const observed = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        if (request.maxTokens !== undefined && responses && (usage.inputTokens === null || usage.outputTokens === null)) throw new AgentExecutionError('Provider omitted usage required by the token budget', 'usage_unavailable', usage)
        if (request.maxTokens !== undefined && observed >= request.maxTokens) throw new AgentExecutionError('Agent token budget exhausted', 'token_budget', usage)
        const response = await (this.options.fetch ?? globalThis.fetch)(endpoint, {
          method: 'POST', headers, signal: controller.signal, redirect: 'error',
          body: JSON.stringify({ model: request.model, messages, tools: definitions, tool_choice: 'auto', stream: false,
            ...(request.maxTokens === undefined ? {} : { max_tokens: Math.max(1, Math.floor(request.maxTokens - observed)) }),
          }),
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new AgentExecutionError(`OpenAI-compatible provider returned HTTP ${response.status}`, 'provider_http_error', responses ? usage : unknownUsage())
        }
        const body = await readBoundedResponse(response)
        const data = record(body), reported = record(data?.usage)
        const cached = number(record(reported?.prompt_tokens_details)?.cached_tokens)
        const inputTokens = number(reported?.prompt_tokens)
        const cache = record(reported?.prompt_tokens_details)?.cached_tokens === undefined ? {} : {
          cacheReadInputTokens: cached !== null && inputTokens !== null && cached <= inputTokens ? cached : null,
          uncachedInputTokens: cached !== null && inputTokens !== null && cached <= inputTokens ? inputTokens - cached : null,
          cacheWriteInputTokens: null,
        }
        const current: AgentUsage = {
          inputTokens: number(reported?.prompt_tokens), outputTokens: number(reported?.completion_tokens),
          costUsd: number(reported?.cost_usd ?? data?.cost_usd), ...cache,
        }
        usage = { inputTokens: add(usage.inputTokens, current.inputTokens), outputTokens: add(usage.outputTokens, current.outputTokens), costUsd: add(usage.costUsd, current.costUsd), ...(responses === 0 ? cache : sumCacheUsage([usage, current])) }
        responses++
        request.onEvent?.({ kind: 'usage', usage: { ...usage } })
        if (request.maxTokens !== undefined && (usage.inputTokens === null || usage.outputTokens === null)) throw new AgentExecutionError('Provider omitted usage required by the token budget', 'usage_unavailable', usage)
        if (request.maxTokens !== undefined && (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > request.maxTokens) throw new AgentExecutionError('Agent token budget exceeded', 'token_budget', usage)
        if (request.maxCostUsd !== undefined && usage.costUsd !== null && usage.costUsd > request.maxCostUsd) throw new AgentExecutionError('Agent cost budget exceeded', 'cost_budget', usage)
        if (!data || data.error) throw new AgentExecutionError('Provider returned an error or invalid response', 'provider_response_error', usage)
        const choice = Array.isArray(data.choices) ? record(data.choices[0]) : undefined
        const message = record(choice?.message)
        if (!message || message.role !== 'assistant') throw new AgentExecutionError('Provider response has no assistant message', 'invalid_response', usage)
        if (choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter') throw new AgentExecutionError('Provider did not complete the requested result', 'incomplete_response', usage)
        const calls = message.tool_calls
        if (calls !== undefined && !Array.isArray(calls)) throw new AgentExecutionError('Invalid tool calls in provider response', 'invalid_tool_call', usage)
        if (Array.isArray(calls) && calls.length > 0) {
          if (calls.length > 32) throw new AgentExecutionError('Provider requested too many tools in one turn', 'invalid_tool_call', usage)
          messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: calls })
          const ids = new Set<string>()
          for (const raw of calls) {
            controller.signal.throwIfAborted()
            const call = record(raw), fn = record(call?.function)
            if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) || typeof fn?.name !== 'string' || typeof fn.arguments !== 'string') throw new AgentExecutionError('Malformed provider tool call', 'invalid_tool_call', usage)
            ids.add(call.id)
            request.onEvent?.(toolEvent(fn.name, fn.arguments))
            let result: string
            try { result = fn.name === 'read_verification_evidence' && request.openspec?.evidenceScope && request.role !== 'architect' ? JSON.stringify(readVerificationEvidence(request.openspec.evidenceScope, JSON.parse(fn.arguments))) : fn.name === 'openspec_workflow' && openspec ? JSON.stringify(await openspec.execute(JSON.parse(fn.arguments))) : toolset.execute(fn.name, JSON.parse(fn.arguments)) }
            catch (error) { result = JSON.stringify({ error: error instanceof Error ? error.message : 'Tool execution failed' }) }
            messages.push({ role: 'tool', tool_call_id: call.id, content: result })
            request.onEvent?.({ kind: 'tool-end', tool: fn.name })
          }
          continue
        }
        if (typeof message.content !== 'string' || !message.content.trim()) throw new AgentExecutionError('Provider returned an empty final result', 'invalid_response', usage)
        request.onEvent?.({ kind: 'text', text: message.content })
        return { text: message.content, usage, structured: parseStructuredText(message.content) }
      }
      throw new AgentExecutionError(`Agent exhausted ${maxTurns} turns without a final result`, 'max_turns', usage)
    } catch (error) {
      if (error instanceof AgentExecutionError) throw error
      if (controller.signal.aborted) throw new AgentExecutionError(request.signal?.aborted ? 'Agent cancelled' : 'Agent timed out', request.signal?.aborted ? 'aborted' : 'timeout', responses ? usage : unknownUsage())
      // Do not persist provider response bodies, URLs or credentials echoed by errors.
      const code = (error as { cause?: { code?: unknown } }).cause?.code
      const diagnostic = typeof code === 'string' && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(code) ? ` (${code})` : ''
      throw new AgentExecutionError('OpenAI-compatible request failed' + diagnostic, 'provider_request_error', responses ? usage : unknownUsage())
    } finally { clearTimeout(timer); request.signal?.removeEventListener('abort', abort) }
  }
}
async function readBoundedResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Missing response body')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Provider response exceeds 2 MiB') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
