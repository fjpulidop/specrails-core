import { SessionService } from '../application/session-service.js'
import { validateDescriptor } from '../domain/descriptor.js'
import type { SessionEventBody } from '../domain/events.js'
import { resolvePolicy } from '../domain/policy.js'
import type { DriverFactory } from '../ports.js'
import { FakeClock, SequentialIds } from './fake-clock.js'
import { MemoryJournal } from './memory-journal.js'
import { catalogOf } from './scripted-driver.js'

/**
 * Shared behavioural contract for every session driver (Liskov substitution:
 * the application must not care which provider it talks to). Framework-free:
 * each check throws on failure, so any test runner can execute it.
 */
export interface ConformanceHarness {
  /** A fresh factory whose provider answers one simple prompt with text and ends the turn. */
  factory(): DriverFactory
  /** Let the provider progress until it waits for input (e.g. a replay's idle point). */
  settle(factory: DriverFactory): Promise<void>
  /** Model to open sessions with. */
  model: string
  /** Sub-agent policy the scripted turn was recorded with. */
  subagents: 'enabled' | 'disabled'
}

export interface ConformanceCheck {
  name: string
  run(harness: ConformanceHarness): Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Driver conformance: ${message}`)
}

async function oneTurn(harness: ConformanceHarness) {
  const factory = harness.factory()
  const journal = new MemoryJournal()
  const service = new SessionService({ journal, drivers: catalogOf(factory), clock: new FakeClock(), ids: new SequentialIds() })
  const { sessionId } = await service.open({ driver: factory.descriptor.id, model: harness.model, cwd: process.cwd(), policy: { subagents: harness.subagents } })
  await service.send(sessionId, { inputId: 'conformance-1', text: 'Reply briefly.', delivery: 'queue' })
  await harness.settle(factory)
  const events = () => journal.events(sessionId).map((envelope) => envelope.event as SessionEventBody)
  return { factory, journal, service, sessionId, events }
}

export const DRIVER_CONFORMANCE: readonly ConformanceCheck[] = Object.freeze([
  {
    name: 'declares a valid, coherent descriptor',
    async run(harness) {
      validateDescriptor(harness.factory().descriptor)
    },
  },
  {
    name: 'refuses policies it cannot enforce instead of ignoring them',
    async run(harness) {
      const descriptor = harness.factory().descriptor
      const caps = descriptor.capabilities
      const refuses = (input: Parameters<typeof resolvePolicy>[0]) => {
        try { resolvePolicy(input, descriptor); return false } catch (error) { return (error as { code?: string }).code === 'policy_unenforceable' }
      }
      if (caps.subagents === 'supported') assert(refuses({ subagents: 'disabled' }) === !caps.subagentDisable, 'sub-agent disabling must match subagentDisable')
      assert(refuses({ subagents: 'disabled', tools: { mode: 'read-only' } }) === !caps.toolFiltering, 'tool filtering must match toolFiltering')
    },
  },
  {
    name: 'runs one user turn with ordered receipts and a terminal outcome',
    async run(harness) {
      const { events, service, sessionId } = await oneTurn(harness)
      const list = events()
      const types = list.map((event) => event.type)
      const index = (predicate: (event: SessionEventBody) => boolean) => list.findIndex(predicate)
      const accepted = index((event) => event.type === 'input.accepted')
      const started = index((event) => event.type === 'input.state' && event.state === 'started')
      const turnStarted = index((event) => event.type === 'turn.started')
      const turnDone = index((event) => event.type === 'turn.completed')
      assert(types.includes('session.process'), 'the provider process start is recorded')
      assert(accepted >= 0 && started > accepted, 'the input is accepted, then started')
      assert(turnStarted >= 0 && turnDone > turnStarted, 'the turn starts and completes')
      const turn = list[turnStarted] as Extract<SessionEventBody, { type: 'turn.started' }>
      assert(turn.origin === 'user' && turn.inputIds.includes('conformance-1'), 'the turn is a user turn bound to its input')
      const done = list[turnDone] as Extract<SessionEventBody, { type: 'turn.completed' }>
      assert(done.status === 'completed' && done.text.trim().length > 0, 'the turn completes with text')
      const snapshot = service.snapshot(sessionId)
      assert(snapshot.inputs['conformance-1']?.state === 'completed', 'the input completes with its turn')
      assert(snapshot.openTurn === null && snapshot.phase === 'idle', 'the session is idle after a turn without sub-agents')
    },
  },
  {
    name: 'reports usage according to its declared semantics',
    async run(harness) {
      const { events, factory } = await oneTurn(harness)
      const done = events().find((event): event is Extract<SessionEventBody, { type: 'turn.completed' }> => event.type === 'turn.completed')
      assert(done, 'a turn completed')
      const usage = factory.descriptor.capabilities.usage
      if (usage.costUsd === 'none') assert(done.usage.costUsd === null || done.usage.costEstimated, 'a driver without billed cost never reports billed USD')
      if (usage.tokens === 'none') assert(done.usage.inputTokens === null && done.usage.outputTokens === null, 'a driver without tokens reports none')
      for (const value of [done.usage.inputTokens, done.usage.outputTokens, done.usage.costUsd]) assert(value === null || (Number.isFinite(value) && value >= 0), 'usage values are null or non-negative')
    },
  },
  {
    name: 'closes idempotently and emits nothing afterwards',
    async run(harness) {
      const { service, sessionId, journal, factory } = await oneTurn(harness)
      await service.close(sessionId, 'conformance')
      await service.close(sessionId, 'conformance')
      const count = journal.events(sessionId).length
      await harness.settle(factory)
      assert(journal.events(sessionId).length === count, 'no events after close')
      assert(service.snapshot(sessionId).status === 'closed', 'the session is closed')
    },
  },
])
