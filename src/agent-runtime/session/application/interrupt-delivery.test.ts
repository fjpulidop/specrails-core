import { describe, expect, it } from 'vitest'

import type { SessionEventBody } from '../domain/events.js'
import type { DriverCapabilities } from '../domain/types.js'
import { FakeClock, SequentialIds } from '../testing/fake-clock.js'
import { MemoryJournal } from '../testing/memory-journal.js'
import { ScriptedDriverFactory, catalogOf, descriptor, type ScriptedDriverSession } from '../testing/scripted-driver.js'
import { SessionService } from './session-service.js'

/** Claude-like: native queue and a native stop primitive the driver applies itself. */
const nativeQueue = () => new ScriptedDriverFactory(descriptor('claude-like', { interrupt: 'native' }))
/** Codex-like: one turn per request; the application sequences `turn/interrupt` → `turn/start`. */
const oneTurnNative = () => new ScriptedDriverFactory(descriptor('codex-like', { nativeInputQueue: false, autonomousContinuation: false, interrupt: 'native', usage: { costUsd: 'none', tokens: 'cumulative' } }))
/** Executor-like: no primitive, no steering, one invocation per turn. */
const oneTurnEmulated = () => new ScriptedDriverFactory(descriptor('executor-like', { nativeInputQueue: false, autonomousContinuation: false, steer: false, interrupt: 'emulated' }))
/** A queueing provider without a stop primitive. */
const queueEmulated = (caps: Partial<DriverCapabilities> = { interrupt: 'emulated' }) => new ScriptedDriverFactory(descriptor('queue-emulated', caps))

function setup(factory: ScriptedDriverFactory, journal = new MemoryJournal(), clock = new FakeClock()) {
  const service = new SessionService({ journal, drivers: catalogOf(factory), clock, ids: new SequentialIds(), interruptGraceMs: 1_000 })
  const events = (sessionId: string) => journal.events(sessionId).map((envelope) => envelope.event as SessionEventBody)
  return { journal, clock, service, factory, events }
}

type Ctx = ReturnType<typeof setup>

async function open(ctx: Ctx) {
  const { sessionId } = await ctx.service.open({ driver: ctx.factory.descriptor.id, model: 'm', cwd: '/repo', policy: { subagents: 'enabled' } })
  return sessionId
}

/** Open, send u1 and leave its turn running with some streamed text. */
async function running(ctx: Ctx) {
  const sessionId = await open(ctx)
  await ctx.service.send(sessionId, { inputId: 'u1', text: 'long task', delivery: 'queue' })
  const driver = ctx.factory.last
  driver.emit(
    { kind: 'input.receipt', inputId: 'u1', state: 'started' },
    { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] },
    { kind: 'turn.output', channel: 'text', delta: 'partial work' },
  )
  return { sessionId, driver }
}

function turn(driver: ScriptedDriverSession, inputId: string, reply = `${inputId} done`) {
  driver.emit(
    { kind: 'input.receipt', inputId, state: 'started' },
    { kind: 'turn.started', trigger: 'input', inputIds: [inputId] },
    { kind: 'turn.completed', status: 'completed', text: reply, usage: {} },
  )
}

/** What the provider reports once it honoured the stop (no final text, like Claude). */
const stopped = (driver: ScriptedDriverSession) => driver.emit({ kind: 'turn.completed', status: 'stopped', text: '', usage: {} })

function of<T extends SessionEventBody['type']>(list: SessionEventBody[], type: T): Array<Extract<SessionEventBody, { type: T }>> {
  return list.filter((event): event is Extract<SessionEventBody, { type: T }> => event.type === type)
}

const startedInputs = (ctx: Ctx, sessionId: string) => of(ctx.events(sessionId), 'turn.started').map((event) => event.inputIds)

