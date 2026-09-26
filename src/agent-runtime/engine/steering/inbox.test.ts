import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RunDatabase } from '../checkpoint/database.js'
import { RunLedger } from '../checkpoint/ledger.js'
import { RunLease } from '../checkpoint/lease.js'
import { SqliteRunSaver } from '../checkpoint/saver.js'
import { ControlInbox, MAX_STEERING_BYTES, renderOperatorSteering } from './inbox.js'
import type { NodeAdmission } from '../contracts.js'

const clean: Array<() => Promise<void>> = []
afterEach(async () => { for (const task of clean.splice(0).reverse()) await task() })
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'engine inbox ')); clean.push(() => rm(dir, { recursive: true, force: true }))
  const db = await RunDatabase.open(path.join(dir, 'run.sqlite'), { create: true }); clean.push(async () => db.close())
  RunLedger.initialize(db, { runId: 'run', workflowId: 'fixture', definitionHash: 'hash', definition: {}, request: {}, runtimeIdentity: {}, source: 'definition' })
  const lease = new RunLease(db, 'run'), ledger = new RunLedger(db, lease.acquire('executor'), { maxTransitions: 10 })
  return { dir, db, lease, ledger, inbox: new ControlInbox(db, 'run') }
}
const node = (id: string, acceptsSteering = true): NodeAdmission => ({ nodePath: id, kind: 'prompt', effect: 'read', requiresAI: true, acceptsSteering,
  scope: { id: 'root', nodePathPrefix: '' }, task: { checkpointThreadId: 'run', taskCheckpointNs: id, checkpointId: 'checkpoint', taskId: id }, retry: { maxAttempts: 3 } })

describe('durable operator controls', () => {
  it('allows a separate writer under the execution lease and claims each message in the attempt transaction', async () => {
    const { db, ledger, inbox } = await fixture()
    const connection = await RunDatabase.open(db.filename); clean.push(async () => connection.close())
    const sender = new ControlInbox(connection, 'run')
    const message = sender.append('Keep acceptance tests intact', { requestId: 'message' })
    expect(sender.append('Keep acceptance tests intact', { requestId: 'message' })).toEqual(message)
    expect(() => sender.append('different', { requestId: 'message' })).toThrow('cannot change')
    const ineligible = ledger.enter(node('bookkeeping', false))
    expect(inbox.assigned(ineligible)).toEqual([])
    expect(inbox.pending()).toHaveLength(1)
    const frame = ledger.enter(node('agent'))
    expect(inbox.pending()).toEqual([])
    expect(inbox.assigned(frame)[0]).toMatchObject({ id: 'message', consumedByAttemptId: frame.attemptId })
    ledger.fail(frame, { code: 'provider_request_error', message: 'retry' }, true)
    const retry = ledger.enter(node('agent'))
    expect(inbox.assigned(retry)).toEqual([])
    expect(inbox.assigned(frame)).toHaveLength(1)
    expect(renderOperatorSteering(inbox.assigned(frame))).toContain('## Operator steering')
  })

  it('rolls claim back with admission and preserves claimed messages when the same human-paused attempt resumes', async () => {
    const { db, ledger, inbox } = await fixture()
    inbox.append('Use the same approved context', { requestId: 'one' })
    const prior = ledger.db.revision
    db.sqlite.exec("CREATE TRIGGER reject_admission BEFORE INSERT ON events WHEN NEW.type='step_started' BEGIN SELECT RAISE(ABORT,'injected admission failure'); END")
    expect(() => ledger.enter(node('human-agent'))).toThrow('injected admission failure')
    expect(db.revision).toBe(prior)
    expect(inbox.pending()).toHaveLength(1)
    expect(db.sqlite.prepare('SELECT * FROM attempts').all()).toEqual([])
    db.sqlite.exec('DROP TRIGGER reject_admission')
    const frame = ledger.enter(node('human-agent'))
    await new SqliteRunSaver(db, ledger).putWrites({ configurable: { thread_id: 'run', checkpoint_id: 'checkpoint' } },
      [['__interrupt__', { id: 'question', value: { kind: 'question', prompt: 'Continue?' } }]], 'human-agent')
    inbox.append('A message for the next new attempt')
    expect(ledger.enter(node('human-agent')).attemptId).toBe(frame.attemptId)
    expect(inbox.assigned(frame)).toHaveLength(1)
    expect(inbox.pending()).toHaveLength(1)
  })

  it('enforces UTF-8 size, run existence and durable cancellation without acquiring a lease', async () => {
    const { db, ledger, inbox } = await fixture()
    expect(() => inbox.append('é'.repeat(MAX_STEERING_BYTES / 2 + 1))).toThrow('UTF-8 bytes')
    expect(() => new ControlInbox(db, 'missing').append('hello')).toThrow('Run does not exist')
    const cancellation = inbox.cancel('stop')
    expect(inbox.cancel('stop')).toEqual(cancellation)
    expect(inbox.cancellationRequested()).toBe(true)
    expect(() => ledger.enter(node('after-cancel'))).toThrow('Cancellation requested')
    inbox.acknowledgeCancellation(ledger.token)
    expect(inbox.cancellationRequested()).toBe(false)
  })

  it('does not copy pending or previously claimed controls into a fork', async () => {
    const { db, dir, ledger, lease, inbox } = await fixture()
    inbox.append('original operator message')
    ledger.enter(node('original'))
    inbox.append('still pending')
    const cut = db.revision
    lease.release(ledger.token)
    const fork = await RunDatabase.open(path.join(dir, 'fork', 'run.sqlite'), { create: true }); clean.push(async () => fork.close())
    db.forkAt(fork, { revision: cut, runId: 'fork' })
    expect(fork.sqlite.prepare('SELECT * FROM control_inbox').all()).toEqual([])
  })
})
