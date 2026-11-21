import { describe, expect, it } from 'vitest'

import type { DriverEvent } from '../../ports.js'
import { ClaudeTranslator } from './translator.js'

type Frame = Record<string, unknown>

// Frame shapes as Claude Code `--output-format stream-json` emits them (2.1.x).
const init = (model = 'claude-sonnet-4-5-20250929'): Frame => ({ type: 'system', subtype: 'init', session_id: 'sess-1', model, tools: [] })
const usage = (input: number, cacheWrite: number, cacheRead: number, output = 50) => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheWrite },
  output_tokens: output,
  service_tier: 'standard',
})
const assistant = (u: Frame, extra: Frame = {}, model = 'claude-sonnet-4-5-20250929'): Frame => ({
  type: 'assistant',
  parent_tool_use_id: null,
  session_id: 'sess-1',
  message: { model, id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: null, usage: u },
  ...extra,
})
const modelUsage = (entries: Record<string, number | undefined>) => Object.fromEntries(Object.entries(entries).map(([model, contextWindow]) => [model, {
  inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01,
  ...(contextWindow === undefined ? {} : { contextWindow }), maxOutputTokens: 32000,
}]))
const result = (extra: Frame = {}): Frame => ({
  type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1', total_cost_usd: 0.02,
  usage: { input_tokens: 30, output_tokens: 120, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 9_000 },
  ...extra,
})

function run(frames: Frame[]): Extract<DriverEvent, { kind: 'turn.completed' }> {
  const translator = new ClaudeTranslator()
  const events = frames.flatMap((frame) => translator.translate(frame))
  const done = events.find((event): event is Extract<DriverEvent, { kind: 'turn.completed' }> => event.kind === 'turn.completed')
  if (!done) throw new Error('no turn.completed')
  return done
}

