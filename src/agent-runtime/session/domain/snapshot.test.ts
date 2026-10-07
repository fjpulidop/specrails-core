import { describe, expect, it } from 'vitest'

import { SessionError } from './errors.js'
import type { SessionEventBody, SessionEventEnvelope } from './events.js'
import { buildInterruptionNotice } from './interruption.js'
import { DEFAULT_LIMITS } from './policy.js'
import { applyEvent, emptySnapshot, foldEvents, liveSubagents, type SessionSnapshot } from './snapshot.js'
import { EMPTY_USAGE, type SessionPolicy } from './types.js'

const policy: SessionPolicy = {
  subagents: 'enabled',
  onSubagentsSettled: 'provider-native',
  tools: { mode: 'default' },
  permissions: 'bypass',
  mcp: { servers: [], inheritUserScope: false },
  limits: DEFAULT_LIMITS,
}

function envelopes(bodies: SessionEventBody[], sessionId = 's1'): SessionEventEnvelope[] {
  return bodies.map((body, index) => ({ sessionId, seq: index + 1, event: { ...body, at: new Date(Date.UTC(2026, 9, 7, 10, 0, index)).toISOString() } as never }))
}

function fold(bodies: SessionEventBody[]): SessionSnapshot {
  return foldEvents(emptySnapshot('s1'), envelopes(bodies))
}

function errorCode(fn: () => unknown): string | undefined {
  try { fn() } catch (error) { return (error as SessionError).code }
  return undefined
}

