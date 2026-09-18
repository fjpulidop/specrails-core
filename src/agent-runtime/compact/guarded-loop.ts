import { toolEvent } from '../tool-event.js'
import { OPENSPEC_TOOL_ACTIONS } from '../openspec.js'
import { AgentExecutionError, type AgentEvent } from '../executor-types.js'
import { record, type ChatClient, type ChatMessage } from './chat-client.js'

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768
/** Consecutive identical calls answered with an error instead of executing. */
export const REPEAT_WARN_AT = 3
/** Total identical calls that abort the step. */
export const REPEAT_ABORT_AT = 5
const COMPACTION_RATIO = 0.7
const PROTECTED_TAIL = 4
const PLACEHOLDER_QUERIES = new Set(['.', '*', '**', '.*', '..', '?', 'query', '<query>'])
const NUDGE = 'Your reply was empty. Reply with the final result now, as requested; do not call tools.'

export interface ToolLoopOptions {
  client: ChatClient
  /** Mutated in place: assistant, tool and nudge messages are appended. */
  messages: ChatMessage[]
  tools: unknown[]
  /** Executes one validated tool call; throwing becomes a tool error result. */
  execute: (name: string, args: Record<string, unknown>) => Promise<string> | string
  /** Provider round trips. */
  maxTurns: number
  /** Tool calls before the model is asked for its final result without tools. */
  maxToolCalls?: number
  contextWindowTokens: number
  /** Output budget of one tool turn (`max_tokens`); the cut-off retry gets twice this. Default TOOL_TURN_MAX_OUTPUT. */
  maxOutputTokens?: number
  onEvent?: (event: AgentEvent) => void
  signal: AbortSignal
  /** Called when the loop ends without a tool call to obtain the final text. */
  onToolCall?: () => void
  /**
   * Write-only extension: when the tool budget runs out and NONE of these
   * tools was ever called, grant `extraCalls` more calls restricted to them
   * (observed: a developer group spent all 25 calls reading and ended with
   * zero bytes written — the check "passed" on an unchanged tree).
   */
  writeExtension?: { tools: readonly string[]; extraCalls: number }
}
/** Default output budget of one tool turn. A tool turn should emit a tool call or a short reply, so this is a runaway guard, not a ceiling for real work; a connection whose model thinks privately (that counts against `max_tokens`) raises it with `maxOutputTokens`. */
export const TOOL_TURN_MAX_OUTPUT = 8192
/** Headroom kept between the transcript and the context window when bounding an output budget. */
const OUTPUT_HEADROOM_TOKENS = 512
/**
 * `max_tokens` counts INSIDE the context window (prompt + output ≤ window), so
 * a budget wider than what remains makes llama.cpp refuse the request
 * ("exceeds the available context size") instead of helping. Bound every
 * request to the room actually left; never below a minimal useful reply.
 */
export function boundedOutputBudget(requested: number, contextWindowTokens: number, messages: readonly ChatMessage[]): number {
  const remaining = contextWindowTokens - estimateTokens(messages as ChatMessage[]) - OUTPUT_HEADROOM_TOKENS
  return Math.max(256, Math.min(requested, remaining))
}
const EFFORT_STEP_DOWN: Record<string, string | undefined> = { high: 'medium', medium: 'low' }
/** Tools whose result is a pure function of the workspace: safe to answer a repeated call with a pointer to the earlier identical result. */
const READ_TOOLS = new Set(['read_file', 'read_lines', 'search_text', 'get_diff', 'list_files'])
/** Consecutive rewrites of one path (no other tool call between them) before the loop refuses the next one. */
export const REWRITE_WARN_AT = 3
/** Whole-file rewrites only: iterating a file with apply_patch between reads is the normal edit flow. */
const WRITE_TOOLS = new Set(['write_file'])
/** The rewrite streak keys on the file NAME: a model alternating `tests/x.test.js` with an invented `repo/tests/x.test.js` (observed, 7 rewrites) is still rewriting one file. */
function pathOf(args: string): string | undefined {
  try { const value = (JSON.parse(args) as { path?: unknown }).path; return typeof value === 'string' ? value.replace(/\\/g, '/').split('/').pop() : undefined } catch { return undefined }
}
/** Below this size a re-read is cheaper than the pointer text. */
const READ_CACHE_MIN_CHARS = 600
function summarizeArgs(args: string): string {
  try { const parsed = JSON.parse(args) as Record<string, unknown>; return Object.entries(parsed).map(([k, v]) => `${k}=${String(v)}`).join(' ').slice(0, 120) } catch { return args.slice(0, 120) }
}
export interface ToolLoopResult { text: string; toolCalls: number }

