import { describe, expect, it } from 'vitest'

import { SessionError } from '../domain/errors.js'
import type { SessionEventBody, SessionEventEnvelope } from '../domain/events.js'
import { DEFAULT_LIMITS } from '../domain/policy.js'
import { FakeClock, SequentialIds } from '../testing/fake-clock.js'
import { MemoryJournal } from '../testing/memory-journal.js'
import { ScriptedDriverFactory, catalogOf, descriptor, type ScriptedDriverSession } from '../testing/scripted-driver.js'
import { SessionService, type SessionServiceOptions } from './session-service.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** Claude-like: resident, native queue, autonomous continuation, session-cumulative USD. */
const claudeLike = () => new ScriptedDriverFactory(descriptor('claude-like'))
/** Codex-like: resident, no native queue, no autonomous continuation, cumulative tokens, no USD. */
const codexLike = () => new ScriptedDriverFactory(descriptor('codex-like', {
  nativeInputQueue: false,
  autonomousContinuation: false,
  usage: { costUsd: 'none', tokens: 'cumulative' },
}))

function setup(factory = claudeLike(), options: Partial<SessionServiceOptions> = {}) {
  const journal = new MemoryJournal()
  const clock = new FakeClock()
  const published: SessionEventEnvelope[] = []
  const service = new SessionService({ journal, drivers: catalogOf(factory), clock, ids: new SequentialIds(), interruptGraceMs: 1_000, ...options })
  service.subscribe((envelopes) => published.push(...envelopes))
  const types = (sessionId: string) => journal.events(sessionId).map((envelope) => envelope.event.type)
  const events = (sessionId: string) => journal.events(sessionId).map((envelope) => envelope.event)
  return { journal, clock, service, factory, published, types, events }
}

async function openAndSend(ctx: ReturnType<typeof setup>, text = 'hello', policy: { subagents: 'enabled' | 'disabled' } = { subagents: 'enabled' }) {
  const { sessionId } = await ctx.service.open({ driver: ctx.factory.descriptor.id, model: 'm', cwd: '/repo', policy })
  await ctx.service.send(sessionId, { inputId: 'u1', text, delivery: 'queue' })
  return { sessionId, driver: ctx.factory.last }
}

function userTurn(driver: ScriptedDriverSession, inputId: string, reply: string, costUsd?: number) {
  driver.emit(
    { kind: 'input.receipt', inputId, state: 'started' },
    { kind: 'turn.started', trigger: 'input', inputIds: [inputId] },
    { kind: 'turn.output', channel: 'text', delta: reply },
    { kind: 'turn.completed', status: 'completed', text: reply, usage: { costUsd: costUsd ?? null, outputTokens: 10 } },
  )
}

function of<T extends SessionEventBody['type']>(list: SessionEventBody[], type: T): Array<Extract<SessionEventBody, { type: T }>> {
  return list.filter((event): event is Extract<SessionEventBody, { type: T }> => event.type === type)
}