describe('interrupt delivery — native queue with a native primitive (Claude-like)', () => {
  it('hands the input to the driver once, maps the cut turn to interrupted with its partial text, and runs the input before queued ones', async () => {
    const ctx = setup(nativeQueue())
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'q1', text: 'queued', delivery: 'queue' })
    driver.emit({ kind: 'input.receipt', inputId: 'q1', state: 'queued' })
    const result = await ctx.service.send(sessionId, { inputId: 'i1', text: 'no, do this instead', delivery: 'interrupt' })
    expect(result).toEqual({ inputId: 'i1', state: 'accepted' })
    // The driver applies its own primitive: the application does not call interrupt().
    expect(driver.calls).toEqual(['send:u1', 'send:q1', 'send:i1'])
    expect(driver.sent.at(-1)).toMatchObject({ inputId: 'i1', delivery: 'interrupt', text: 'no, do this instead' })

    stopped(driver)
    turn(driver, 'i1')
    turn(driver, 'q1')

    const list = ctx.events(sessionId)
    const accepted = list.findIndex((event) => event.type === 'input.accepted' && event.inputId === 'i1')
    const cut = list.findIndex((event) => event.type === 'turn.completed' && event.status === 'interrupted')
    const next = list.findIndex((event) => event.type === 'turn.started' && event.inputIds.includes('i1'))
    expect(accepted).toBeGreaterThan(-1)
    expect(cut).toBeGreaterThan(accepted)
    expect(next).toBeGreaterThan(cut)
    expect(list[accepted]).toMatchObject({ delivery: 'interrupt' })
    expect(list[cut]).toMatchObject({ text: 'partial work' })
    expect(startedInputs(ctx, sessionId)).toEqual([['u1'], ['i1'], ['q1']])
    const snapshot = ctx.service.snapshot(sessionId)
    expect(snapshot.turns.map((item) => item.status)).toEqual(['interrupted', 'completed', 'completed'])
    expect(['u1', 'i1', 'q1'].map((id) => snapshot.inputs[id]?.state)).toEqual(['completed', 'completed', 'completed'])
    expect(snapshot.pendingInterruptions).toEqual({ subagentIds: [], inputIds: [] })
  })

  it('keeps the provider status when the turn finished before the stop landed', async () => {
    const ctx = setup(nativeQueue())
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })
    driver.emit({ kind: 'turn.completed', status: 'completed', text: 'all done', usage: {} })
    turn(driver, 'i1')
    expect(ctx.service.snapshot(sessionId).turns.map((item) => item.status)).toEqual(['completed', 'completed'])
    expect(of(ctx.events(sessionId), 'turn.completed')[0]?.text).toBe('all done')
  })

  it('does not stop the turn a pending correction starts: later interrupts follow it', async () => {
    const ctx = setup(nativeQueue())
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'first fix', delivery: 'interrupt' })
    await ctx.service.send(sessionId, { inputId: 'i2', text: 'second fix', delivery: 'interrupt' })
    stopped(driver)
    // Still pending while idle: the driver keeps it ahead of the provider queue.
    await ctx.service.send(sessionId, { inputId: 'i3', text: 'third fix', delivery: 'interrupt' })
    expect(driver.calls).toEqual(['send:u1', 'send:i1', 'send:i2', 'send:i3'])
    expect(driver.sent.slice(1).map((input) => input.delivery)).toEqual(['interrupt', 'interrupt', 'interrupt'])
    turn(driver, 'i1')
    expect(ctx.service.snapshot(sessionId).turns.map((item) => item.status)).toEqual(['interrupted', 'completed'])
  })

  it('never loses the input when the provider ignores the stop: the process is retired and the input goes to a fresh one', async () => {
    const ctx = setup(nativeQueue())
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'q1', text: 'queued', delivery: 'queue' })
    driver.emit({ kind: 'input.receipt', inputId: 'q1', state: 'queued' })
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })
    driver.emit({ kind: 'input.receipt', inputId: 'i1', state: 'queued' })
    ctx.clock.advance(1_000)
    await new Promise((resolve) => setImmediate(resolve))

    expect(driver.closed).toBe('user_stop')
    expect(ctx.factory.sessions).toHaveLength(2)
    const fresh = ctx.factory.last
    expect(fresh.sent.map((input) => [input.inputId, input.delivery])).toEqual([['i1', 'queue']])
    const snapshot = ctx.service.snapshot(sessionId)
    expect(snapshot.turns[0]).toMatchObject({ status: 'interrupted' })
    expect(of(ctx.events(sessionId), 'turn.completed')[0]?.text).toBe('partial work')
    expect(snapshot.inputs.i1?.state).toBe('queued')
    // q1 lived in the dead provider's own queue: recorded, and reported by the next notice.
    expect(snapshot.inputs.q1?.state).toBe('interrupted')
    expect(snapshot.pendingInterruptions.inputIds).toEqual(['q1'])
    turn(fresh, 'i1')
    expect(ctx.service.snapshot(sessionId).inputs.i1?.state).toBe('completed')
  })

  it('forgets a pending correction the provider rejected', async () => {
    const ctx = setup(nativeQueue())
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })
    driver.emit({ kind: 'input.receipt', inputId: 'i1', state: 'rejected', reason: 'cancelled' })
    driver.emit({ kind: 'turn.completed', status: 'stopped', text: '', usage: {} })
    // No pending interrupt any more: a plain stop stays a stop.
    expect(ctx.service.snapshot(sessionId).turns[0]?.status).toBe('stopped')
    expect(ctx.service.snapshot(sessionId).inputs.i1?.state).toBe('rejected')
  })
})