/** Estimated tokens for the transcript: chars/4, which is what small local servers count against. */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((total, message) => total + JSON.stringify(message).length, 0) / 4)
}
/** One correct example the model can copy when its arguments were rejected. */
export function toolExample(name: string): string {
  switch (name) {
    case 'search_text': return '{"path":".","query":"functionName"}'
    case 'read_lines': return '{"path":"src/index.ts","startLine":1,"endLine":120}'
    case 'write_file': return '{"path":"src/feature.ts","content":"export const feature = 1\\n"}'
    case 'apply_patch': return '{"path":"src/feature.ts","oldText":"const a = 1","newText":"const a = 2"}'
    case 'openspec_workflow': return '{"action":"instructions","artifact":"proposal"}'
    case 'read_verification_evidence': return '{"id":"<evidence id from the verification result>","section":"stdout"}'
    default: return '{"path":"src/index.ts"}'
  }
}
/** Schema-level argument repair: returns the error the model receives instead of executing. */
export function validateToolArguments(name: string, raw: string, available: Set<string>): { args: Record<string, unknown> } | { error: string } {
  const example = `Example of a correct ${name} call: ${toolExample(name)}`
  if (!available.has(name)) return { error: `Tool '${name}' is unavailable for this step. Available tools: ${[...available].join(', ')}.` }
  let parsed: unknown
  try { parsed = raw.trim() === '' ? {} : JSON.parse(raw) } catch { return { error: `Tool arguments must be a JSON object. ${example}` } }
  const args = record(parsed)
  if (!args) return { error: `Tool arguments must be a JSON object. ${example}` }
  if (name === 'openspec_workflow') {
    if (typeof args.action !== 'string' || !(OPENSPEC_TOOL_ACTIONS as readonly string[]).includes(args.action)) return { error: `openspec_workflow.action must be one of ${OPENSPEC_TOOL_ACTIONS.join(', ')}; file paths go in "path", artifact ids in "artifact". ${example}` }
    return { args }
  }
  if (name === 'read_verification_evidence') {
    if (typeof args.id !== 'string' || !args.id.trim()) return { error: `read_verification_evidence.id must be the evidence id returned by the verification result. ${example}` }
    return { args }
  }
  // Every remaining tool is a workspace file tool keyed by a relative path.
  if (typeof args.path !== 'string' || !args.path.trim()) return { error: `"path" must be a non-empty relative path string. ${example}` }
  if (name === 'search_text') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query || PLACEHOLDER_QUERIES.has(query) || query.length > 1000 || /^[\s.*?]+$/.test(query)) return { error: `search_text.query must be a literal, non-empty piece of text you expect to find (an identifier, a string, a heading); "${String(args.query ?? '')}" is a placeholder. Use list_files to browse instead. ${example}` }
  }
  if (name === 'write_file' && typeof args.content !== 'string') return { error: `write_file.content must be the complete file text as a string. ${example}` }
  if (name === 'apply_patch' && (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string')) return { error: `apply_patch needs a non-empty oldText copied exactly from the file and a newText string. ${example}` }
  return { args }
}
/** Replaces the oldest tool results with one-line summaries until the transcript fits the budget. */
export function compactMessages(messages: ChatMessage[], contextWindowTokens: number, calls: Map<string, { name: string; args: string }>): number {
  let compacted = 0
  for (let index = 2; index < messages.length - PROTECTED_TAIL && estimateTokens(messages) > COMPACTION_RATIO * contextWindowTokens; index++) {
    const message = messages[index]!
    // Executed write/patch calls carry whole files in their arguments; the file
    // is on disk, so the path alone is enough for the model's memory.
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.compacted !== true) {
      let changed = false
      const toolCalls = message.tool_calls.map(call => {
        if ((call.function.name !== 'write_file' && call.function.name !== 'apply_patch') || call.function.arguments.length < 400) return call
        let target = ''
        try { target = String((JSON.parse(call.function.arguments) as { path?: unknown }).path ?? '') } catch { /* keep as is */ }
        if (!target) return call
        changed = true
        return { ...call, function: { ...call.function, arguments: JSON.stringify({ path: target, content: `[compacted: ${call.function.name} of ${call.function.arguments.length} chars already applied to ${target}]` }) } }
      })
      if (changed) { messages[index] = { ...message, tool_calls: toolCalls, compacted: true }; compacted++ }
      continue
    }
    if (message.role !== 'tool' || message.compacted === true || typeof message.content !== 'string') continue
    const call = calls.get(String(message.tool_call_id))
    const args = (call?.args ?? '').replace(/\s+/g, ' ')
    messages[index] = { ...message, compacted: true, content: `[compacted: ${call?.name ?? 'tool'} ${args.length > 80 ? args.slice(0, 79) + '…' : args} → ${message.content.replace(/\s+/g, ' ').slice(0, 120)}]` }
    compacted++
  }
  return compacted
}
function stripInternal(message: ChatMessage): ChatMessage {
  const { compacted: _compacted, ...rest } = message
  return rest
}