describe('SessionService — resident turns', () => {
  it('runs consecutive turns on one provider process and records per-turn cost deltas', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'provider.ref', providerSessionRef: 'prov-1' })
    userTurn(driver, 'u1', 'one', 0.05)
    await ctx.service.send(sessionId, { inputId: 'u2', text: 'again', delivery: 'queue' })
    userTurn(driver, 'u2', 'two', 0.08)

    expect(ctx.factory.sessions).toHaveLength(1)
    expect(driver.sent.map((input) => input.inputId)).toEqual(['u1', 'u2'])
    const completed = of(ctx.events(sessionId), 'turn.completed')
    expect(completed.map((turn) => turn.usage.costUsd)).toEqual([0.05, expect.closeTo(0.03, 10)])
    expect(ctx.journal.baseline('prov-1')?.costUsd).toBe(0.08)
    expect(ctx.service.snapshot(sessionId)).toMatchObject({ phase: 'idle', openTurn: null })
    expect(ctx.service.snapshot(sessionId).inputs.u2?.state).toBe('completed')
    expect(ctx.published.map((envelope) => envelope.seq)).toEqual(ctx.journal.events(sessionId).map((envelope) => envelope.seq))
  })

  it('treats a retried input id as idempotent and rejects different content', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    await ctx.service.send(sessionId, { inputId: 'u1', text: 'hello', delivery: 'queue' })
    expect(driver.sent).toHaveLength(1)
    await expect(ctx.service.send(sessionId, { inputId: 'u1', text: 'changed', delivery: 'queue' })).rejects.toMatchObject({ code: 'input_conflict' })
  })

  it('refuses a policy the driver cannot enforce at open', async () => {
    const ctx = setup(new ScriptedDriverFactory(descriptor('stubborn', { subagentDisable: false })))
    await expect(ctx.service.open({ driver: 'stubborn', model: 'm', cwd: '/r', policy: { subagents: 'disabled' } })).rejects.toMatchObject({ code: 'policy_unenforceable' })
    await expect(ctx.service.open({ driver: 'missing', model: 'm', cwd: '/r', policy: { subagents: 'enabled' } })).rejects.toMatchObject({ code: 'driver_unavailable' })
  })
})

describe('SessionService — sub-agents across turns (Claude-like)', () => {
  it('keeps background sub-agents alive past the turn, records continuation turns and settles', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit(
      { kind: 'input.receipt', inputId: 'u1', state: 'started' },
      { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] },
      { kind: 'subagent.started', subagentId: 'a1', parentId: null, agentKind: 'background', agentType: 'general-purpose', description: 'Run bash' },
      { kind: 'roster', liveSubagentIds: ['a1'] },
      { kind: 'turn.completed', status: 'completed', text: 'LAUNCHED', usage: { costUsd: 0.02 } },
    )
    expect(ctx.service.snapshot(sessionId).phase).toBe('background')
    expect(driver.closed).toBeNull()

    // Sub-agent ends its own turn → the provider continues on its own.
    driver.emit({ kind: 'subagent.phase', subagentId: 'a1', phase: 'idle' }, { kind: 'roster', liveSubagentIds: [] })
    driver.emit({ kind: 'turn.started', trigger: 'continuation', inputIds: [] }, { kind: 'turn.completed', status: 'completed', text: 'waiting', usage: { costUsd: 0.03 } })
    // … and later restarts it under the same id (its shell finished).
    driver.emit({ kind: 'subagent.started', subagentId: 'a1', parentId: null, agentKind: 'background', description: 'Run bash' }, { kind: 'roster', liveSubagentIds: ['a1'] })
    expect(ctx.service.snapshot(sessionId).phase).toBe('background')
    driver.emit(
      { kind: 'subagent.output', subagentId: 'a1', channel: 'text', delta: 'SUBDONE' },
      { kind: 'subagent.usage', subagentId: 'a1', usage: { inputTokens: 23_482 }, toolUses: 3, durationMs: 39_494 },
      { kind: 'subagent.result', subagentId: 'a1', summary: 'SUBDONE' },
      { kind: 'subagent.phase', subagentId: 'a1', phase: 'idle' },
      { kind: 'roster', liveSubagentIds: [] },
      { kind: 'turn.started', trigger: 'continuation', inputIds: [] },
      { kind: 'turn.completed', status: 'completed', text: 'done', usage: { costUsd: 0.04 } },
    )
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)

    const snapshot = ctx.service.snapshot(sessionId)
    expect(snapshot.turns.map((turn) => turn.origin)).toEqual(['user', 'subagent', 'subagent'])
    expect(of(ctx.events(sessionId), 'turn.started')[1]?.trigger).toEqual({ subagentIds: ['a1'] })
    expect(snapshot.subagents.a1).toMatchObject({ phase: 'idle', restarts: 1, resultSummary: 'SUBDONE', usage: expect.objectContaining({ inputTokens: 23_482 }) })
    expect(snapshot.settled).toEqual({ settled: true, live: 0 })
    expect(snapshot.phase).toBe('idle')
    expect(of(ctx.events(sessionId), 'turn.completed').map((turn) => turn.usage.costUsd)).toEqual([0.02, expect.closeTo(0.01, 10), expect.closeTo(0.01, 10)])
  })

  it('does not settle while the provider roster still lists a sub-agent', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit(
      { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] },
      { kind: 'subagent.started', subagentId: 'a1', parentId: null, agentKind: 'background', description: 'x' },
      { kind: 'turn.completed', status: 'completed', text: '', usage: {} },
      { kind: 'subagent.phase', subagentId: 'a1', phase: 'idle' },
      { kind: 'roster', liveSubagentIds: [] },
    )
    // Momentarily empty, then the same sub-agent comes back within the debounce window.
    driver.emit({ kind: 'subagent.started', subagentId: 'a1', parentId: null, agentKind: 'background', description: 'x' })
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs * 2)
    expect(ctx.service.snapshot(sessionId).settled.settled).toBe(false)
    expect(of(ctx.events(sessionId), 'subagents.settled').every((event) => !event.settled)).toBe(true)
  })

  it('retires an idle process after the idle limit and resumes the provider session on the next input', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'provider.ref', providerSessionRef: 'prov-9' })
    userTurn(driver, 'u1', 'one', 0.05)
    ctx.clock.advance(DEFAULT_LIMITS.idleMs)
    await tick()
    expect(driver.closed).toBe('idle')
    expect(of(ctx.events(sessionId), 'session.process').map((event) => event.state)).toEqual(['started', 'retired'])

    await ctx.service.send(sessionId, { inputId: 'u2', text: 'back', delivery: 'queue' })
    const second = ctx.factory.last
    expect(second).not.toBe(driver)
    expect(second.spec).toMatchObject({ generation: 2, providerSessionRef: 'prov-9' })
    userTurn(second, 'u2', 'two', 0.07)
    expect(of(ctx.events(sessionId), 'turn.completed').map((turn) => turn.usage.costUsd)).toEqual([0.05, expect.closeTo(0.02, 10)])
  })
})