/** Normalized shape of the captured claude-bg-complete transcript. */
const backgroundRun: SessionEventBody[] = [
  { type: 'session.opened', driver: 'claude', model: 'haiku', policy, resumed: false, providerSessionRef: null },
  { type: 'session.process', state: 'started', generation: 1 },
  { type: 'input.accepted', inputId: 'u1', delivery: 'queue', text: 'launch one background agent' },
  { type: 'input.state', inputId: 'u1', state: 'queued' },
  { type: 'input.state', inputId: 'u1', state: 'started', turnId: 't1' },
  { type: 'session.phase', phase: 'turn' },
  { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: ['u1'] },
  { type: 'session.provider-ref', providerSessionRef: 'claude-session-1' },
  { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', agentType: 'general-purpose', description: 'Run bash command and report output' },
  { type: 'turn.output', turnId: 't1', channel: 'text', delta: 'LAUNCHED' },
  { type: 'turn.completed', turnId: 't1', status: 'completed', text: 'LAUNCHED', usage: { ...EMPTY_USAGE, costUsd: 0.027 } },
  { type: 'input.state', inputId: 'u1', state: 'completed', turnId: 't1' },
  { type: 'session.phase', phase: 'background' },
  // The sub-agent ends its own turn while its shell keeps running …
  { type: 'subagent.phase', subagentId: 'a1', phase: 'idle' },
  { type: 'session.phase', phase: 'turn' },
  { type: 'turn.started', turnId: 't2', origin: 'subagent', inputIds: [], trigger: { subagentIds: ['a1'] } },
  { type: 'turn.completed', turnId: 't2', status: 'completed', text: 'Agent is waiting', usage: { ...EMPTY_USAGE, costUsd: 0.041 } },
  { type: 'session.phase', phase: 'background' },
  // … and is restarted under the same id when the shell finishes.
  { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', description: 'Run bash command and report output' },
  { type: 'subagent.output', subagentId: 'a1', channel: 'text', delta: 'SUBDONE' },
  { type: 'subagent.phase', subagentId: 'a1', phase: 'idle' },
  { type: 'subagent.usage', subagentId: 'a1', usage: { ...EMPTY_USAGE, inputTokens: 23_482 }, toolUses: 3, durationMs: 39_494 },
  { type: 'subagent.result', subagentId: 'a1', summary: 'SUBDONE' },
  { type: 'subagents.settled', settled: true, live: 0 },
  { type: 'session.phase', phase: 'turn' },
  { type: 'turn.started', turnId: 't3', origin: 'subagent', inputIds: [], trigger: { subagentIds: ['a1'] } },
  { type: 'turn.completed', turnId: 't3', status: 'completed', text: 'Subagent completed', usage: { ...EMPTY_USAGE, costUsd: 0.012 } },
  { type: 'session.phase', phase: 'idle' },
]

describe('session snapshot', () => {
  it('folds the captured background run into one user turn, two continuations and one re-entrant sub-agent', () => {
    const state = fold(backgroundRun)
    expect(state.lastSeq).toBe(backgroundRun.length)
    expect(state.phase).toBe('idle')
    expect(state.openTurn).toBeNull()
    expect(state.providerSessionRef).toBe('claude-session-1')
    expect(state.turns.map((turn) => [turn.origin, turn.status])).toEqual([['user', 'completed'], ['subagent', 'completed'], ['subagent', 'completed']])
    expect(state.inputs.u1).toMatchObject({ state: 'completed', turnId: 't1' })
    expect(state.subagents.a1).toMatchObject({ phase: 'idle', restarts: 1, resultSummary: 'SUBDONE', toolUses: 3, durationMs: 39_494 })
    expect(liveSubagents(state)).toEqual([])
    expect(state.settled).toEqual({ settled: true, live: 0 })
  })

  it('does not mutate the previous snapshot', () => {
    const before = fold(backgroundRun.slice(0, 9))
    const frozen = JSON.stringify(before)
    applyEvent(before, { type: 'subagent.phase', subagentId: 'a1', phase: 'stopped', at: 'x' })
    expect(JSON.stringify(before)).toBe(frozen)
  })

  it('equals the step-by-step live state when replayed (replay = live)', () => {
    let live = emptySnapshot('s1')
    for (const envelope of envelopes(backgroundRun)) live = { ...applyEvent(live, envelope.event), lastSeq: envelope.seq }
    expect(fold(backgroundRun)).toEqual(live)
  })

  it('accumulates text of the open turn for reconnect snapshots', () => {
    const state = fold([
      ...backgroundRun.slice(0, 7),
      { type: 'turn.output', turnId: 't1', channel: 'text', delta: 'Hel' },
      { type: 'turn.output', turnId: 't1', channel: 'thinking', delta: '…' },
      { type: 'turn.output', turnId: 't1', channel: 'text', delta: 'lo' },
    ])
    expect(state.openTurn?.text).toBe('Hello')
  })

  it.each<[string, SessionEventBody[], string]>([
    ['second turn while one runs', [...backgroundRun.slice(0, 7), { type: 'turn.started', turnId: 'tx', origin: 'user', inputIds: [] }], 'illegal_transition'],
    ['output for a turn that is not running', [...backgroundRun.slice(0, 1), { type: 'turn.output', turnId: 'nope', channel: 'text', delta: 'x' }], 'illegal_transition'],
    ['completing a finished turn', [...backgroundRun.slice(0, 11), { type: 'turn.completed', turnId: 't1', status: 'failed', text: '', usage: EMPTY_USAGE }], 'illegal_transition'],
    ['input regressing', [...backgroundRun.slice(0, 5), { type: 'input.state', inputId: 'u1', state: 'queued' }], 'illegal_transition'],
    ['duplicate input id', [...backgroundRun.slice(0, 3), { type: 'input.accepted', inputId: 'u1', delivery: 'queue', text: 'again' }], 'input_conflict'],
    ['unknown sub-agent', [{ type: 'subagent.phase', subagentId: 'ghost', phase: 'idle' }], 'illegal_transition'],
    ['unknown parent', [{ type: 'subagent.started', subagentId: 'c', parentId: 'ghost', kind: 'background', description: 'x' }], 'illegal_transition'],
    ['restarting a killed sub-agent', [...backgroundRun.slice(0, 9), { type: 'subagent.phase', subagentId: 'a1', phase: 'killed' }, { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', description: 'x' }], 'illegal_transition'],
    ['illegal phase jump', [{ type: 'session.phase', phase: 'turn' }, { type: 'session.phase', phase: 'turn' }, { type: 'turn.completed', turnId: 'x', status: 'completed', text: '', usage: EMPTY_USAGE }], 'illegal_transition'],
    ['event after close', [{ type: 'session.closed', reason: 'host_request' }, { type: 'session.phase', phase: 'turn' }], 'session_closed'],
  ])('rejects %s', (_name, bodies, code) => {
    expect(errorCode(() => fold(bodies))).toBe(code)
  })

  it('rejects sequence gaps and foreign sessions', () => {
    const list = envelopes(backgroundRun.slice(0, 3))
    expect(errorCode(() => foldEvents(emptySnapshot('s1'), [list[0]!, list[2]!]))).toBe('internal')
    expect(errorCode(() => foldEvents(emptySnapshot('other'), list))).toBe('internal')
  })

  it('tracks nested sub-agents', () => {
    const state = fold([
      ...backgroundRun.slice(0, 9),
      { type: 'subagent.started', subagentId: 'a1.1', parentId: 'a1', kind: 'foreground', description: 'nested' },
    ])
    expect(state.subagents['a1.1']?.parentId).toBe('a1')
    expect(liveSubagents(state).map((node) => node.subagentId)).toEqual(['a1', 'a1.1'])
  })

  it('bounds turn and terminal-input history while counting every turn', () => {
    const bodies: SessionEventBody[] = [backgroundRun[0]!, { type: 'session.phase', phase: 'turn' }]
    for (let index = 0; index < 120; index++) {
      bodies.push({ type: 'input.accepted', inputId: `i${index}`, delivery: 'queue', text: 'x' })
      bodies.push({ type: 'input.state', inputId: `i${index}`, state: 'started' })
      bodies.push({ type: 'turn.started', turnId: `t${index}`, origin: 'user', inputIds: [`i${index}`] })
      bodies.push({ type: 'turn.completed', turnId: `t${index}`, status: 'completed', text: '', usage: EMPTY_USAGE })
      bodies.push({ type: 'input.state', inputId: `i${index}`, state: 'completed' })
    }
    bodies.push({ type: 'input.accepted', inputId: 'live', delivery: 'queue', text: 'pending' })
    const state = fold(bodies)
    expect(state.turnCount).toBe(120)
    expect(state.turns).toHaveLength(100)
    expect(state.turns[0]?.turnId).toBe('t20')
    expect(Object.keys(state.inputs)).toHaveLength(121)
    expect(state.inputs.live?.state).toBe('accepted')
  })

  it('applies only non-deferred updates', () => {
    const base = backgroundRun.slice(0, 1)
    expect(fold([...base, { type: 'session.updated', changes: { model: 'sonnet' }, outcome: 'deferred' }]).model).toBe('haiku')
    expect(fold([...base, { type: 'session.updated', changes: { model: 'sonnet', effort: 'high' }, outcome: 'applied' }])).toMatchObject({ model: 'sonnet', effort: 'high' })
  })
})

describe('interruption notice', () => {
  const interrupted: SessionEventBody[] = [
    ...backgroundRun.slice(0, 13),
    { type: 'subagent.phase', subagentId: 'a1', phase: 'interrupted', reason: 'restart' },
    { type: 'input.accepted', inputId: 'u2', delivery: 'queue', text: 'status?' },
    { type: 'input.state', inputId: 'u2', state: 'interrupted', reason: 'restart' },
  ]

  it('lists interrupted work once and forbids silent relaunch', () => {
    const state = fold(interrupted)
    const notice = buildInterruptionNotice(state)
    expect(notice?.subagentIds).toEqual(['a1'])
    expect(notice?.inputIds).toEqual(['u2'])
    expect(notice?.text).toContain('"Run bash command and report output" (general-purpose) — interrupted by an application restart.')
    expect(notice?.text).toContain('Do not relaunch or resume them unless the user explicitly asks')
    expect(notice?.text).toContain('One earlier user message may not have reached you')

    const acknowledged = fold([...interrupted, { type: 'notice.interruption', subagentIds: ['a1'], inputIds: ['u2'] }])
    expect(buildInterruptionNotice(acknowledged)).toBeNull()
  })

  it('reports stops and kills but not normal completion', () => {
    expect(buildInterruptionNotice(fold(backgroundRun))).toBeNull()
    const stopped = fold([...backgroundRun.slice(0, 13), { type: 'subagent.phase', subagentId: 'a1', phase: 'stopped', reason: 'user_stop' }, { type: 'subagent.phase', subagentId: 'a1', phase: 'killed' }])
    expect(buildInterruptionNotice(stopped)?.text).toContain('— stopped by the user')
    expect(stopped.subagents.a1?.reason).toBe('user_stop')
    expect(stopped.pendingInterruptions.subagentIds).toEqual(['a1'])
  })
})
