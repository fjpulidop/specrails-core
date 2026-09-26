import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Annotation, Command, END, interrupt, Send, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph'
import { EphemeralValue } from '@langchain/langgraph/channels'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import type { JsonValue, NodeAdmission, TerminalCommit } from '../contracts.js'
import { RunDatabase } from './database.js'
import { RunLease } from './lease.js'
import { RunLedger } from './ledger.js'
import { SqliteRunSaver } from './saver.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(options: { maxTransitions?: number; maxTokens?: number; maxCostUsd?: number; now?: () => number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'engine checkpoint with spaces '))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const db = await RunDatabase.open(path.join(dir, 'run.sqlite'), { create: true })
  cleanup.push(async () => db.close())
  RunLedger.initialize(db, { runId: 'run', workflowId: 'fixture', definitionHash: 'hash', definition: {}, request: {}, runtimeIdentity: {}, source: 'definition',
    budget: { ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }), ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }) } })
  const lease = new RunLease(db, 'run', options.now), token = lease.acquire('first-owner')
  const ledger = new RunLedger(db, token, { maxTransitions: options.maxTransitions ?? 10, now: options.now })
  return { db, dir, lease, ledger, token }
}
const admission = (taskId = 'task', nodePath = 'work', overrides: Partial<NodeAdmission> = {}): NodeAdmission => ({
  nodePath, kind: 'prompt', effect: 'read', requiresAI: true, scope: { id: 'root', nodePathPrefix: '' },
  task: { checkpointThreadId: 'run', checkpointId: 'checkpoint', taskCheckpointNs: `${nodePath}:${taskId}`, taskId },
  retry: { maxAttempts: 3 }, ...overrides,
})
const config = { configurable: { thread_id: 'run', checkpoint_ns: '', checkpoint_id: 'checkpoint' } }

