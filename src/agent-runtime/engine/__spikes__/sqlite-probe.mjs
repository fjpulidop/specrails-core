import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import { SpikeSqliteSaver } from './sqlite-saver.mjs'
import { linearGraph } from './crash-worker.mjs'

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
function assertInjectedKill(result, database, phase, target) {
  assert.notEqual(result.status, 0, `Worker did not die at ${phase}/${target}`)
  const marker = JSON.parse(readFileSync(database + '.fault.json', 'utf8'))
  assert.equal(marker.phase, phase)
  assert.equal(marker.target, target)
  assert.ok(Number.isInteger(marker.pid) && marker.pid > 0)
  if (process.platform !== 'win32') assert.equal(result.signal, 'SIGKILL', result.stderr)
  else assert.ok(result.signal === 'SIGKILL' || result.signal === null && Number.isInteger(result.status), 'Windows termination must match its flushed kill marker')
}

export async function sqliteProbe(directory, count = 200) {
  assert.equal(count, 200, 'C1 acceptance always exercises all 200 boundaries')
  const filename = path.join(directory, 'crash', 'run.sqlite')
  const worker = fileURLToPath(new URL('./crash-worker.mjs', import.meta.url))
  const invoke = (database, phase, target, nodes = count) => {
    const result = spawnSync(process.execPath, [worker, database, phase, target, String(nodes)], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (result.error) throw result.error
    return result
  }
  const boundaries = []
  for (let index = 0; index < count; index += 1) {
    const target = `node-${String(index).padStart(3, '0')}`
    const killed = invoke(filename, 'after-writes', target)
    assertInjectedKill(killed, filename, 'after-writes', target)
    const check = new SpikeSqliteSaver(filename)
    try {
      const results = check.db.prepare('SELECT COUNT(*) AS count FROM node_results').get().count
      assert.equal(results, index + 1, `Wrong durable frontier after ${target}`)
      assert.equal(check.db.prepare(`SELECT COUNT(*) AS count FROM node_results r LEFT JOIN writes w
        ON r.thread_id=w.thread_id AND r.checkpoint_ns=w.checkpoint_ns AND r.checkpoint_id=w.checkpoint_id AND r.task_id=w.task_id
        AND w.channel='completed' WHERE w.task_id IS NULL`).get().count, 0, 'Ledger without durable pending writes')
      assert.equal(check.db.prepare('SELECT COUNT(*) AS count FROM executions').get().count, index + 1, 'A committed node executed twice')
      boundaries.push({ target, durableNodes: results, status: killed.status, signal: killed.signal })
    } finally { check.close() }
    if ((index + 1) % 25 === 0) process.stderr.write(`SQLite crash probe: ${index + 1}/${count} committed boundaries\n`)
  }
  const resumed = invoke(filename, 'none', 'none')
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.equal(JSON.parse(resumed.stdout).completed, count)
  const final = new SpikeSqliteSaver(filename)
  let journalMode
  try {
    journalMode = final.db.prepare('PRAGMA journal_mode').get().journal_mode
    assert.equal(journalMode, 'wal')
    assert.equal(final.db.prepare('SELECT COUNT(*) AS count FROM executions').get().count, count)
    assert.equal(final.db.prepare('SELECT COUNT(*) AS count FROM node_results').get().count, count)
  } finally { final.close() }

  for (const phase of ['before-writes', 'between-writes-ledger']) {
  const rollbackFile = path.join(directory, phase, 'run.sqlite')
  const killed = invoke(rollbackFile, phase, 'node-000', 3)
  assertInjectedKill(killed, rollbackFile, phase, 'node-000')
  const rollback = new SpikeSqliteSaver(rollbackFile)
  try {
    assert.equal(rollback.db.prepare("SELECT COUNT(*) AS count FROM writes WHERE channel='completed'").get().count, 0)
    assert.equal(rollback.db.prepare('SELECT COUNT(*) AS count FROM node_results').get().count, 0)
  } finally { rollback.close() }
  assert.equal(invoke(rollbackFile, 'none', 'none', 3).status, 0)
  const recovered = new SpikeSqliteSaver(rollbackFile)
  try { assert.equal(recovered.db.prepare('SELECT COUNT(*) AS count FROM executions').get().count, 4, 'Uncommitted read work should replay exactly once') }
  finally { recovered.close() }
  }

  const timed = new SpikeSqliteSaver(path.join(directory, 'timing', 'run.sqlite'))
  let timing
  try {
    await linearGraph(timed, count).invoke({}, { configurable: { thread_id: 'timing' }, durability: 'sync', recursionLimit: count + 5 })
    timing = { putCount: timed.putMs.length, meanPutMs: mean(timed.putMs), maxPutMs: Math.max(...timed.putMs), meanPendingWriteMs: mean(timed.writeMs) }
    assert.ok(timing.meanPutMs < 5, `Mean put exceeded 5ms: ${timing.meanPutMs}`)
  } finally { timed.close() }

  const conformance = new SpikeSqliteSaver(path.join(directory, 'conformance', 'run.sqlite'))
  try {
    const config = { configurable: { thread_id: 'conformance', checkpoint_ns: 'nested:fixture' } }
    const checkpoint = emptyCheckpoint()
    checkpoint.channel_values = { plain: 'value', bytes: new Uint8Array([1, 2]), number: 7 }
    const saved = await conformance.put(config, checkpoint, { source: 'input', step: -1, parents: {} }, {})
    await conformance.putWrites(saved, [['plain', 'first'], ['__error__', 'first-error']], 'task')
    await conformance.putWrites(saved, [['plain', 'replacement'], ['__error__', 'last-error']], 'task')
    const tuple = await conformance.getTuple(saved)
    assert.equal(tuple.checkpoint.channel_values.plain, 'value')
    assert.deepEqual(tuple.checkpoint.channel_values.bytes, new Uint8Array([1, 2]))
    assert.equal(tuple.pendingWrites.find(write => write[1] === 'plain')[2], 'first')
    assert.equal(tuple.pendingWrites.find(write => write[1] === '__error__')[2], 'last-error')
    const listed = []
    for await (const item of conformance.list(config, { filter: { source: 'input' }, limit: 1 })) listed.push(item)
    assert.equal(listed.length, 1)
    const none = []
    for await (const item of conformance.list(config, { before: saved })) none.push(item)
    assert.equal(none.length, 0)
    const second = { ...emptyCheckpoint(), id: checkpoint.id + 'a' }
    const childConfig = await conformance.put(saved, second, { source: 'loop', step: 0, parents: {} }, {})
    assert.deepEqual((await conformance.getTuple(childConfig)).parentConfig, saved)
    await conformance.put({ configurable: { thread_id: 'conformance', checkpoint_ns: 'other' } }, emptyCheckpoint(), { source: 'input', step: -1, parents: {} }, {})
    const scoped = []
    for await (const item of conformance.list(config, { limit: 1 })) scoped.push(item)
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0].config.configurable.checkpoint_ns, 'nested:fixture')
    await conformance.deleteThread('conformance')
    assert.equal(await conformance.getTuple(saved), undefined)
  } finally { conformance.close() }

  const fileMode = statSync(filename).mode & 0o777
  const directoryMode = statSync(path.dirname(filename)).mode & 0o777
  if (process.platform !== 'win32') { assert.equal(fileMode, 0o600); assert.equal(directoryMode, 0o700) }
  return { binding: 'node:sqlite', completedBoundaries: boundaries.length, boundaries, rollbackBeforeWrites: true, rollbackBetweenWritesAndLedger: true,
    completedNodesNeverRepeated: true, publicSaverConformance: true, journalMode, fileMode, directoryMode,
    windowsAclAcceptance: process.platform === 'win32' ? 'POSIX mode is not an ACL guarantee; host-private directory ACL verification remains a packaging gate' : 'not-applicable', ...timing }
}
