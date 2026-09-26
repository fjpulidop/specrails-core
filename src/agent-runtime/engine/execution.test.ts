import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NodeAdmission } from './contracts.js'
import { RunDatabase } from './checkpoint/database.js'
import { RunLease } from './checkpoint/lease.js'
import { RunLedger } from './checkpoint/ledger.js'
import { SqliteRunSaver } from './checkpoint/saver.js'
import { DefinitionExecution } from './execution.js'
import { EngineEventStream } from './events.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'engine-execution-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const db = await RunDatabase.open(path.join(directory, 'run.sqlite'), { create: true })
  cleanup.push(async () => db.close())
  RunLedger.initialize(db, { runId: 'run', workflowId: 'fixture', definitionHash: 'hash', definition: {}, request: {}, runtimeIdentity: {}, source: 'definition' })
  const token = new RunLease(db, 'run').acquire('owner'), ledger = new RunLedger(db, token, { maxTransitions: 10 })
  const events: unknown[] = [], stream = new EngineEventStream(cursor => ledger.events(cursor), event => events.push(event))
  const execution = new DefinitionExecution(ledger, stream, new AbortController().signal, 2)
  cleanup.push(async () => execution.close())
  const saver = new SqliteRunSaver(db, ledger, { onEvents: events => execution.committed(events) })
  return { db, ledger, execution, saver, events }
}
const admission = (id: string): NodeAdmission => ({ nodePath: id, kind: 'shell', effect: 'write', requiresAI: false,
  scope: { id: 'root', nodePathPrefix: '' }, task: { checkpointThreadId: 'run', checkpointId: 'checkpoint', taskCheckpointNs: id + ':task', taskId: id }, retry: { maxAttempts: 1 } })
const config = { configurable: { thread_id: 'run', checkpoint_ns: '', checkpoint_id: 'checkpoint' } }

it('keeps the repository write window through pending-write commit and releases it afterwards', async () => {
  const { execution, saver, ledger } = await fixture(), first = await execution.enter(admission('first')), second = await execution.enter(admission('second'))
  const firstResult = await execution.execute(first, 'write', async () => ({ outcome: 'next' }))
  let secondStarted = false
  const secondResult = execution.execute(second, 'write', async () => { secondStarted = true; return { outcome: 'next' } })
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(secondStarted).toBe(false)
  expect(ledger.resultFor(first)).toBeUndefined()
  await saver.putWrites(config, [['$commit', execution.terminal(first, firstResult)]], 'first')
  expect((await secondResult).outcome).toBe('next')
  expect(secondStarted).toBe(true)
})

it('completed outcomes replay without acquiring effect permits or executing providers again', async () => {
  const { execution, saver } = await fixture(), input = admission('work'), frame = await execution.enter(input)
  const result = await execution.execute(frame, 'write', async () => ({ outcome: 'next', output: 'once' }))
  await saver.putWrites(config, [['$commit', execution.terminal(frame, result)]], 'work')
  const replay = await execution.enter(input)
  expect(await execution.execute(replay, 'write', async () => { throw new Error('must never execute') })).toEqual(result)
})

it('coordinating components do not hold the child effect or AI windows', async () => {
  const { execution } = await fixture()
  const outer = await execution.enter({ ...admission('outer'), kind: 'component', effect: 'read', requiresAI: false })
  const result = await execution.execute(outer, 'read', async () => {
    const inner = await execution.enter(admission('inner'))
    return execution.execute(inner, 'write', async () => ({ outcome: 'next' }))
  })
  expect(result.outcome).toBe('next')
})
