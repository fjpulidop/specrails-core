import { expect, it } from 'vitest'
import { boundedJsonLine, EngineEventStream, projectDurableEvent } from './events.js'
import type { DurableEngineEvent, JsonObject } from './contracts.js'

it('projects ledger identity and nullable provider billing without losing node correlation', () => {
  const event: DurableEngineEvent = { sequence: 2, runId: 'run', type: 'efficiency_updated', timestamp: 'now', nodePath: 'review/turn', attemptId: 'attempt', branchId: 'one', payload: { provider: 'fake', usage: { costUsd: null } } }
  expect(projectDurableEvent(event)).toMatchObject({ type: 'runtime-efficiency-event', eventId: 'run:2', nodePath: 'review/turn', branch: 'one', payload: { usage: { costUsd: null } } })
  expect(projectDurableEvent({ ...event, type: 'step_succeeded', payload: { outcome: 'next' } })).toMatchObject({ type: 'workflow-event', event: { id: 'run:2', sequence: 2, outcome: 'next', stepId: 'review/turn' } })
})
it('streams committed events in order and isolates broken observers from execution', () => {
  const events: DurableEngineEvent[] = [1, 2].map(sequence => ({ sequence, runId: 'run', type: 'step_started', timestamp: 'now', payload: {} }))
  const observed: JsonObject[] = [], failures: unknown[] = []
  const stream = new EngineEventStream(after => events.filter(event => event.sequence > after), event => {
    observed.push(event); if (observed.length === 1) throw new Error('detached UI')
  }, 0, error => failures.push(error))
  stream.flush(); stream.flush()
  expect(observed).toHaveLength(2); expect(failures).toHaveLength(1)
  stream.progress({ type: 'verification-output', payload: { text: 'line' } })
  expect(observed.at(-1)).toEqual({ type: 'verification-output', text: 'line' })
})
it('bounds hostile log strings before serializing without malformed JSON lines', () => {
  const line = boundedJsonLine({ type: 'agent-event', text: '\n"'.repeat(600_000) })
  expect(line.length).toBeLessThan(1_000_000)
  expect(JSON.parse(line).text).toContain('[output truncated]')
  expect(() => boundedJsonLine({ text: 'value' }, 2)).toThrow()
})