describe('SessionService — Codex-like drivers', () => {
  it('holds input while a turn runs and releases it afterwards', async () => {
    const ctx = setup(codexLike())
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'input.receipt', inputId: 'u1', state: 'started' }, { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] })
    await ctx.service.send(sessionId, { inputId: 'u2', text: 'later', delivery: 'queue' })
    expect(driver.sent.map((input) => input.inputId)).toEqual(['u1'])
    driver.emit({ kind: 'turn.completed', status: 'completed', text: '', usage: { inputTokens: 100 } })
    await tick()
    expect(driver.sent.map((input) => input.inputId)).toEqual(['u1', 'u2'])
  })

  it('completes an input steered into a running turn together with that turn', async () => {
    const ctx = setup(new ScriptedDriverFactory(descriptor('steerable', { nativeInputQueue: false })))
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'input.receipt', inputId: 'u1', state: 'started' }, { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] })
    await ctx.service.send(sessionId, { inputId: 'u2', text: 'also this', delivery: 'steer' })
    expect(driver.sent.map((input) => [input.inputId, input.delivery])).toEqual([['u1', 'queue'], ['u2', 'steer']])
    driver.emit({ kind: 'input.receipt', inputId: 'u2', state: 'started' })
    driver.emit({ kind: 'turn.completed', status: 'completed', text: 'ok', usage: {} })
    expect(ctx.service.snapshot(sessionId).inputs.u2).toMatchObject({ state: 'completed', turnId: 'turn-1' })
  })

  it('asks the agent to collect settled sub-agents, bounded by maxSettleHandoffs', async () => {
    const ctx = setup(codexLike())
    const { sessionId } = await ctx.service.open({ driver: 'codex-like', model: 'm', cwd: '/r', policy: { subagents: 'enabled', limits: { maxSettleHandoffs: 1 } } })
    await ctx.service.send(sessionId, { inputId: 'u1', text: 'go', delivery: 'queue' })
    const driver = ctx.factory.last
    const cycle = (id: string) => {
      driver.emit(
        { kind: 'subagent.started', subagentId: id, parentId: null, agentKind: 'background', description: id },
        { kind: 'subagent.phase', subagentId: id, phase: 'idle' },
      )
      ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    }
    driver.emit({ kind: 'input.receipt', inputId: 'u1', state: 'started' }, { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] })
    driver.emit({ kind: 'subagent.started', subagentId: 't1', parentId: null, agentKind: 'background', description: 'thread 1' })
    driver.emit({ kind: 'turn.completed', status: 'completed', text: 'spawned', usage: {} })
    driver.emit({ kind: 'subagent.phase', subagentId: 't1', phase: 'idle' })
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    await tick()
    const system = driver.sent.at(-1)!
    expect(system.origin).toBe('system')
    driver.emit({ kind: 'input.receipt', inputId: system.inputId, state: 'started' }, { kind: 'turn.started', trigger: 'input', inputIds: [system.inputId] })
    driver.emit({ kind: 'turn.completed', status: 'completed', text: 'collected', usage: {} })
    expect(ctx.service.snapshot(sessionId).turns.map((turn) => turn.origin)).toEqual(['user', 'system'])
    expect(of(ctx.events(sessionId), 'turn.started')[1]?.trigger).toEqual({ subagentIds: ['t1'] })

    cycle('t2')
    await tick()
    expect(driver.sent.filter((input) => input.origin === 'system')).toHaveLength(1)
  })
})