describe.each([
  ['native (Codex-like)', oneTurnNative],
  ['emulated (executor-like)', oneTurnEmulated],
])('interrupt delivery — one turn per request, %s', (_name, make) => {
  it('stops the turn, then starts the correction before inputs held behind it, in order', async () => {
    const ctx = setup(make())
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'q1', text: 'queued one', delivery: 'queue' })
    await ctx.service.send(sessionId, { inputId: 'q2', text: 'queued two', delivery: 'queue' })
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'correction', delivery: 'interrupt' })
    // Stop first; nothing is written while the cut turn is still running.
    expect(driver.calls).toEqual(['send:u1', 'interrupt'])

    stopped(driver)
    await new Promise((resolve) => setImmediate(resolve))
    expect(driver.sent.map((input) => [input.inputId, input.delivery])).toEqual([['u1', 'queue'], ['i1', 'queue']])
    turn(driver, 'i1')
    await new Promise((resolve) => setImmediate(resolve))
    turn(driver, 'q1')
    await new Promise((resolve) => setImmediate(resolve))
    turn(driver, 'q2')

    expect(startedInputs(ctx, sessionId)).toEqual([['u1'], ['i1'], ['q1'], ['q2']])
    const cut = of(ctx.events(sessionId), 'turn.completed')[0]!
    expect(cut).toMatchObject({ status: 'interrupted', text: 'partial work' })
  })

  it('queues a second correction behind a pending one and stops only once', async () => {
    const ctx = setup(make())
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'q1', text: 'queued', delivery: 'queue' })
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'first fix', delivery: 'interrupt' })
    await ctx.service.send(sessionId, { inputId: 'i2', text: 'second fix', delivery: 'interrupt' })
    expect(driver.calls.filter((call) => call === 'interrupt')).toHaveLength(1)
    stopped(driver)
    await new Promise((resolve) => setImmediate(resolve))
    // Pending while the first correction is being started: still queued behind it.
    await ctx.service.send(sessionId, { inputId: 'i3', text: 'third fix', delivery: 'interrupt' })
    for (const id of ['i1', 'i2', 'i3', 'q1']) {
      turn(driver, id)
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(startedInputs(ctx, sessionId)).toEqual([['u1'], ['i1'], ['i2'], ['i3'], ['q1']])
    expect(driver.calls.filter((call) => call === 'interrupt')).toHaveLength(1)
  })

  it('retires an unresponsive provider and carries the correction and held inputs to a fresh process', async () => {
    const ctx = setup(make())
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'q1', text: 'queued', delivery: 'queue' })
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })
    ctx.clock.advance(1_000)
    await new Promise((resolve) => setImmediate(resolve))

    expect(driver.closed).toBe('user_stop')
    const fresh = ctx.factory.last
    expect(fresh).not.toBe(driver)
    expect(fresh.sent.map((input) => input.inputId)).toEqual(['i1'])
    turn(fresh, 'i1')
    await new Promise((resolve) => setImmediate(resolve))
    expect(fresh.sent.map((input) => input.inputId)).toEqual(['i1', 'q1'])
    const snapshot = ctx.service.snapshot(sessionId)
    expect(snapshot.turns[0]?.status).toBe('interrupted')
    expect(snapshot.inputs.q1?.state).not.toBe('interrupted')
    expect(snapshot.pendingInterruptions.inputIds).toEqual([])
  })

  it('holds the correction even when the stop request fails, and records why', async () => {
    const ctx = setup(make())
    const { sessionId, driver } = await running(ctx)
    driver.interrupt = async () => { driver.calls.push('interrupt'); throw new Error('rpc closed') }
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })
    expect(of(ctx.events(sessionId), 'provider.diagnostic').map((event) => event.code)).toContain('provider.interrupt_failed')
    driver.emit({ kind: 'turn.completed', status: 'completed', text: 'finished anyway', usage: {} })
    await new Promise((resolve) => setImmediate(resolve))
    expect(driver.sent.map((input) => input.inputId)).toEqual(['u1', 'i1'])
  })
})