/**
 * The agentic loop shared by the free and compact modes for OpenAI-compatible
 * endpoints: repetition guard, argument repair with one correct example, one nudge
 * for an empty final reply, `content: ''` on assistant tool-call messages and
 * context compaction against the provider's window.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const outputBudget = options.maxOutputTokens ?? TOOL_TURN_MAX_OUTPUT
  let toolControls: { temperature?: number; maxOutputTokens?: number; reasoningEffort?: string } = { maxOutputTokens: outputBudget }
  let toolRetried = false
  const { client, messages, signal } = options
  const available = new Set(options.tools.map(tool => String(record(record(tool)?.function)?.name ?? '')))
  const calls = new Map<string, { name: string; args: string }>()
  const totals = new Map<string, number>()
  let previous = '', consecutive = 0, toolCalls = 0, nudged = false, budgetNotice = false, cachedReads = 0, extended = false, wroteSomething = false, rewriteStreak = 0
  let lastWrittenPath: string | undefined
  const reads = new Map<string, { index: number; content: string }>()
  // The write-only extension adds its calls to the turn budget too, else a
  // maxTurns sized for the original budget ends the step before the extra calls.
  for (let turn = 0; turn < options.maxTurns + (extended ? options.writeExtension!.extraCalls : 0); turn++) {
    signal.throwIfAborted()
    let exhausted = options.maxToolCalls !== undefined && toolCalls >= options.maxToolCalls
    // Read-only budget spent: a step that must change files gets a short
    // write-only extension instead of being asked to "reply now".
    let writeOnly = false
    if (exhausted && options.writeExtension && !wroteSomething && !extended) {
      extended = true; exhausted = false
      const ext = options.writeExtension
      options.onEvent?.({ kind: 'text', text: `Tool budget spent on reads alone; granting ${ext.extraCalls} extra calls restricted to ${ext.tools.join('/')}.` })
      messages.push({ role: 'user', content: `You have used the whole tool budget reading and have not written anything yet. You know enough: make the change now. You have ${ext.extraCalls} more tool calls and ONLY ${ext.tools.join(' / ')} are available — no more reading. Then reply with the final result.` })
    }
    if (extended && options.writeExtension) {
      writeOnly = toolCalls < (options.maxToolCalls ?? 0) + options.writeExtension.extraCalls
      exhausted = !writeOnly
    }
    if (exhausted && !budgetNotice) {
      budgetNotice = true
      messages.push({ role: 'user', content: 'The tool budget for this step is spent. Reply with the final result now using what you already learned; do not call tools.' })
    }
    const offered = writeOnly ? options.tools.filter(tool => options.writeExtension!.tools.includes(String(record(record(tool)?.function)?.name ?? ''))) : options.tools
    // A tool turn cut off by the output budget (`finish_reason: length`) is the
    // model's hidden reasoning eating max_tokens. Retry the same turn once with
    // a wider budget and, when the endpoint supports it, one notch less effort.
    const body = { messages: messages.map(stripInternal), ...(exhausted ? {} : { tools: offered, tool_choice: 'auto' }) }
    const bounded = (requested: number): number => boundedOutputBudget(requested, options.contextWindowTokens, body.messages)
    let completion: Awaited<ReturnType<typeof client.complete>>
    try { completion = await client.complete(body, { ...toolControls, maxOutputTokens: bounded(toolControls.maxOutputTokens ?? outputBudget) }) }
    catch (error) {
      if (!(error instanceof AgentExecutionError) || error.code !== 'incomplete_response' || toolRetried) throw error
      toolRetried = true
      const current = toolControls.reasoningEffort ?? client.defaultEffort
      const lower = current ? EFFORT_STEP_DOWN[current] : undefined
      const wide = bounded(outputBudget * 2)
      // Nothing to change (no effort to lower, no room left in the window): a retry would only repeat the cut-off.
      if (!lower && wide <= bounded(outputBudget)) throw error
      options.onEvent?.({ kind: 'text', text: `Tool turn ran out of output budget (${bounded(outputBudget)} tokens)${lower ? `; retrying at "${lower}" effort` : ''}${wide > bounded(outputBudget) ? ` with ${wide} tokens` : ' — the context window leaves no more room'}.` })
      toolControls = { ...toolControls, maxOutputTokens: wide, ...(lower ? { reasoningEffort: lower } : {}) }
      completion = await client.complete(body, toolControls)
    }
    const { message } = completion
    const raw = message.tool_calls
    if (raw !== undefined && !Array.isArray(raw)) throw new AgentExecutionError('Invalid tool calls in provider response', 'invalid_tool_call', client.usage)
    if (Array.isArray(raw) && raw.length > 0) {
      if (raw.length > 32) throw new AgentExecutionError('Provider requested too many tools in one turn', 'invalid_tool_call', client.usage)
      const ids = new Set<string>()
      const parsed = raw.map(item => {
        const call = record(item), fn = record(call?.function)
        if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) || typeof fn?.name !== 'string' || typeof fn.arguments !== 'string') throw new AgentExecutionError('Malformed provider tool call', 'invalid_tool_call', client.usage)
        ids.add(call.id)
        return { id: call.id, name: fn.name, arguments: fn.arguments, call }
      })
      messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : '', tool_calls: parsed.map(item => item.call) })
      for (const item of parsed) {
        signal.throwIfAborted()
        toolCalls++
        options.onToolCall?.()
        calls.set(item.id, { name: item.name, args: item.arguments })
        options.onEvent?.(toolEvent(item.name, item.arguments))
        const key = item.name + ' ' + item.arguments.replace(/\s+/g, '')
        consecutive = key === previous ? consecutive + 1 : 1
        previous = key
        const total = (totals.get(key) ?? 0) + 1
        totals.set(key, total)
        // Rewrite loop: the same path written turn after turn with DIFFERENT
        // content slips past the identical-arguments guard (observed: one
        // generator script rewritten ten times in a row, 23 s apart, by a
        // developer that cannot run it). Refuse the third consecutive rewrite.
        const writtenPath = WRITE_TOOLS.has(item.name) ? pathOf(item.arguments) : undefined
        // Reads of that same file between rewrites keep the streak; any other action ends it.
        const sameFileRead = (item.name === 'read_lines' || item.name === 'read_file') && lastWrittenPath !== undefined && pathOf(item.arguments) === lastWrittenPath
        if (writtenPath) { rewriteStreak = writtenPath === lastWrittenPath ? rewriteStreak + 1 : 1; lastWrittenPath = writtenPath }
        else if (!sameFileRead) { rewriteStreak = 0; lastWrittenPath = undefined }
        let result: string
        // A repeated READ now costs a pointer, not the bytes, and the pointer tells
        // the model to stop: give reads more rope before calling it a loop
        // (observed: a group closed as `tool_loop` on the fifth read of one test
        // file while the model was legitimately editing between reads).
        if (total >= (READ_TOOLS.has(item.name) ? REPEAT_ABORT_AT + 3 : REPEAT_ABORT_AT)) throw new AgentExecutionError(`Tool call ${item.name} repeated ${total} times with identical arguments`, 'tool_loop', client.usage)
        if (rewriteStreak >= REWRITE_WARN_AT) { result = JSON.stringify({ error: `"${writtenPath}" has been rewritten ${rewriteStreak} times in a row. Stop iterating on this file: you cannot execute scripts or check output here, so polishing it further changes nothing. Move on to the next file the task names, or reply with the final result.` }); rewriteStreak = 0 }
        else         if (consecutive >= REPEAT_WARN_AT) result = JSON.stringify({ error: `identical call repeated (${item.name} with the same arguments, ${consecutive} times in a row); the result has not changed. Move on: use a different tool or arguments, or reply with the final result.` })
        else {
          const checked = validateToolArguments(item.name, item.arguments, available)
          if ('error' in checked) result = JSON.stringify({ error: checked.error })
          else {
            try { result = await options.execute(item.name, checked.args) }
            catch (error) { result = JSON.stringify({ error: error instanceof Error ? error.message : 'Tool execution failed' }) }
            if (options.writeExtension?.tools.includes(item.name) && !/^\s*\{\s*"error"/.test(result)) wroteSomething = true
            // Read cache: a small model re-reads the same unchanged file several
            // times per group (observed: a 14 KB test file read four times = 16k
            // tokens of transcript, minutes of prefill on a GPU spilling to RAM).
            // The earlier result is still in the transcript, so the re-read gets a
            // pointer instead of the bytes. A changed file, or an earlier read that
            // compaction already folded, returns the full content again.
            if (READ_TOOLS.has(item.name)) {
              const earlier = reads.get(key)
              const still = earlier !== undefined ? messages[earlier.index] : undefined
              if (earlier && still && still.role === 'tool' && still.compacted !== true && still.content === result && result.length >= READ_CACHE_MIN_CHARS) {
                cachedReads++
                result = JSON.stringify({ unchanged: true, note: `Identical to your earlier ${item.name} ${summarizeArgs(item.arguments)} — that content is still above in this conversation and the file has not changed since. Do not read it again; use read_lines with a startLine/endLine range if you need one part, or continue with the edit.` })
              } else reads.set(key, { index: messages.length, content: result })
            }
          }
        }
        messages.push({ role: 'tool', tool_call_id: item.id, content: result })
        options.onEvent?.({ kind: 'tool-end', tool: item.name })
      }
      compactMessages(messages, options.contextWindowTokens, calls)
      continue
    }
    if (typeof message.content === 'string' && message.content.trim()) {
      if (cachedReads) options.onEvent?.({ kind: 'text', text: `Read cache: ${cachedReads} repeated read${cachedReads === 1 ? '' : 's'} of unchanged content answered with a pointer instead of the bytes.` })
      return { text: message.content, toolCalls }
    }
    if (nudged) throw new AgentExecutionError('Provider returned an empty final result', 'invalid_response', client.usage)
    nudged = true
    messages.push({ role: 'assistant', content: '' }, { role: 'user', content: NUDGE })
  }
  throw new AgentExecutionError(`Agent exhausted ${options.maxTurns} turns without a final result`, 'max_turns', client.usage)
}