describe('SessionService — stop, limits and failures', () => {
  function launchBackground(driver: ScriptedDriverSession) {
    driver.emit(
      { kind: 'input.receipt', inputId: 'u1', state: 'started' },
      { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] },
      { kind: 'subagent.started', subagentId: 'a1', parentId: null, agentKind: 'background', description: 'Long job' },
      { kind: 'turn.completed', status: 'completed', text: 'LAUNCHED', usage: {} },
    )
  }

  it('interrupts a turn and ends the process when the provider ignores it', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'turn.started', trigger: 'input', inputIds: ['u1'] }, { kind: 'turn.output', channel: 'text', delta: 'partial' })
    expect((await ctx.service.interrupt(sessionId)).turnId).toBe('turn-1')
    expect(driver.calls).toContain('interrupt')
    ctx.clock.advance(1_000)
    await tick()
    const done = of(ctx.events(sessionId), 'turn.completed')[0]
    expect(done).toMatchObject({ status: 'stopped', text: 'partial' })
    expect(driver.closed).toBe('user_stop')
  })

  it('stops background sub-agents by ending the process and keeps the session usable', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    launchBackground(driver)
    driver.onClose = [{ kind: 'subagent.phase', subagentId: 'a1', phase: 'stopped' }]
    expect(await ctx.service.stopSubagents(sessionId)).toEqual({ stopped: ['a1'] })
    expect(ctx.service.snapshot(sessionId)).toMatchObject({ phase: 'idle', settled: { settled: true, live: 0 } })
    expect(ctx.service.snapshot(sessionId).subagents.a1?.phase).toBe('stopped')

    await ctx.service.send(sessionId, { inputId: 'u2', text: 'next', delivery: 'queue' })
    expect(ctx.factory.sessions).toHaveLength(2)
    expect(ctx.factory.last.sent[0]?.text).toContain('"Long job" (background) — stopped')
  })

  it('records a crash, interrupts running work and tells the agent exactly once', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    launchBackground(driver)
    await ctx.service.send(sessionId, { inputId: 'u2', text: 'status?', delivery: 'queue' })
    driver.emit({ kind: 'turn.started', trigger: 'input', inputIds: ['u2'] }, { kind: 'turn.output', channel: 'text', delta: 'half' })
    driver.emit({ kind: 'process.exited', exitCode: 1, signal: null })

    const snapshot = ctx.service.snapshot(sessionId)
    expect(snapshot.turns.at(-1)).toMatchObject({ status: 'failed' })
    expect(of(ctx.events(sessionId), 'turn.completed').at(-1)).toMatchObject({ text: 'half', error: expect.stringContaining('exited') })
    expect(snapshot.subagents.a1).toMatchObject({ phase: 'interrupted', reason: 'crashed' })
    expect(snapshot.inputs.u2?.state).toBe('interrupted')
    expect(snapshot.process.alive).toBe(false)

    await ctx.service.send(sessionId, { inputId: 'u3', text: 'continue', delivery: 'queue' })
    const next = ctx.factory.last
    expect(next.sent[0]?.text).toMatch(/Do not relaunch or resume them unless the user explicitly asks[\s\S]*continue$/)
    await ctx.service.send(sessionId, { inputId: 'u4', text: 'more', delivery: 'queue' })
    expect(next.sent[1]?.text).toBe('more')
    expect(of(ctx.events(sessionId), 'notice.interruption')).toHaveLength(1)
  })

  it('retires a stalled background phase and one that exceeds its maximum lifetime', async () => {
    const stalled = setup()
    const a = await openAndSend(stalled)
    launchBackground(a.driver)
    stalled.clock.advance(DEFAULT_LIMITS.stallMs)
    await tick()
    expect(stalled.service.snapshot(a.sessionId).subagents.a1).toMatchObject({ phase: 'interrupted', reason: 'stalled' })

    const capped = setup()
    const b = await openAndSend(capped)
    launchBackground(b.driver)
    // Keep it active so the stall limit never fires.
    for (let elapsed = 0; elapsed < DEFAULT_LIMITS.backgroundMaxMs; elapsed += 60_000) {
      capped.clock.advance(60_000)
      if (b.driver.closed === null) b.driver.emit({ kind: 'subagent.output', subagentId: 'a1', channel: 'text', delta: '.' })
    }
    await tick()
    expect(capped.service.snapshot(b.sessionId).subagents.a1).toMatchObject({ phase: 'stopped', reason: 'limit' })
    expect(b.driver.closed).toBe('limit')
  })

  it('fails a turn with no provider activity before the inactivity limit, counting sub-agent frames as activity', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'turn.started', trigger: 'input', inputIds: ['u1'] }, { kind: 'subagent.started', subagentId: 'f1', parentId: null, agentKind: 'foreground', description: 'fg' })
    ctx.clock.advance(DEFAULT_LIMITS.turnInactivityMs - 1)
    driver.emit({ kind: 'subagent.output', subagentId: 'f1', channel: 'text', delta: 'working' })
    ctx.clock.advance(DEFAULT_LIMITS.turnInactivityMs - 1)
    await tick()
    expect(driver.closed).toBeNull()
    ctx.clock.advance(2)
    await tick()
    expect(of(ctx.events(sessionId), 'turn.completed')[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('inactivity') })
  })

  it('defers updates while sub-agents run and applies them when the session goes idle', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    launchBackground(driver)
    expect(await ctx.service.update(sessionId, { model: 'bigger' })).toEqual({ outcome: 'deferred' })
    expect(ctx.service.snapshot(sessionId).model).toBe('m')
    driver.emit({ kind: 'subagent.phase', subagentId: 'a1', phase: 'idle' })
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    await tick()
    expect(ctx.service.snapshot(sessionId).model).toBe('bigger')
    expect(driver.closed).toBe('config_change')
    await ctx.service.send(sessionId, { inputId: 'u2', text: 'x', delivery: 'queue' })
    expect(ctx.factory.last.spec.model).toBe('bigger')
  })

  it('reports illegal provider facts as diagnostics instead of corrupting state', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'turn.completed', status: 'completed', text: 'orphan', usage: {} })
    driver.emit({ kind: 'subagent.phase', subagentId: 'ghost', phase: 'idle' })
    expect(of(ctx.events(sessionId), 'provider.diagnostic').map((event) => event.code)).toEqual(['illegal_transition', 'illegal_transition'])
    expect(ctx.service.snapshot(sessionId).turns).toEqual([])
  })

  it('ignores events from a retired process generation', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    userTurn(driver, 'u1', 'one')
    ctx.clock.advance(DEFAULT_LIMITS.idleMs)
    await tick()
    const before = ctx.journal.events(sessionId).length
    ;(driver as unknown as { closed: null }).closed = null
    driver.emit({ kind: 'turn.started', trigger: 'continuation', inputIds: [] })
    expect(ctx.journal.events(sessionId)).toHaveLength(before)
  })
})