describe('interrupt delivery — queueing provider without a primitive', () => {
  it.each([
    ['declared emulated', { interrupt: 'emulated' as const }],
    ['undeclared (older driver)', {}],
  ])('%s: stops through interrupt() and writes the input as a queued one', async (_name, caps) => {
    const ctx = setup(queueEmulated(caps))
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })
    expect(driver.calls).toEqual(['send:u1', 'interrupt', 'send:i1'])
    expect(driver.sent.at(-1)?.delivery).toBe('queue')
    stopped(driver)
    expect(ctx.service.snapshot(sessionId).turns[0]?.status).toBe('interrupted')
  })
})

describe('interrupt delivery — idle session', () => {
  it.each([
    ['native queue', nativeQueue],
    ['one turn per request', oneTurnNative],
    ['emulated', oneTurnEmulated],
  ])('%s: behaves like a queued send and never asks the provider to stop', async (_name, make) => {
    const ctx = setup(make())
    const sessionId = await open(ctx)
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'hello', delivery: 'interrupt' })
    const driver = ctx.factory.last
    expect(driver.calls).toEqual(['send:i1'])
    expect(driver.sent[0]?.delivery).toBe('queue')
    expect(of(ctx.events(sessionId), 'input.accepted')[0]).toMatchObject({ inputId: 'i1', delivery: 'interrupt' })
    turn(driver, 'i1')
    expect(ctx.service.snapshot(sessionId).turns.map((item) => item.status)).toEqual(['completed'])
  })

  it('is idempotent by input id like any send', async () => {
    const ctx = setup(nativeQueue())
    const { sessionId, driver } = await running(ctx)
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })
    await ctx.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })
    expect(driver.sent.filter((input) => input.inputId === 'i1')).toHaveLength(1)
  })
})

describe('interrupt delivery — host restart', () => {
  it('replays the journal without re-running the interrupted turn or resending a correction that had not started', async () => {
    const first = setup(oneTurnNative())
    const { sessionId, driver } = await running(first)
    await first.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })
    stopped(driver)
    // The host dies before the correction's turn/start was acknowledged.
    expect(first.service.snapshot(sessionId).inputs.i1?.state).toBe('accepted')

    const factory = oneTurnNative()
    const restarted = setup(factory, first.journal, first.clock)
    expect(restarted.service.recover()).toEqual([sessionId])
    const snapshot = restarted.service.snapshot(sessionId)
    expect(snapshot.turns.map((item) => item.status)).toEqual(['interrupted'])
    expect(of(restarted.events(sessionId), 'turn.completed')[0]?.text).toBe('partial work')
    expect(snapshot.inputs.i1).toMatchObject({ state: 'interrupted' })
    expect(factory.sessions).toHaveLength(0)

    await restarted.service.open({ driver: 'codex-like', model: 'm', cwd: '/repo', policy: { subagents: 'enabled' }, resume: { sessionId } })
    await restarted.service.send(sessionId, { inputId: 'u2', text: 'carry on', delivery: 'queue' })
    expect(factory.last.sent.map((input) => input.inputId)).toEqual(['u2'])
    expect(factory.last.sent[0]?.text).toContain('may not have reached you')
  })

  it('records a turn still being cut when the host died as interrupted by the restart', async () => {
    const first = setup(nativeQueue())
    const { sessionId } = await running(first)
    await first.service.send(sessionId, { inputId: 'i1', text: 'fix', delivery: 'interrupt' })

    const restarted = setup(nativeQueue(), first.journal, first.clock)
    restarted.service.recover()
    const snapshot = restarted.service.snapshot(sessionId)
    expect(snapshot.turns.map((item) => item.status)).toEqual(['interrupted'])
    expect(snapshot.inputs.i1?.state).toBe('interrupted')
    expect(of(restarted.events(sessionId), 'turn.completed')[0]).toMatchObject({ text: 'partial work' })
    expect(restarted.factory.sessions).toHaveLength(0)
  })
})