describe('Claude translator context usage', () => {
  it('uses the newest main-agent request, counting cache once and never output', () => {
    const done = run([
      init(),
      assistant(usage(10, 8_334, 22_376, 400)),
      assistant(usage(4, 1_200, 30_710, 900)),
      result({ modelUsage: modelUsage({ 'claude-sonnet-4-5-20250929': 200_000 }) }),
    ])
    expect(done.context).toEqual({ usedTokens: 4 + 1_200 + 30_710, windowTokens: 200_000, model: 'claude-sonnet-4-5-20250929' })
    // Usage accounting is unchanged.
    expect(done.usage).toMatchObject({ inputTokens: 30, outputTokens: 120, cacheReadTokens: 40_000, cacheWriteTokens: 9_000 })
  })

  it('ignores sub-agent and sidechain frames and skips all-zero usage', () => {
    const translator = new ClaudeTranslator()
    const frames: Frame[] = [
      init(),
      assistant(usage(5, 2_000, 18_000)),
      // The Agent tool call that starts a sub-agent.
      { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-sonnet-4-5-20250929', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }], usage: usage(0, 0, 0, 0) } },
      { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'toolu_agent', description: 'explore', subagent_type: 'Explore' },
      assistant(usage(3, 90_000, 60_000), { parent_tool_use_id: 'toolu_agent' }, 'claude-haiku-4-5-20251001'),
      assistant(usage(7, 50_000, 50_000), { isSidechain: true }),
      // A partial stream frame of the main agent with no usage yet.
      assistant(usage(0, 0, 0, 0)),
      result({ modelUsage: modelUsage({ 'claude-haiku-4-5-20251001': 200_000, 'claude-sonnet-4-5-20250929': 200_000 }) }),
    ]
    const done = frames.flatMap((frame) => translator.translate(frame)).find((event) => event.kind === 'turn.completed') as Extract<DriverEvent, { kind: 'turn.completed' }>
    expect(done.context).toEqual({ usedTokens: 20_005, windowTokens: 200_000, model: 'claude-sonnet-4-5-20250929' })
  })

  it('reports compaction after the last measured request as unknown usage', () => {
    const done = run([
      init(),
      assistant(usage(10, 5_000, 150_000)),
      { type: 'system', subtype: 'compact_boundary', session_id: 'sess-1', compact_metadata: { trigger: 'auto', pre_tokens: 155_010 } },
      result({ modelUsage: modelUsage({ 'claude-sonnet-4-5-20250929': 200_000 }) }),
    ])
    expect(done.context).toEqual({ usedTokens: null, windowTokens: 200_000, model: 'claude-sonnet-4-5-20250929', compacted: true })
  })

  it('measures the first request after a compaction again', () => {
    const done = run([
      init(),
      assistant(usage(10, 5_000, 150_000)),
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 155_010 } },
      assistant(usage(2, 12_000, 3_000)),
      result({ modelUsage: modelUsage({ 'claude-sonnet-4-5-20250929': 200_000 }) }),
    ])
    expect(done.context).toEqual({ usedTokens: 15_002, windowTokens: 200_000, model: 'claude-sonnet-4-5-20250929' })
  })

  it('prefers the init model key for the window ([1m] variant)', () => {
    const done = run([
      init('claude-sonnet-4-5-20250929[1m]'),
      assistant(usage(10, 5_000, 300_000)),
      result({ modelUsage: modelUsage({ 'claude-haiku-4-5-20251001': 200_000, 'claude-sonnet-4-5-20250929[1m]': 1_000_000, 'claude-sonnet-4-5-20250929': 200_000 }) }),
    ])
    expect(done.context).toEqual({ usedTokens: 305_010, windowTokens: 1_000_000, model: 'claude-sonnet-4-5-20250929[1m]' })
  })

  it('falls back to the assistant message model, then the largest window', () => {
    const byMessage = run([
      init('sonnet'),
      assistant(usage(1, 1, 1)),
      result({ modelUsage: modelUsage({ 'claude-haiku-4-5-20251001': 500_000, 'claude-sonnet-4-5-20250929': 200_000 }) }),
    ])
    expect(byMessage.context).toMatchObject({ windowTokens: 200_000, model: 'claude-sonnet-4-5-20250929' })
    const largest = run([
      init('sonnet'),
      assistant(usage(1, 1, 1), {}, 'claude-opus-x'),
      result({ modelUsage: modelUsage({ 'claude-haiku-4-5-20251001': 200_000, 'claude-sonnet-4-5-20250929': 1_000_000 }) }),
    ])
    expect(largest.context).toMatchObject({ windowTokens: 1_000_000, model: 'claude-sonnet-4-5-20250929' })
  })

  it('without modelUsage, infers only a [1m] window and otherwise reports null', () => {
    const oneM = run([init('claude-opus-4-1[1m]'), assistant(usage(10, 0, 990)), result()])
    expect(oneM.context).toEqual({ usedTokens: 1_000, windowTokens: 1_000_000, model: 'claude-opus-4-1[1m]' })
    const plain = run([init(), assistant(usage(10, 0, 990)), result({ modelUsage: modelUsage({ 'claude-sonnet-4-5-20250929': undefined }) })])
    expect(plain.context).toEqual({ usedTokens: 1_000, windowTokens: null, model: 'claude-sonnet-4-5-20250929' })
  })

  it('omits the context when nothing was measured and starts each turn fresh', () => {
    const translator = new ClaudeTranslator()
    const completed = (frames: Frame[]) => frames.flatMap((frame) => translator.translate(frame)).find((event) => event.kind === 'turn.completed') as Extract<DriverEvent, { kind: 'turn.completed' }>
    expect(completed([init(), assistant(usage(10, 0, 990)), result()]).context).toMatchObject({ usedTokens: 1_000 })
    expect(completed([init(), result()]).context).toBeUndefined()
  })
})

describe('Claude usage limits', () => {
  it('translates rate_limit_event into a typed rate-limit event', () => {
    const translator = new ClaudeTranslator()
    const events = translator.translate({ type: 'rate_limit_event', session_id: 'sess-1', rate_limit_info: { status: 'rejected', resetsAt: 1791368400, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1791368400 } } } })
    expect(events).toEqual([{ kind: 'rate-limit', rateLimit: expect.objectContaining({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: new Date(1791368400_000).toISOString(), utilization: 1 }) }])
  })
})