describe('SessionService — output, recovery, eviction, shutdown', () => {
  it('coalesces streaming deltas and truncates beyond the cap', async () => {
    const ctx = setup(claudeLike(), { outputLimits: { flushChars: 10, turnCap: 25, subagentCap: 5 } })
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'turn.started', trigger: 'input', inputIds: ['u1'] })
    for (let index = 0; index < 10; index++) driver.emit({ kind: 'turn.output', channel: 'text', delta: 'abc' })
    driver.emit({ kind: 'turn.completed', status: 'completed', text: 'x', usage: {} })
    const outputs = of(ctx.events(sessionId), 'turn.output')
    expect(outputs.length).toBeLessThan(10)
    expect(outputs.map((event) => event.delta).join('')).toBe('abc'.repeat(8))
    expect(of(ctx.events(sessionId), 'output.truncated')[0]).toMatchObject({ scope: { turnId: 'turn-1' }, droppedEvents: 2, droppedBytes: 6 })
  })

  it('flushes buffered deltas on a timer', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'turn.started', trigger: 'input', inputIds: ['u1'] }, { kind: 'turn.output', channel: 'text', delta: 'hi' })
    expect(of(ctx.events(sessionId), 'turn.output')).toHaveLength(0)
    ctx.clock.advance(50)
    expect(of(ctx.events(sessionId), 'turn.output').map((event) => event.delta)).toEqual(['hi'])
  })

  it('marks work left running by a previous host as interrupted without starting providers', async () => {
    const first = setup()
    const { sessionId, driver } = await openAndSend(first)
    driver.emit({ kind: 'turn.started', trigger: 'input', inputIds: ['u1'] }, { kind: 'subagent.started', subagentId: 'a1', parentId: null, agentKind: 'background', description: 'x' })

    const factory = claudeLike()
    const service = new SessionService({ journal: first.journal, drivers: catalogOf(factory), clock: first.clock, ids: new SequentialIds() })
    expect(service.recover()).toEqual([sessionId])
    const snapshot = service.snapshot(sessionId)
    expect(snapshot).toMatchObject({ phase: 'idle', openTurn: null, process: { alive: false } })
    expect(snapshot.subagents.a1).toMatchObject({ phase: 'interrupted', reason: 'restart' })
    expect(factory.sessions).toHaveLength(0)
    expect(service.recover()).toEqual([])

    await service.open({ driver: 'claude-like', model: 'm', cwd: '/r', policy: { subagents: 'enabled' }, resume: { sessionId } })
    await service.send(sessionId, { inputId: 'u9', text: 'hi', delivery: 'queue' })
    expect(factory.last.sent[0]?.text).toContain('interrupted by an application restart')
  })

  it('evicts the least recently used idle process beyond the resident cap, never a busy one', async () => {
    const factory = claudeLike()
    const ctx = setup(factory, { maxResident: 1 })
    const a = await ctx.service.open({ driver: 'claude-like', model: 'm', cwd: '/a', policy: { subagents: 'enabled' } })
    await ctx.service.send(a.sessionId, { inputId: 'a1', text: 'a', delivery: 'queue' })
    userTurn(factory.last, 'a1', 'ok')
    const first = factory.last
    ctx.clock.advance(1_000)
    const b = await ctx.service.open({ driver: 'claude-like', model: 'm', cwd: '/b', policy: { subagents: 'enabled' } })
    await ctx.service.send(b.sessionId, { inputId: 'b1', text: 'b', delivery: 'queue' })
    await tick()
    expect(first.closed).toBe('evicted')
    expect(factory.last.closed).toBeNull()
  })

  it('records running work as interrupted on shutdown and refuses new work', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    driver.emit({ kind: 'turn.started', trigger: 'input', inputIds: ['u1'] })
    await ctx.service.shutdown()
    expect(driver.closed).toBe('shutdown')
    expect(of(ctx.events(sessionId), 'turn.completed')[0]?.status).toBe('interrupted')
    await expect(ctx.service.send(sessionId, { inputId: 'u2', text: 'x', delivery: 'queue' })).rejects.toBeInstanceOf(SessionError)
  })

  it('closes a session and rejects later operations', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx)
    await ctx.service.close(sessionId, 'conversation_deleted')
    expect(driver.closed).toBe('session_closed')
    expect(ctx.service.snapshot(sessionId)).toMatchObject({ status: 'closed', closedReason: 'conversation_deleted' })
    await expect(ctx.service.send(sessionId, { inputId: 'u2', text: 'x', delivery: 'queue' })).rejects.toMatchObject({ code: 'session_closed' })
    expect(ctx.service.events(sessionId, 0, 2)).toMatchObject({ nextSeq: 2, hasMore: true })
    expect(ctx.service.list('closed').map((summary) => summary.sessionId)).toEqual([sessionId])
  })
})

