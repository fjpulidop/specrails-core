import { describe, expect, it } from 'vitest'

import type { SessionEventBody } from '../domain/events.js'
import { DEFAULT_LIMITS } from '../domain/policy.js'
import { FakeClock, SequentialIds } from '../testing/fake-clock.js'
import { MemoryJournal } from '../testing/memory-journal.js'
import { ScriptedDriverFactory, catalogOf, descriptor, type ScriptedDriverSession } from '../testing/scripted-driver.js'
import { SessionService } from './session-service.js'

const tick = async () => { for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve)) }

/** A Codex-like parent (no autonomous continuation) and a Claude-like helper for delegated children. */
function setup(runtime: { maxConcurrent?: number } = {}) {
  const parentFactory = new ScriptedDriverFactory(descriptor('parent', { autonomousContinuation: false, nativeInputQueue: false }))
  const helperFactory = new ScriptedDriverFactory(descriptor('helper'))
  const journal = new MemoryJournal()
  const clock = new FakeClock()
  const service = new SessionService({ journal, drivers: catalogOf(parentFactory, helperFactory), clock, ids: new SequentialIds(), interruptGraceMs: 1_000 })
  const events = (sessionId: string) => journal.events(sessionId).map((envelope) => envelope.event as SessionEventBody)
  const open = async () => {
    const { sessionId } = await service.open({
      driver: 'parent', model: 'big', cwd: '/repo',
      policy: { subagents: 'enabled', permissions: 'bypass', mcp: { servers: [{ name: 'specrails', command: 'node', autoApprove: true }], inheritUserScope: true }, subagentRuntime: { mode: 'delegated', driver: 'helper', model: 'sonnet', effort: 'low', ...runtime } },
    })
    await service.send(sessionId, { inputId: 'u1', text: 'split the work', delivery: 'queue' })
    const parent = parentFactory.last
    parent.emit({ kind: 'input.receipt', inputId: 'u1', state: 'started' }, { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] })
    return { sessionId, parent }
  }
  return { service, journal, clock, events, parentFactory, helperFactory, open }
}

function finishParentTurn(parent: ScriptedDriverSession, text = 'delegated') {
  parent.emit({ kind: 'turn.completed', status: 'completed', text, usage: { costUsd: 0.01 } })
}

function childWorks(child: ScriptedDriverSession, inputId: string, result: string) {
  child.emit(
    { kind: 'input.receipt', inputId, state: 'started' },
    { kind: 'turn.started', trigger: 'input', inputIds: [inputId] },
    { kind: 'turn.tool', toolUseId: 't1', name: 'Read', phase: 'started' },
    { kind: 'turn.output', channel: 'text', delta: result },
    { kind: 'turn.completed', status: 'completed', text: result, usage: { costUsd: 0.05, outputTokens: 40 } },
  )
}

function of<T extends SessionEventBody['type']>(list: SessionEventBody[], type: T): Array<Extract<SessionEventBody, { type: T }>> {
  return list.filter((event): event is Extract<SessionEventBody, { type: T }> => event.type === type)
}

