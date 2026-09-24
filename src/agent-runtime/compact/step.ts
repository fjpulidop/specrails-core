import { guardrailEnabled, type GuardrailId, type GuardrailSettings } from '../guardrails.js'
import { toolEvent } from '../tool-event.js'
import { AgentExecutionError, type AgentEvent, type AgentRequest } from '../executor-types.js'
import type { OpenSpecTools } from '../openspec.js'
import type { WorkspaceTools } from '../workspace-tools.js'
import { parseAgentObject } from '../graph/artifacts.js'
import { record, type ChatClient, type ChatMessage } from './chat-client.js'
import { runToolLoop, type ToolLoopResult } from './guarded-loop.js'
import type { PromptInputs } from './prompt-inputs.js'

/** Everything one compact role pipeline needs; built once per `execute`. */
export interface CompactEnv {
  client: ChatClient
  request: AgentRequest
  inputs: PromptInputs
  toolset: WorkspaceTools
  openspec: OpenSpecTools
  contextWindowTokens: number
  /** Connection-declared output budget per tool turn (see ToolLoopOptions.maxOutputTokens). */
  maxOutputTokens?: number
  /** Re-arms the role's wall-clock budget: the compact developer calls it at every task group so the timeout is per group, not per role. */
  resetDeadline?: () => void
  signal: AbortSignal
  onEvent?: (event: AgentEvent) => void
  /** Project switches; a guardrail is on unless set to false. */
  guardrails?: GuardrailSettings
  /** `fixer`: correction round on the fixer engine. */
  stance?: 'fixer'
}
/** Shorthand for the guards: `on(env, 'empty-write')`. */
export function on(env: Pick<CompactEnv, 'guardrails'>, id: GuardrailId): boolean { return guardrailEnabled(env.guardrails, id) }
const COMPACT_STANCE = 'You are one step of a Specrails pipeline driven by a host program. Keep replies short and concrete. Never invent files, paths or commands: everything you state must come from the inputs or from tool results. When asked for JSON, reply with exactly one JSON object and nothing else.'

/** One host-driven `openspec_workflow` call, visible in the host log like a model tool call. */
export async function openspecCall(env: CompactEnv, input: Parameters<OpenSpecTools['execute']>[0]): Promise<unknown> {
  env.onEvent?.(toolEvent('openspec_workflow', input))
  try { return await env.openspec.execute(input) }
  finally { env.onEvent?.({ kind: 'tool-end', tool: 'openspec_workflow' }) }
}
/** A tool-less structured call with one tolerant retry; the object is validated by the caller. */
/**
 * Generation controls for the planning steps (proposal, design, specs, tasks).
 * Generic OpenAI request fields, not model-specific: a low temperature keeps
 * structured JSON literal instead of "creative", a wide output budget stops the
 * plan from being truncated, and — only when the endpoint declared support —
 * a high reasoning effort makes models that think privately (and answer
 * tersely) spend their thinking on the plan.
 */
export const PLANNING_CONTROLS = { temperature: 0.2, maxOutputTokens: 16384, reasoningEffort: 'high' } as const
/** When a planning call runs out of output budget, the hidden reasoning ate
 *  it (models that think privately count that against max_tokens). Retry
 *  once with less thinking rather than fail the step. */
