import { AgentExecutionError, type AgentEvent, type AgentUsage } from '../executor-types.js'
import { sumCacheUsage } from '../efficiency-types.js'

export type ChatMessage = Record<string, unknown>
/**
 * Node's fetch (undici) aborts a request whose headers take > 5 min or whose
 * body stalls > 5 min (`UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT`).
 * A local model reasoning for minutes before its first token trips both.
 * The step's own AbortSignal is the real deadline, so the compact client
 * dispatches through an undici Agent with those timers off. Built from the
 * global dispatcher's constructor (no dependency); absent ⇒ default fetch.
 */
let patientDispatcher: unknown
function resolvePatientDispatcher(): void {
  try {
    const symbol = Object.getOwnPropertySymbols(globalThis).find(item => String(item).includes('undici.globalDispatcher'))
    const current = symbol ? (globalThis as Record<symbol, unknown>)[symbol] : undefined
    const Agent = current && typeof current === 'object' ? (current as { constructor: new (options: Record<string, unknown>) => unknown }).constructor : undefined
    if (Agent) patientDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 })
  } catch { /* default fetch below */ }
}
/**
 * Node creates its global undici dispatcher LAZILY, on the first fetch — so
 * a fresh runtime process had no symbol to read, `patientDispatcher` stayed
 * null and every request ran with undici's default 300 s body timeout
 * (observed: `UND_ERR_BODY_TIMEOUT` killing a run whose Mac-mini model spent
 * >5 min on one prefill/generation with no bytes on the wire). Force the
 * lazy init with one refused loopback connect, then read the constructor.
 */
export async function ensurePatientDispatcher(): Promise<void> {
  if (patientDispatcher !== undefined) return
  patientDispatcher = null
  resolvePatientDispatcher()
  if (patientDispatcher) return
  try { await globalThis.fetch('http://127.0.0.1:9/', { method: 'HEAD', signal: AbortSignal.timeout(2000) }) } catch { /* the refused connect is the point */ }
  resolvePatientDispatcher()
}
export function patientFetchInit(): Pick<RequestInit, 'dispatcher'> {
  if (patientDispatcher === undefined) { patientDispatcher = null; resolvePatientDispatcher() }
  return patientDispatcher ? { dispatcher: patientDispatcher as RequestInit['dispatcher'] } : {}
}
const RETRY_DELAY_MS = 3000
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true }) })
}
interface ChatCompletion { message: Record<string, unknown>; finishReason: unknown }
interface ChatClientOptions {
  endpoint: URL
  headers: Record<string, string>
  fetch: typeof globalThis.fetch
  signal: AbortSignal
  model: string
  maxTokens?: number
  maxCostUsd?: number
  onEvent?: (event: AgentEvent) => void
  /** Default `reasoning_effort` for every call (the role's configured effort). */
  reasoningEffort?: string
  /** The endpoint declared support for `reasoning_effort`; otherwise it is never sent. */
  effortSupported?: boolean
  /** `off` (the default for local engines) sends `chat_template_kwargs: { enable_thinking: false }` — the Qwen/llama.cpp/vLLM switch; `reasoning_effort`, when declared, still travels (models that steer thinking by effort keep working). `on` leaves the server default. Dropped for the session when the endpoint rejects the field. */
  thinking?: 'on' | 'off'
}
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null }
function add(left: number | null, right: number | null): number | null { return left === null || right === null ? null : left + right }

/**
 * One non-streaming `chat/completions` round trip with the executor's usage
 * accounting: every response adds to the running totals, emits a usage event and
 * is checked against the token/cost budget before the caller sees the message.
 */