describe('durable checkpoint and ledger boundary', () => {
  it('rolls back pending writes, terminal result and event sequence as one transaction', async () => {
    const { db, ledger } = await fixture(), frame = ledger.enter(admission())
    const marker = ledger.terminal(frame, { outcome: 'done', output: { kept: true } }), before = ledger.events(), revision = db.revision
    const broken = new SqliteRunSaver(db, ledger, { fault: phase => { if (phase === 'between-writes-ledger') throw Error('injected failure') } })
    await expect(broken.putWrites(config, [['value', 1], ['$commit', marker]], 'task')).rejects.toThrow('injected failure')
    expect(db.sqlite.prepare('SELECT * FROM writes').all()).toHaveLength(0)
    expect(ledger.resultFor(frame)).toBeUndefined()
    expect(ledger.events()).toEqual(before)
    expect(db.revision).toBe(revision)
    const saver = new SqliteRunSaver(db, ledger)
    await saver.putWrites(config, [['value', 1], ['$commit', marker]], 'task')
    expect(ledger.resultFor(frame)).toEqual({ outcome: 'done', output: { kept: true } })
    expect(ledger.events().filter(event => event.type === 'step_succeeded')).toHaveLength(1)
    expect(db.sqlite.prepare('SELECT saver_checkpoint_ns FROM visits').get()?.saver_checkpoint_ns).toBe('')
    expect(db.sqlite.prepare('SELECT checkpoint_ns FROM visits').get()?.checkpoint_ns).toBe('work:task')
    await saver.putWrites(config, [['value', 1], ['$commit', marker]], 'task')
    expect(ledger.events().filter(event => event.type === 'step_succeeded')).toHaveLength(1)
    await expect(saver.putWrites(config, [['value', 2], ['$commit', marker]], 'task')).rejects.toThrow('cannot change')
    db.checkIntegrity()
  })

  it('opens status connections without changing file/directory metadata or allowing writes', async () => {
    const { db, dir } = await fixture()
    db.close()
    const before = { file: statSync(db.filename), directory: statSync(dir) }
    const reader = await RunDatabase.open(db.filename, { readOnly: true })
    try {
      expect(reader.get('runs', { run_id: 'run' })?.run_id).toBe('run')
      expect(() => reader.transaction('forbidden', () => {})).toThrow()
    } finally { reader.close() }
    const after = { file: statSync(db.filename), directory: statSync(dir) }
    expect(after.file.mode).toBe(before.file.mode)
    expect(after.file.ctimeMs).toBe(before.file.ctimeMs)
    expect(after.directory.mode).toBe(before.directory.mode)
    // Read-only WAL access may create SQLite sidecars; it cannot chmod the existing directory.
  })

  it('replays a failed outcome across lease epochs after exact budget exhaustion without charging or re-terminalizing', async () => {
    const { db, lease, ledger, token } = await fixture({ maxTokens: 1 }), input = admission(), frame = ledger.enter(input)
    ledger.startInvocation(frame, { invocationId: 'call', provider: 'fixture' }, { maxTokens: 1 })
    ledger.settleInvocation(frame, { invocationId: 'call', provider: 'fixture', status: 'failed', durationMs: 1, toolCalls: 0,
      usage: { costUsd: null, inputTokens: 1, outputTokens: 0 } })
    const marker = ledger.terminal(frame, { outcome: 'repair', status: 'failed', error: { code: 'bad_candidate', message: 'Fix it' } })
    await new SqliteRunSaver(db, ledger).putWrites(config, [['value', 'repair'], ['$commit', marker]], 'task')
    lease.release(token)
    const resumed = new RunLedger(db, lease.acquire('second-owner'), { maxTransitions: 1 })
    const replay = resumed.enter(input), before = resumed.events().length
    expect(replay).toEqual(frame)
    expect(resumed.terminal(replay, resumed.resultFor(replay)!)).toEqual(marker)
    await new SqliteRunSaver(db, resumed).putWrites(config, [['value', 'repair'], ['$commit', marker]], 'task')
    expect(resumed.events()).toHaveLength(before)
    expect(resumed.usage()).toMatchObject({ invocations: 1, inputTokens: 1, costUsd: null })
  })

  it('fences late writes, keeps the global visit count and requires explicit recovery for uncertain writes', async () => {
    let now = Date.now()
    const { db, ledger, lease } = await fixture({ maxTransitions: 1, now: () => now })
    const input = admission('write-task', 'write', { effect: 'write', retry: { maxAttempts: 1 } }), frame = ledger.enter(input)
    now += 86_400_000
    expect(ledger.activeDurationMs()).toBe(60_000)
    const next = new RunLedger(db, lease.acquire('replacement'), { maxTransitions: 1, now: () => now })
    expect(() => ledger.terminal(frame, { outcome: 'done' })).toThrow('expired or was replaced')
    expect(() => next.enter(input)).toThrow('explicit recovery')
    next.authorizeRecovery(frame.attemptId)
    const recovered = next.enter(input)
    expect(recovered).toMatchObject({ visit: 1, transition: 1, attempt: 2 })
    expect(() => next.enter(admission('different'))).toThrow('global node visits')
    expect(next.events().filter(event => event.type === 'lease_recovered')).toHaveLength(1)
  })

  it('shares role sessions only within an ancestor scope while preserving the actual attempt fence', async () => {
    const { ledger } = await fixture(), scope = { id: 'implementation-one', nodePathPrefix: 'implement/' }
    const developer = ledger.enter(admission('developer', 'implement/developer', { scope }))
    const fixer = ledger.enter(admission('fixer', 'implement/fixer', { scope }))
    ledger.writeScopedPieceState(developer, scope.nodePathPrefix, 'session:roles', { developer: 'session-one' })
    expect(ledger.readScopedPieceState(fixer, 'implement', 'session:roles')).toEqual({ developer: 'session-one' })
    const sibling = ledger.enter(admission('other', 'implement/fixer', { scope: { ...scope, id: 'implementation-two' } }))
    expect(ledger.readScopedPieceState(sibling, 'implement', 'session:roles')).toBeUndefined()
    expect(() => ledger.writeScopedPieceState(fixer, 'other', 'session:roles', {})).toThrow('ancestor node owner')
    expect(() => ledger.writeScopedPieceState(fixer, 'implement', 'memo:provider', {})).toThrow('ancestor node owner')
    expect(() => ledger.writeScopedPieceState({ ...fixer, leaseEpoch: -1 }, 'implement', 'session:roles', {})).toThrow('fenced execution')
  })

  it('reserves one shared budget and preserves unknown usage under repeated settlement', async () => {
    const { ledger } = await fixture({ maxTokens: 10 })
    const first = ledger.enter(admission('a')), second = ledger.enter(admission('b', 'parallel', { scope: { id: 'branch-1', nodePathPrefix: '', branchId: 'one' } }))
    expect(ledger.scopeSnapshot('*').attempts).toHaveLength(2)
    expect(ledger.scopeSnapshot('root').attempts).toHaveLength(1)
    ledger.startInvocation(first, { invocationId: 'first-call', provider: 'fixture' }, { maxTokens: 6 })
    expect(() => ledger.startInvocation(second, { invocationId: 'second-call', provider: 'fixture' }, { maxTokens: 6 })).toThrow('shared budget')
    const result = { invocationId: 'first-call', provider: 'fixture', status: 'succeeded' as const, durationMs: 5, toolCalls: 0,
      usage: { costUsd: null, inputTokens: 2, outputTokens: null } }
    ledger.settleInvocation(first, result); ledger.settleInvocation(first, result)
    expect(ledger.usage()).toMatchObject({ invocations: 1, costUsd: null, inputTokens: 2, outputTokens: null, knownInputTokens: 2 })
    expect(ledger.events().filter(event => event.type === 'efficiency_updated')).toHaveLength(1)
    expect(ledger.reservationStatus()).toMatchObject({ pendingInvocations: 0, knownTokens: 4, costUnknown: true })
    expect(() => ledger.startInvocation(second, { invocationId: 'second-call', provider: 'fixture' }, { maxTokens: 6 })).toThrow('shared budget')
    ledger.startInvocation(second, { invocationId: 'second-call', provider: 'fixture' }, { maxTokens: 4 })
  })

  it('retains an unreported cost bound while releasing fully reported tokens', async () => {
    const { ledger } = await fixture({ maxTokens: 10, maxCostUsd: 1 }), frame = ledger.enter(admission())
    ledger.startInvocation(frame, { invocationId: 'unreported-cost', provider: 'fixture' }, { maxTokens: 10, maxCostUsd: 0.8 })
    ledger.settleInvocation(frame, { invocationId: 'unreported-cost', provider: 'fixture', status: 'succeeded', durationMs: 1, toolCalls: 0,
      usage: { costUsd: null, inputTokens: 1, outputTokens: 1 } })
    expect(ledger.reservationStatus()).toMatchObject({ pendingInvocations: 0, knownTokens: 0, knownCostUsd: 0.8 })
    expect(ledger.usage()).toMatchObject({ inputTokens: 1, outputTokens: 1, costUsd: null, knownCostUsd: 0 })
    expect(() => ledger.startInvocation(frame, { invocationId: 'too-much', provider: 'fixture' }, { maxTokens: 1, maxCostUsd: 0.3 })).toThrow('shared budget')
    ledger.startInvocation(frame, { invocationId: 'remaining', provider: 'fixture' }, { maxTokens: 8, maxCostUsd: 0.1 })
    ledger.settleInvocation(frame, { invocationId: 'remaining', provider: 'fixture', status: 'succeeded', durationMs: 1, toolCalls: 0,
      usage: { costUsd: 0.05, inputTokens: 1, outputTokens: 1 } })
    expect(ledger.reservationStatus()).toMatchObject({ pendingInvocations: 0, knownTokens: 0, knownCostUsd: 0.8 })
    expect(ledger.usage()).toMatchObject({ costUsd: null, knownCostUsd: 0.05 })
  })

  it('installs only full valid receipts and retains failed verification evidence without certifying it', async () => {
    const { db, ledger } = await fixture(), saver = new SqliteRunSaver(db, ledger)
    const verified = ledger.enter(admission('verify', 'verify', { kind: 'verify', effect: 'write', requiresAI: false }))
    const first = ledger.terminal(verified, { outcome: 'pass', candidate: { hash: 'one', revision: 1, atTransition: verified.transition },
      verified: { receiptId: 'full', candidateHash: 'one', revision: 1, atTransition: verified.transition },
      receipt: { id: 'full', candidateHash: 'one', valid: true, scope: 'full', evidence: { commands: [{ exitCode: 0 }] } } })
    await saver.putWrites(config, [['$commit', first]], 'verify')
    expect(ledger.scopeSnapshot('root').verified?.receiptId).toBe('full')
    const scoped = ledger.enter(admission('scoped', 'scoped', { requiresAI: false }))
    await saver.putWrites(config, [['$commit', ledger.terminal(scoped, { outcome: 'pass', receipt: { id: 'scoped', candidateHash: 'one', valid: true, scope: 'scoped', evidence: {} } })]], 'scoped')
    expect(ledger.scopeSnapshot('root').verified?.receiptId).toBe('full')
    const shell = ledger.enter(admission('shell', 'shell', { kind: 'shell', requiresAI: false }))
    const shellReceipt = { id: 'shell', candidateHash: 'one', valid: true, scope: 'full' as const, evidence: { commands: [{ exitCode: 0 }] } }
    await expect(saver.putWrites(config, [['$commit', ledger.terminal(shell, { outcome: 'pass', receipt: shellReceipt,
      verified: { receiptId: 'shell', candidateHash: 'one', revision: 1, atTransition: shell.transition } })]], 'shell')).rejects.toThrow('authorized full verification')
    await saver.putWrites(config, [['$commit', ledger.terminal(shell, { outcome: 'pass', receipt: shellReceipt, verified: null })]], 'shell')
    expect(ledger.scopeSnapshot('root').verified).toBeNull()
    const failing = ledger.enter(admission('failing', 'failing', { effect: 'write', requiresAI: false }))
    expect(ledger.scopeSnapshot('root').verified).toBeNull()
    await saver.putWrites(config, [['$commit', ledger.terminal(failing, { outcome: 'repair', status: 'failed', candidate: { hash: 'changed-during-check', revision: 2, atTransition: failing.transition },
      receipt: { id: 'failed', candidateHash: 'one', valid: false, scope: 'full', evidence: { failures: ['compile'] } } })]], 'failing')
    expect(db.get('receipts', { receipt_id: 'failed' })).toMatchObject({ valid: 0, candidate_hash: 'one' })
    expect(ledger.scopeSnapshot('root').verified).toBeNull()
    expect(ledger.resultFor(failing)?.outcome).toBe('repair')
  })

  it.each([{ commands: [] }, { commands: [{ exitCode: 0 }], unverifiedRepositories: ['missing'] }, { commands: [{ exitCode: 0 }], unverifiedRepositories: 'invalid' }])('rejects an uncertified full receipt atomically: %j', async evidence => {
    const { db, ledger } = await fixture(), saver = new SqliteRunSaver(db, ledger)
    const frame = ledger.enter(admission('verify', 'verify', { kind: 'verify', effect: 'write', requiresAI: false }))
    const marker = ledger.terminal(frame, { outcome: 'pass', candidate: { hash: 'candidate', revision: 1, atTransition: frame.transition },
      receipt: { id: 'bad', candidateHash: 'candidate', valid: true, scope: 'full', evidence: JSON.parse(JSON.stringify(evidence)) as JsonValue },
      verified: { receiptId: 'bad', candidateHash: 'candidate', revision: 1, atTransition: frame.transition } })
    await expect(saver.putWrites(config, [['$commit', marker]], 'verify')).rejects.toThrow('authorized full verification')
    expect(ledger.resultFor(frame)).toBeUndefined()
    expect(ledger.scopeSnapshot().verified).toBeNull()
    expect(db.get('receipts', { receipt_id: 'bad' })).toBeUndefined()
    expect(db.sqlite.prepare('SELECT * FROM writes').all()).toHaveLength(0)
  })

  it('excludes human pause time and commits provider memo with usage in one transaction', async () => {
    let now = Date.now()
    const { db, ledger, lease, token } = await fixture({ now: () => now }), input = admission(), frame = ledger.enter(input)
    ledger.startInvocation(frame, { invocationId: 'memo-call', provider: 'fixture' })
    const result = { invocationId: 'memo-call', provider: 'fixture', status: 'succeeded' as const, durationMs: 1, toolCalls: 0,
      usage: { costUsd: null, inputTokens: 1, outputTokens: 0 } }
    expect(() => ledger.settleInvocation(frame, result, { key: 'memo:bad', value: 'x'.repeat(2 * 1024 * 1024) })).toThrow('exceeds 2 MiB')
    expect(db.get('invocations', { invocation_id: 'memo-call' })?.status).toBe('running')
    expect(ledger.usage().knownInputTokens).toBe(0)
    ledger.settleInvocation(frame, result, { key: 'memo:good', value: { answer: 'saved' } })
    expect(ledger.readPieceState(frame, 'memo:good')).toEqual({ answer: 'saved' })
    expect(() => ledger.writePieceState(frame, 'memo:good', { answer: 'changed' })).toThrow('cannot change')
    now += 100
    await new SqliteRunSaver(db, ledger).putWrites(config, [['__interrupt__', { id: 'human', value: { kind: 'question', prompt: 'Continue?' } }]], 'task')
    lease.release(token)
    now += 86_400_000
    const resumed = new RunLedger(db, lease.acquire('resumed'), { maxTransitions: 10, now: () => now })
    expect(resumed.activeDurationMs()).toBe(100)
    expect(resumed.pendingInterrupts()).toMatchObject([{ id: 'human', attemptId: frame.attemptId }])
    expect(() => resumed.answerInterrupts({ human: 'yes', unknown: 'no' })).toThrow('unknown interrupt')
    expect(resumed.pendingInterrupts()).toHaveLength(1)
    resumed.answerInterrupts({ human: 'yes' }); resumed.answerInterrupts({ human: 'yes' })
    expect(resumed.pendingInterrupts()).toHaveLength(0)
    expect(resumed.interrupts()).toMatchObject([{ id: 'human', answer: 'yes' }])
    expect(resumed.events().filter(event => event.type === 'interrupt_answered')).toHaveLength(1)
    expect(() => resumed.answerInterrupts({ human: 'no' })).toThrow('cannot change')
    expect(resumed.enter(input)).toMatchObject({ attemptId: frame.attemptId, attempt: 1, visit: 1 })
    expect(resumed.activeDurationMs()).toBe(100)
  })

  it('keeps checkpoint serializer types, parent history and overwritten writes in historical cuts', async () => {
    const { db, ledger, dir } = await fixture(), saver = new SqliteRunSaver(db, ledger), checkpoint = emptyCheckpoint()
    checkpoint.channel_values = { bytes: new Uint8Array([0, 10, 255]) }
    const first = await saver.put({ configurable: { thread_id: 'run', checkpoint_ns: 'child' } }, checkpoint, { source: 'input', step: 0, parents: {} })
    await saver.putWrites(first, [['__error__', 'before']], 'task')
    const cut = db.revision
    await saver.putWrites(first, [['__error__', 'after']], 'task')
    const tuple = await saver.getTuple(first)
    expect(tuple?.checkpoint.channel_values.bytes).toEqual(new Uint8Array([0, 10, 255]))
    expect(tuple?.pendingWrites?.[0][2]).toBe('after')
    const oldRows = db.transaction(undefined, () => db.rowsAt(cut))
    const old = oldRows.find(row => row.table === 'writes')!.row
    expect(await saver.serde.loadsTyped(String(old.type), old.value as Uint8Array)).toBe('before')
    expect(db.sqlite.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(db.filename).mode & 0o777).toBe(0o600)
    }
  })

  it('uses real public task identity through LangGraph retry, interrupt and resume', async () => {
    const { db, ledger } = await fixture(), saver = new SqliteRunSaver(db, ledger, { onEvents: () => { throw Error('transport disconnected') } })
    const state = Annotation.Root({ value: Annotation<string>(), $commit: new EphemeralValue<TerminalCommit>(false) })
    let physicalCalls = 0
    const graph = new StateGraph(state).addNode('work', (_state, runtime) => {
      const info = runtime.executionInfo!
      const frame = ledger.enter(admission(info.taskId, 'work', { task: { checkpointThreadId: info.threadId!, checkpointId: info.checkpointId, taskCheckpointNs: info.checkpointNs, taskId: info.taskId } }))
      if (++physicalCalls === 1) { ledger.fail(frame, { code: 'provider_request_error', message: 'retry' }, true); throw Error('retry') }
      return { value: 'worked', $commit: ledger.terminal(frame, { outcome: 'done', output: 'worked' }) }
    }, { retryPolicy: { maxAttempts: 2, initialInterval: 1, jitter: false, retryOn: () => true } }).addNode('ask', (_state, runtime) => {
      const info = runtime.executionInfo!
      const frame = ledger.enter(admission(info.taskId, 'ask', { requiresAI: false, task: { checkpointThreadId: info.threadId!, checkpointId: info.checkpointId, taskCheckpointNs: info.checkpointNs, taskId: info.taskId } }))
      const answer = interrupt<unknown, string>({ kind: 'question', prompt: 'Continue?', attemptId: frame.attemptId })
      return { value: answer, $commit: ledger.terminal(frame, { outcome: 'answered', output: answer }) }
    }).addEdge(START, 'work').addEdge('work', 'ask').addEdge('ask', END).compile({ checkpointer: saver })
    const invocation = { configurable: { thread_id: 'run' }, durability: 'sync' as const }
    await graph.invoke({}, invocation)
    expect(ledger.scopeSnapshot('root').attempts.map(row => row.status)).toEqual(['failed', 'succeeded', 'paused'])
    const interrupted = await graph.getState(invocation)
    const id = interrupted.tasks.flatMap(task => task.interrupts ?? [])[0].id
    const result = await graph.invoke(new Command({ resume: { [id!]: 'approved' } }), invocation)
    expect(result.value).toBe('approved')
    expect(physicalCalls).toBe(2)
    expect(db.sqlite.prepare('SELECT COUNT(*) count FROM visits').get()?.count).toBe(2)
    expect(db.sqlite.prepare('SELECT COUNT(*) count FROM attempts').get()?.count).toBe(3)
    expect(ledger.events().filter(event => event.type === 'step_succeeded')).toHaveLength(2)
  })

  it('keeps an uncertain write pending as __error__ and executes it only after explicit recovery', async () => {
    const { db, ledger } = await fixture(), saver = new SqliteRunSaver(db, ledger)
    const state = Annotation.Root({ value: Annotation<string>(), $commit: new EphemeralValue<TerminalCommit>(false) })
    let calls = 0
    const graph = new StateGraph(state).addNode('write', (_state, runtime) => {
      const info = runtime.executionInfo!, frame = ledger.enter(admission(info.taskId, 'write', { effect: 'write', task: {
        checkpointThreadId: info.threadId!, checkpointId: info.checkpointId, taskCheckpointNs: info.checkpointNs, taskId: info.taskId } }))
      if (++calls === 1) { ledger.prepareInterruption(frame, { code: 'aborted', message: 'uncertain write' }); throw Error('uncertain write') }
      return { value: 'recovered', $commit: ledger.terminal(frame, { outcome: 'done' }) }
    }).addEdge(START, 'write').addEdge('write', END).compile({ checkpointer: saver })
    const invocation = { configurable: { thread_id: 'run' }, durability: 'sync' as const }
    await expect(graph.invoke({}, invocation)).rejects.toThrow('uncertain write')
    const prior = ledger.scopeSnapshot('root').attempts[0]
    expect(prior.status).toBe('interrupted')
    expect(ledger.resultFor(prior.frame)).toBeUndefined()
    expect(db.sqlite.prepare("SELECT COUNT(*) count FROM writes WHERE channel='$commit'").get()?.count).toBe(0)
    await expect(graph.invoke(null, invocation)).rejects.toThrow('explicit recovery')
    expect(calls).toBe(1)
    ledger.authorizeRecovery(prior.frame.attemptId)
    expect((await graph.invoke(null, invocation)).value).toBe('recovered')
    expect(calls).toBe(2)
  })

  it('forks an exact parent graph cut with historical blobs and usage, preserving the source and completed prefix', async () => {
    const { db, ledger, lease, token, dir } = await fixture()
    const physical = { before: 0, after: 0 }
    const make = (active: RunLedger, saver: SqliteRunSaver) => {
      const state = Annotation.Root({ values: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }), $commit: new EphemeralValue<TerminalCommit>(false) })
      const execute = (node: 'before' | 'ask' | 'after') => (_state: typeof state.State, runtime: LangGraphRunnableConfig) => {
        const info = runtime.executionInfo!, frame = active.enter(admission(info.taskId, node, { requiresAI: node === 'before', task: {
          checkpointThreadId: info.threadId!, checkpointId: info.checkpointId, taskCheckpointNs: info.checkpointNs, taskId: info.taskId } }))
        if (node === 'ask') interrupt('Continue?')
        else physical[node]++
        if (node === 'before') {
          active.writePieceState(frame, 'session:roles', { sessionId: 'do-not-reuse' })
          active.startInvocation(frame, { invocationId: 'original-call', provider: 'fixture' })
          active.settleInvocation(frame, { invocationId: 'original-call', provider: 'fixture', status: 'succeeded', durationMs: 2, toolCalls: 0,
            usage: { costUsd: null, inputTokens: 5, outputTokens: 1 } }, { key: 'memo:before', value: { approvedContext: true } })
        }
        return { values: [node], $commit: active.terminal(frame, { outcome: 'done', output: node }) }
      }
      return new StateGraph(state).addNode('before', execute('before')).addNode('ask', execute('ask')).addNode('after', execute('after'))
        .addEdge(START, 'before').addEdge('before', 'ask').addEdge('ask', 'after').addEdge('after', END).compile({ checkpointer: saver })
    }
    const original = make(ledger, new SqliteRunSaver(db, ledger)), invocation = { configurable: { thread_id: 'run' }, durability: 'sync' as const }
    await original.invoke({}, invocation)
    const cut = Number(db.sqlite.prepare("SELECT before_revision FROM visits WHERE node_path='ask'").get()!.before_revision)
    await original.invoke(new Command({ resume: 'yes' }), invocation)
    lease.release(token)
    const sourceVersions = db.sqlite.prepare('SELECT * FROM row_versions ORDER BY revision,table_name,row_key').all()
    const fork = await RunDatabase.open(path.join(dir, 'fork', 'run.sqlite'), { create: true }); cleanup.push(async () => fork.close())
    expect(db.forkAt(fork, { revision: cut, runId: 'fork' }).checkpointThreadId).toBe('run')
    expect(db.sqlite.prepare('SELECT * FROM row_versions ORDER BY revision,table_name,row_key').all()).toEqual(sourceVersions)
    const forkLedger = new RunLedger(fork, new RunLease(fork, 'fork').acquire('fork-owner'), { maxTransitions: 10 })
    expect(forkLedger.usage()).toMatchObject({ knownInputTokens: 5, knownOutputTokens: 1, costUsd: null })
    expect(forkLedger.events().map(event => event.type)).toEqual(['workflow_forked'])
    expect(fork.sqlite.prepare("SELECT key FROM piece_state WHERE key LIKE 'session:%'").all()).toEqual([])
    expect(fork.sqlite.prepare("SELECT key FROM piece_state WHERE key LIKE 'memo:%'").all()).toHaveLength(1)
    const resumed = make(forkLedger, new SqliteRunSaver(fork, forkLedger))
    await resumed.invoke(null, invocation)
    const result = await resumed.invoke(new Command({ resume: 'yes' }), invocation)
    expect(result.values).toEqual(['before', 'ask', 'after'])
    expect(physical).toEqual({ before: 1, after: 2 })
    expect(forkLedger.events().filter(event => event.type === 'efficiency_updated')).toHaveLength(0)
    fork.checkIntegrity()
  })

  it('preserves completed siblings and internal namespaces when forking before a nested interrupted visit', async () => {
    const { db, ledger, lease, token, dir } = await fixture({ maxTransitions: 20 })
    const calls = new Map<string, number>()
    const count = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1)
    const make = (active: RunLedger, saver: SqliteRunSaver) => {
      const Child = Annotation.Root({ item: Annotation<number>(), completed: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }), $commit: new EphemeralValue<TerminalCommit>(false) })
      const input = (node: string, item: number, runtime: LangGraphRunnableConfig) => {
        const info = runtime.executionInfo!
        return admission(info.taskId, `branch/${node}`, { requiresAI: false, scope: { id: `branch-${item}`, nodePathPrefix: 'branch', branchId: String(item) }, task: {
          checkpointThreadId: info.threadId!, checkpointId: info.checkpointId, taskCheckpointNs: info.checkpointNs, taskId: info.taskId } })
      }
      const child = new StateGraph(Child).addNode('prepare', async (state, runtime) => {
        const frame = active.enter(input('prepare', state.item, runtime)); count(`prepare-${state.item}`)
        // Force a meaningful cut: branch zero must already have durable parent pending writes.
        if (state.item === 1) {
          let ready = false
          for (let attempts = 0; attempts < 100 && !ready; attempts++) {
            const root = await saver.getTuple({ configurable: { thread_id: 'run' } })
            ready = !!root?.pendingWrites?.some(([, channel, value]) => channel === 'completed' && Array.isArray(value) && value.includes('answer-0'))
            if (!ready) await new Promise(resolve => setTimeout(resolve, 1))
          }
          expect(ready).toBe(true)
        }
        return { completed: [`prepare-${state.item}`], $commit: active.terminal(frame, { outcome: 'ready' }) }
      }).addNode('ask', (state, runtime) => {
        const frame = active.enter(input('ask', state.item, runtime)); count(`ask-${state.item}`)
        if (state.item === 1) interrupt({ question: 'Approve branch one?' })
        return { completed: [`answer-${state.item}`], $commit: active.terminal(frame, { outcome: 'done' }) }
      }).addEdge(START, 'prepare').addEdge('prepare', 'ask').addEdge('ask', END).compile()
      const Parent = Annotation.Root({ completed: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }) })
      return new StateGraph(Parent).addNode('branch', child).addNode('join', () => { count('join'); return { completed: ['join'] } }, { defer: true })
        .addConditionalEdges(START, () => [0, 1].map(item => new Send('branch', { item, completed: [] })), ['branch'])
        .addEdge('branch', 'join').addEdge('join', END).compile({ checkpointer: saver })
    }
    const saver = new SqliteRunSaver(db, ledger), graph = make(ledger, saver), invocation = { configurable: { thread_id: 'run' }, durability: 'sync' as const }
    await graph.invoke({}, invocation)
    const cut = Number(db.sqlite.prepare("SELECT before_revision FROM visits WHERE node_path='branch/ask' AND scope_id='branch-1'").get()!.before_revision)
    const paused = await graph.getState(invocation), interruptId = paused.tasks.flatMap(task => task.interrupts ?? [])[0].id!
    await graph.invoke(new Command({ resume: { [interruptId]: 'yes' } }), invocation)
    lease.release(token)
    const source = db.sqlite.prepare('SELECT * FROM row_versions ORDER BY revision,table_name,row_key').all()
    const fork = await RunDatabase.open(path.join(dir, 'nested-fork', 'run.sqlite'), { create: true }); cleanup.push(async () => fork.close())
    db.forkAt(fork, { revision: cut, runId: 'nested-fork' })
    const forkLedger = new RunLedger(fork, new RunLease(fork, 'nested-fork').acquire('fork'), { maxTransitions: 20 })
    const forkGraph = make(forkLedger, new SqliteRunSaver(fork, forkLedger))
    await forkGraph.invoke(null, invocation)
    const forkPaused = await forkGraph.getState(invocation, { subgraphs: true })
    const forkInterrupt = forkPaused.tasks.flatMap(task => task.interrupts ?? [])[0].id!
    const result = await forkGraph.invoke(new Command({ resume: { [forkInterrupt]: 'fork-approved' } }), invocation)
    expect(result.completed.filter(value => value === 'answer-0')).toHaveLength(1)
    expect(calls.get('prepare-0')).toBe(1); expect(calls.get('ask-0')).toBe(1); expect(calls.get('prepare-1')).toBe(1)
    expect(calls.get('join')).toBe(2)
    expect(fork.sqlite.prepare("SELECT DISTINCT checkpoint_ns FROM checkpoints WHERE checkpoint_ns!=''").all()).toHaveLength(2)
    expect(db.sqlite.prepare('SELECT * FROM row_versions ORDER BY revision,table_name,row_key').all()).toEqual(source)
    fork.checkIntegrity()
  })
})