const EFFORT_FALLBACK: Record<string, string | undefined> = { high: 'medium', medium: 'low' }
export async function structuredStep(env: CompactEnv, name: string, system: string, user: string, schema: Record<string, unknown>, validate: (value: Record<string, unknown>) => string | undefined = () => undefined, controls: { temperature?: number; maxOutputTokens?: number; reasoningEffort?: string } = PLANNING_CONTROLS): Promise<Record<string, unknown>> {
  const messages: ChatMessage[] = [{ role: 'system', content: COMPACT_STANCE + '\n' + system }, { role: 'user', content: user }]
  // One structured artifact (proposal, design, a spec, tasks) is one unit of work: it gets the full budget.
  env.resetDeadline?.()
  let problem = ''
  // A connection that declares a wider output budget than the planning default gets it for its structured (long-form) steps too.
  let effective = { ...controls, ...(env.maxOutputTokens !== undefined && env.maxOutputTokens > (controls.maxOutputTokens ?? 0) ? { maxOutputTokens: env.maxOutputTokens } : {}) }
  const started = Date.now()
  for (let attempt = 0; attempt < 2; attempt++) {
    env.signal.throwIfAborted()
    // A structured step is one long generation with no tool calls: without
    // this line the run log goes silent for minutes (observed: 5 min after
    // the inventory with nothing to show). Name the step and, on the retry,
    // why the first answer was rejected.
    env.onEvent?.({ kind: 'text', text: attempt === 0 ? `Compact ${env.request.role}: writing ${name}…` : `Compact ${env.request.role}: ${name} rejected (${problem.slice(0, 160)}); retrying.` })
    let completion: Awaited<ReturnType<typeof env.client.completeStructured>>
    try {
      completion = await env.client.completeStructured(attempt === 0 ? messages : [...messages, { role: 'assistant', content: '' }, { role: 'user', content: `Your previous reply could not be used: ${problem}. Reply again with exactly one JSON object matching the schema.` }], name, schema, effective)
    } catch (error) {
      const fallback = error instanceof AgentExecutionError && error.code === 'incomplete_response' && effective.reasoningEffort ? EFFORT_FALLBACK[effective.reasoningEffort] : undefined
      if (!fallback || attempt > 0) throw error
      env.onEvent?.({ kind: 'text', text: `Compact ${name} step ran out of output budget while reasoning at "${effective.reasoningEffort}"; retrying at "${fallback}".` })
      effective = { ...effective, reasoningEffort: fallback }
      problem = 'the reply was cut off before the JSON object was complete'
      continue
    }
    const { message } = completion
    const text = typeof message.content === 'string' ? message.content : ''
    let parsed: Record<string, unknown> | undefined
    try { parsed = text.trim() ? parseAgentObject(text) : undefined } catch { parsed = undefined }
    problem = parsed ? validate(parsed) ?? '' : 'the reply was not one JSON object'
    if (parsed && !problem) { env.onEvent?.({ kind: 'text', text: `Compact ${env.request.role}: ${name} written in ${Math.max(1, Math.round((Date.now() - started) / 1000))}s.` }); return parsed }
  }
  throw new AgentExecutionError(`Compact ${name} step did not produce a valid result: ${problem}`, 'invalid_response', env.client.usage)
}
/** A bounded mini-loop with a subset of the workspace tools, then its final text. */
export async function toolStep(env: CompactEnv, options: { system: string; user: string; tools: string[]; maxToolCalls: number; maxTurns?: number; extraTools?: unknown[]; writeExtension?: { tools: readonly string[]; extraCalls: number }; execute?: (name: string, args: Record<string, unknown>) => Promise<string> | string }): Promise<ToolLoopResult & { messages: ChatMessage[] }> {
  const definitions = [...env.toolset.definitions().filter(tool => options.tools.includes(tool.function.name)), ...options.extraTools ?? []]
  const examples = definitions.map(tool => `- ${record(record(tool)?.function)?.name}: ${exampleFor(String(record(record(tool)?.function)?.name))}`).join('\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: COMPACT_STANCE + '\n' + options.system + `\nTools available in this step (one example call each):\n${examples}\nCall at most ${options.maxToolCalls} tools, one at a time; never repeat a call whose result you already have.` },
    { role: 'user', content: options.user },
  ]
  // One bounded tool loop (an inventory, a task group, a fix round, a review) is one unit of work: full budget.
  env.resetDeadline?.()
  const result = await runToolLoop({
    client: env.client, messages, tools: definitions, maxTurns: options.maxTurns ?? options.maxToolCalls + 6, maxToolCalls: options.maxToolCalls,
    contextWindowTokens: env.contextWindowTokens, ...(env.maxOutputTokens === undefined ? {} : { maxOutputTokens: env.maxOutputTokens }), ...(options.writeExtension ? { writeExtension: options.writeExtension } : {}), onEvent: env.onEvent, signal: env.signal,
    execute: (name, args) => options.execute ? options.execute(name, args) : env.toolset.execute(name, args),
  })
  return { ...result, messages }
}
function exampleFor(name: string): string {
  switch (name) {
    case 'list_files': return '{"path":"."}'
    case 'read_file': return '{"path":"src/index.ts"}'
    case 'read_lines': return '{"path":"src/index.ts","startLine":1,"endLine":120}'
    case 'search_text': return '{"path":"src","query":"export function handle"}'
    case 'get_diff': return '{"path":"src/index.ts"}'
    case 'write_file': return '{"path":"src/feature.ts","content":"export const feature = 1\\n"}'
    case 'apply_patch': return '{"path":"src/feature.ts","oldText":"const a = 1","newText":"const a = 2"}'
    case 'read_verification_evidence': return '{"id":"<evidence id>","section":"stdout"}'
    default: return '{}'
  }
}
/** Parses the loop's final text as JSON, or asks the same transcript once for the JSON object. */
export async function finalJson(env: CompactEnv, name: string, messages: ChatMessage[], text: string, schema: Record<string, unknown>, validate: (value: Record<string, unknown>) => string | undefined = () => undefined): Promise<Record<string, unknown>> {
  try {
    const parsed = parseAgentObject(text)
    const problem = validate(parsed)
    if (!problem) return parsed
  } catch { /* fall through to one structured retry */ }
  const trimmed = messages.map(message => message.role === 'tool' && typeof message.content === 'string' && message.content.length > 400 ? { ...message, content: message.content.slice(0, 400) + '…' } : message)
  const { message } = await env.client.completeStructured([...trimmed, { role: 'assistant', content: text || '' }, { role: 'user', content: 'Now reply with exactly one JSON object for this step and nothing else.' }], name, schema)
  const parsed = record(safeParse(typeof message.content === 'string' ? message.content : ''))
  const problem = parsed ? validate(parsed) : 'the reply was not one JSON object'
  if (!parsed || problem) throw new AgentExecutionError(`Compact ${name} step did not produce a valid result: ${problem}`, 'invalid_response', env.client.usage)
  return parsed
}
function safeParse(text: string): unknown { try { return parseAgentObject(text) } catch { return undefined } }
export function strings(value: unknown, limit: number, each = 1000): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim().slice(0, each)).slice(0, limit) : []
}
export function text(value: unknown, fallback = ''): string { return typeof value === 'string' && value.trim() ? value.trim() : fallback }