describe('SessionService — disabled sub-agent policy', () => {
  it('stops a sub-agent the provider starts anyway and records why', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx, 'hello', { subagents: 'disabled' })
    driver.stopResult = ['a1']
    driver.emit(
      { kind: 'input.receipt', inputId: 'u1', state: 'started' },
      { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] },
      { kind: 'subagent.started', subagentId: 'a1', parentId: null, agentKind: 'background', description: 'Sneaky' },
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(driver.calls).toContain('stopSubagents:a1')
    const events = ctx.events(sessionId)
    expect(of(events, 'provider.diagnostic').map((event) => event.code)).toContain('policy.subagent_blocked')
    expect(of(events, 'subagent.phase')).toEqual([expect.objectContaining({ subagentId: 'a1', phase: 'stopped', reason: 'policy' })])
  })

  it('retires the process when the driver can only stop sub-agents with it', async () => {
    const ctx = setup()
    const { sessionId, driver } = await openAndSend(ctx, 'hello', { subagents: 'disabled' })
    driver.emit(
      { kind: 'input.receipt', inputId: 'u1', state: 'started' },
      { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] },
      { kind: 'subagent.started', subagentId: 'a1', parentId: null, agentKind: 'background', description: 'Sneaky' },
    )
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(driver.closed).toBe('host_request')
    expect(ctx.service.snapshot(sessionId).subagents.a1).toMatchObject({ phase: 'stopped', reason: 'policy' })
  })

  it('leaves sub-agents alone when the policy enables them', async () => {
    const ctx = setup()
    const { driver } = await openAndSend(ctx)
    driver.emit({ kind: 'turn.started', trigger: 'input', inputIds: ['u1'] }, { kind: 'subagent.started', subagentId: 'a1', parentId: null, agentKind: 'background', description: 'Allowed' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(driver.calls.some((call) => call.startsWith('stopSubagents'))).toBe(false)
  })
})