describe('Delegated sub-agents', () => {
  it('refuses to delegate when the provider launches sub-agents itself', async () => {
    const ctx = setup()
    const { sessionId } = await ctx.service.open({ driver: 'parent', model: 'big', cwd: '/repo', policy: { subagents: 'enabled' } })
    await expect(ctx.service.delegate(sessionId, { description: 'x', prompt: 'y' })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('runs a child session on the delegated driver and gives the result to the parent when nobody waits', async () => {
    const ctx = setup()
    const { sessionId, parent } = await ctx.open()
    const { subagentId } = await ctx.service.delegate(sessionId, { description: 'Review the API', prompt: 'Review api.ts', contextTurns: 2 })

    // The child: another driver, model and effort; the parent's cwd, permissions and MCP; no sub-agents of its own.
    const child = ctx.helperFactory.last
    expect(child.spec).toMatchObject({ cwd: '/repo', model: 'sonnet', effort: 'low', policy: { subagents: 'disabled', permissions: 'bypass', mcp: { servers: [{ name: 'specrails', autoApprove: true }] } } })
    expect(child.sent[0]?.text).toContain('User: split the work')
    expect(child.sent[0]?.text).toContain('Review api.ts')
    expect(ctx.service.snapshot(sessionId).subagents[subagentId]).toMatchObject({ description: 'Review the API', phase: 'running', delegated: { driver: 'helper', model: 'sonnet' }, agentType: 'helper:sonnet' })

    finishParentTurn(parent)
    childWorks(child, child.sent[0]!.inputId, 'API looks fine')
    await tick()
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    await tick()

    const events = ctx.events(sessionId)
    expect(of(events, 'subagent.output').map((event) => event.tool?.name ?? event.delta)).toEqual(['Read', 'API looks fine'])
    expect(of(events, 'subagent.usage')).toEqual([expect.objectContaining({ subagentId, billing: 'separate', usage: expect.objectContaining({ costUsd: 0.05 }) })])
    expect(ctx.service.snapshot(sessionId).subagents[subagentId]).toMatchObject({ phase: 'idle', resultSummary: 'API looks fine' })
    // The parent agent receives the result in a system turn (it cannot see delegated output natively).
    expect(parent.sent.at(-1)?.origin).toBe('system')
    expect(parent.sent.at(-1)?.text).toContain('Review the API (completed)\nAPI looks fine')
    // The child's work is done: its session is closed.
    expect(ctx.service.snapshot(subagentId).status).toBe('closed')
  })

  it('returns results to a waiting host and never injects them again', async () => {
    const ctx = setup()
    const { sessionId, parent } = await ctx.open()
    const { subagentId } = await ctx.service.delegate(sessionId, { description: 'Count files', prompt: 'count' })
    const child = ctx.helperFactory.last
    const waiting = ctx.service.waitSubagents(sessionId, undefined, 60_000)
    childWorks(child, child.sent[0]!.inputId, '42 files')
    await expect(waiting).resolves.toEqual({ results: [{ subagentId, description: 'Count files', status: 'completed', result: '42 files' }], running: [] })
    finishParentTurn(parent)
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    await tick()
    expect(parent.sent.filter((input) => input.origin === 'system')).toEqual([])
  })

  it('reports what still runs when a wait times out', async () => {
    const ctx = setup()
    const { sessionId } = await ctx.open()
    const { subagentId } = await ctx.service.delegate(sessionId, { description: 'Slow', prompt: 'slow' })
    await expect(ctx.service.waitSubagents(sessionId, [subagentId], 0)).resolves.toEqual({ results: [], running: [subagentId] })
  })

  it('caps concurrent delegations', async () => {
    const ctx = setup({ maxConcurrent: 1 })
    const { sessionId } = await ctx.open()
    await ctx.service.delegate(sessionId, { description: 'One', prompt: '1' })
    await expect(ctx.service.delegate(sessionId, { description: 'Two', prompt: '2' })).rejects.toMatchObject({ code: 'limit_reached' })
  })

  it('stops a delegated child through its own session', async () => {
    const ctx = setup()
    const { sessionId } = await ctx.open()
    const { subagentId } = await ctx.service.delegate(sessionId, { description: 'Long job', prompt: 'go' })
    await expect(ctx.service.stopSubagents(sessionId, [subagentId])).resolves.toEqual({ stopped: [subagentId] })
    expect(ctx.service.snapshot(sessionId).subagents[subagentId]).toMatchObject({ phase: 'stopped', reason: 'host_request' })
    expect(ctx.service.snapshot(subagentId).status).toBe('closed')
  })

  it('outlives the parent provider process', async () => {
    const ctx = setup()
    const { sessionId, parent } = await ctx.open()
    const { subagentId } = await ctx.service.delegate(sessionId, { description: 'Survivor', prompt: 'go' })
    finishParentTurn(parent)
    parent.emit({ kind: 'process.exited', exitCode: 1, signal: null })
    await tick()
    expect(ctx.service.snapshot(sessionId).subagents[subagentId]?.phase).toBe('running')
    const child = ctx.helperFactory.last
    childWorks(child, child.sent[0]!.inputId, 'still here')
    await tick()
    ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
    await tick()
    expect(ctx.service.snapshot(sessionId).subagents[subagentId]).toMatchObject({ phase: 'idle', resultSummary: 'still here' })
    // A new parent process starts to receive the result.
    expect(ctx.parentFactory.sessions).toHaveLength(2)
    expect(ctx.parentFactory.last.sent.at(-1)?.text).toContain('still here')
  })

  it('ends delegated work with the parent session', async () => {
    const ctx = setup()
    const { sessionId } = await ctx.open()
    const { subagentId } = await ctx.service.delegate(sessionId, { description: 'Bound', prompt: 'go' })
    await ctx.service.close(sessionId, 'conversation_deleted')
    expect(ctx.service.snapshot(subagentId).status).toBe('closed')
  })

  it('marks delegated work interrupted after a host restart and closes the orphaned child', async () => {
    const ctx = setup()
    const { sessionId, parent } = await ctx.open()
    const { subagentId } = await ctx.service.delegate(sessionId, { description: 'Orphan', prompt: 'go' })
    finishParentTurn(parent)
    // A new host on the same journal.
    const restarted = new SessionService({ journal: ctx.journal, drivers: catalogOf(ctx.parentFactory, ctx.helperFactory), clock: ctx.clock, ids: new SequentialIds() })
    restarted.recover('restart')
    expect(restarted.snapshot(sessionId).subagents[subagentId]).toMatchObject({ phase: 'interrupted', reason: 'restart' })
    expect(restarted.snapshot(subagentId).status).toBe('closed')
  })

  it('bounds continuation turns per user turn, not per session', async () => {
    const ctx = setup()
    const { sessionId, parent } = await ctx.open()
    let systemTurns = 0
    for (let round = 0; round < DEFAULT_LIMITS.maxSettleHandoffs + 2; round++) {
      await ctx.service.delegate(sessionId, { description: `Round ${round}`, prompt: 'go' })
      finishParentTurn(parent)
      const child = ctx.helperFactory.last
      childWorks(child, child.sent[0]!.inputId, `done ${round}`)
      await tick()
      ctx.clock.advance(DEFAULT_LIMITS.settleDebounceMs)
      await tick()
      const system = parent.sent.filter((input) => input.origin === 'system').length
      if (system > systemTurns) {
        systemTurns = system
        // The agent handles the results, then the user asks again (a new cycle).
        parent.emit({ kind: 'turn.started', trigger: 'input', inputIds: [parent.sent.at(-1)!.inputId] }, { kind: 'turn.completed', status: 'completed', text: 'ok', usage: {} })
      }
      const inputId = `u${round + 2}`
      await ctx.service.send(sessionId, { inputId, text: 'again', delivery: 'queue' })
      parent.emit({ kind: 'input.receipt', inputId, state: 'started' }, { kind: 'turn.started', trigger: 'input', inputIds: [inputId] })
    }
    expect(systemTurns).toBe(DEFAULT_LIMITS.maxSettleHandoffs + 2)
  })
})