export class ChatClient {
  usage: AgentUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  responses = 0
  /** Endpoints without `response_format` support are remembered after the first rejection. */
  structuredOutput: 'unknown' | 'supported' | 'unsupported' = 'unknown'
  /** Effort is sent while the endpoint accepts it; a per-model rejection turns it off for the session. */
  effortEnabled: boolean
  private thinkingOff: boolean
  constructor(private readonly options: ChatClientOptions) { this.effortEnabled = options.effortSupported === true; this.thinkingOff = options.thinking === 'off' }
  /** The effort every call carries unless a per-call control overrides it (undefined when the endpoint declared no support). */
  get defaultEffort(): string | undefined { return this.effortEnabled ? this.options.reasoningEffort : undefined }
  get budgetUsage(): AgentUsage { return this.responses ? this.usage : { inputTokens: null, outputTokens: null, costUsd: null } }
  /** Per-call generation controls. `reasoningEffort` is sent only when the
   *  endpoint declared support; `temperature`/`max_tokens` are universal. */
  async complete(body: { messages: ChatMessage[]; tools?: unknown[]; tool_choice?: string; response_format?: Record<string, unknown> }, controls: { temperature?: number; maxOutputTokens?: number; reasoningEffort?: string } = {}): Promise<ChatCompletion> {
    const { options } = this
    const effort = controls.reasoningEffort ?? options.reasoningEffort
    options.signal.throwIfAborted()
    const observed = (this.usage.inputTokens ?? 0) + (this.usage.outputTokens ?? 0)
    if (options.maxTokens !== undefined && this.responses && (this.usage.inputTokens === null || this.usage.outputTokens === null)) throw new AgentExecutionError('Provider omitted usage required by the token budget', 'usage_unavailable', this.usage)
    if (options.maxTokens !== undefined && observed >= options.maxTokens) throw new AgentExecutionError('Agent token budget exhausted', 'token_budget', this.usage)
    // Local servers hiccup (5xx / connection reset) under long sessions; one
    // bounded retry keeps a 30-minute run from dying on a transient error.
    if (options.fetch === globalThis.fetch) await ensurePatientDispatcher()
    const send = () => options.fetch(options.endpoint, {
      method: 'POST', headers: options.headers, signal: options.signal, redirect: 'error', ...(options.fetch === globalThis.fetch ? patientFetchInit() : {}),
      body: JSON.stringify({ model: options.model, ...body, stream: true, stream_options: { include_usage: true },
        ...(controls.temperature === undefined ? {} : { temperature: controls.temperature }),
        ...(this.effortEnabled && effort ? { reasoning_effort: effort } : {}),
        ...(this.thinkingOff ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        ...(options.maxTokens === undefined
          ? (controls.maxOutputTokens === undefined ? {} : { max_tokens: controls.maxOutputTokens })
          : { max_tokens: Math.max(1, Math.floor(Math.min(options.maxTokens - observed, controls.maxOutputTokens ?? Infinity))) }),
      }),
    })
    let response = await send().catch(async (error: unknown) => { await sleep(RETRY_DELAY_MS, options.signal); return send().catch(() => { throw error }) })
    if (!response.ok && response.status >= 500) {
      await response.body?.cancel()
      await sleep(RETRY_DELAY_MS, options.signal)
      response = await send()
    }
    // A model that cannot reason rejects `reasoning_effort` (Ollama: 400
    // "does not support thinking"). Drop the field for the rest of the
    // session and resend once — the connection's declaration was too broad
    // for this particular model, which is not a reason to fail the step.
    // Likewise an endpoint that does not know `chat_template_kwargs` (a non-Qwen
    // template, an older server): drop the switch for the session and resend.
    if (response.status === 400 && this.thinkingOff) {
      const text = await response.text().catch(() => '')
      if (/chat_template_kwargs|enable_thinking|unknown field|unrecognized|extra_forbidden|not permitted/i.test(text)) {
        this.thinkingOff = false
        options.onEvent?.({ kind: 'text', text: `The endpoint rejected the thinking switch (chat_template_kwargs) for ${options.model}; continuing with the server default.` })
        response = await send()
      } else {
        response = new Response(text, { status: 400, headers: response.headers })
      }
    }
    if (response.status === 400 && this.effortEnabled && effort) {
      const text = await response.text().catch(() => '')
      if (/does not support thinking|reasoning_effort|unknown field.*reasoning/i.test(text)) {
        this.effortEnabled = false
        options.onEvent?.({ kind: 'text', text: `The endpoint rejected reasoning_effort for ${options.model}; continuing without it.` })
        response = await send()
      } else {
        response = new Response(text, { status: 400, headers: response.headers })
      }
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new AgentExecutionError(`OpenAI-compatible provider returned HTTP ${response.status}`, 'provider_http_error', this.budgetUsage)
    }
    const data = record(await readCompletionResponse(response)), reported = record(data?.usage)
    const cached = number(record(reported?.prompt_tokens_details)?.cached_tokens)
    const inputTokens = number(reported?.prompt_tokens)
    const cache = record(reported?.prompt_tokens_details)?.cached_tokens === undefined ? {} : {
      cacheReadInputTokens: cached !== null && inputTokens !== null && cached <= inputTokens ? cached : null,
      uncachedInputTokens: cached !== null && inputTokens !== null && cached <= inputTokens ? inputTokens - cached : null,
      cacheWriteInputTokens: null,
    }
    const current: AgentUsage = { inputTokens, outputTokens: number(reported?.completion_tokens), costUsd: number(reported?.cost_usd ?? data?.cost_usd), ...cache }
    this.usage = { inputTokens: add(this.usage.inputTokens, current.inputTokens), outputTokens: add(this.usage.outputTokens, current.outputTokens), costUsd: add(this.usage.costUsd, current.costUsd), ...(this.responses === 0 ? cache : sumCacheUsage([this.usage, current])) }
    this.responses++
    options.onEvent?.({ kind: 'usage', usage: { ...this.usage } })
    if (options.maxTokens !== undefined && (this.usage.inputTokens === null || this.usage.outputTokens === null)) throw new AgentExecutionError('Provider omitted usage required by the token budget', 'usage_unavailable', this.usage)
    if (options.maxTokens !== undefined && (this.usage.inputTokens ?? 0) + (this.usage.outputTokens ?? 0) > options.maxTokens) throw new AgentExecutionError('Agent token budget exceeded', 'token_budget', this.usage)
    if (options.maxCostUsd !== undefined && this.usage.costUsd !== null && this.usage.costUsd > options.maxCostUsd) throw new AgentExecutionError('Agent cost budget exceeded', 'cost_budget', this.usage)
    if (!data || data.error) throw new AgentExecutionError('Provider returned an error or invalid response', 'provider_response_error', this.usage)
    const choice = Array.isArray(data.choices) ? record(data.choices[0]) : undefined
    const message = record(choice?.message)
    if (!message || message.role !== 'assistant') throw new AgentExecutionError('Provider response has no assistant message', 'invalid_response', this.usage)
    if (choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter') throw new AgentExecutionError('Provider did not complete the requested result', 'incomplete_response', this.usage)
    return { message, finishReason: choice?.finish_reason }
  }
  /**
   * A tool-less call whose reply must be one JSON object. Uses `response_format`
   * json_schema when the endpoint accepts it; an endpoint that rejects the field
   * (HTTP 4xx on the first structured call) falls back to instructions only.
   */
  async completeStructured(messages: ChatMessage[], name: string, schema: Record<string, unknown>, controls: { temperature?: number; maxOutputTokens?: number; reasoningEffort?: string } = {}): Promise<ChatCompletion> {
    if (this.structuredOutput !== 'unsupported') {
      try {
        const result = await this.complete({ messages, response_format: { type: 'json_schema', json_schema: { name, schema, strict: false } } }, controls)
        this.structuredOutput = 'supported'
        return result
      } catch (error) {
        if (this.structuredOutput === 'supported' || !(error instanceof AgentExecutionError) || error.code !== 'provider_http_error') throw error
        this.structuredOutput = 'unsupported'
      }
    }
    return this.complete({ messages: [...messages, { role: 'user', content: 'Reply with exactly one JSON object matching this JSON Schema and nothing else:\n' + JSON.stringify(schema) }] }, controls)
  }
}
/**
 * Reads a chat completion whether the server streamed it (SSE — the request
 * asks for it, so a model that reasons for minutes before its first token
 * never trips the client's headers timeout) or answered with one JSON body
 * (servers and fixtures that ignore `stream`). The result has the classic
 * non-streaming shape: `{ choices: [{ message, finish_reason }], usage }`.
 */
export async function readCompletionResponse(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? ''
  if (!/text\/event-stream/i.test(type)) return readBoundedResponse(response)
  if (!response.body) throw new Error('Missing response body')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', length = 0, content = '', finishReason: unknown = null, usage: unknown, error: unknown
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>()
  const consume = (line: string): void => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let chunk: Record<string, unknown> | undefined
    try { chunk = record(JSON.parse(payload)) } catch { return }
    if (!chunk) return
    if (chunk.error) error = chunk.error
    if (chunk.usage) usage = chunk.usage
    const choice = Array.isArray(chunk.choices) ? record(chunk.choices[0]) : undefined
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = record(choice.delta)
    if (typeof delta?.content === 'string') content += delta.content
    for (const raw of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
      const item = record(raw)
      if (!item) continue
      const index = typeof item.index === 'number' ? item.index : calls.size
      const fn = record(item.function)
      const current = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (typeof item.id === 'string' && item.id) current.id = item.id
      if (typeof fn?.name === 'string' && fn.name) current.function.name += fn.name
      if (typeof fn?.arguments === 'string') current.function.arguments += fn.arguments
      calls.set(index, current)
    }
  }
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Provider response exceeds 8 MiB') }
      buffer += decoder.decode(part.value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, index).replace(/\r$/, '')); buffer = buffer.slice(index + 1) }
    }
    if (buffer.trim()) consume(buffer.trim())
  } finally { reader.releaseLock() }
  if (error) return { error }
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call], n) => ({ ...call, id: call.id || `call_${n}` }))
  const message: Record<string, unknown> = { role: 'assistant', content: content || (toolCalls.length ? null : '') }
  if (toolCalls.length) message.tool_calls = toolCalls
  return { choices: [{ message, finish_reason: finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop') }], ...(usage ? { usage } : {}) }
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
