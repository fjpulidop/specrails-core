import { existsSync, openSync, writeSync, fsyncSync, closeSync, writeFileSync } from 'node:fs'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { EphemeralValue } from '@langchain/langgraph/channels'
import { RunDatabase } from '../../../../../dist/agent-runtime/engine/checkpoint/database.js'
import { RunLedger } from '../../../../../dist/agent-runtime/engine/checkpoint/ledger.js'
import { RunLease } from '../../../../../dist/agent-runtime/engine/checkpoint/lease.js'
import { SqliteRunSaver } from '../../../../../dist/agent-runtime/engine/checkpoint/saver.js'

const [filename, phase, clock] = process.argv.slice(2), created = !existsSync(filename), now = () => Number(clock)
const db = await RunDatabase.open(filename, { create: created })
if (created) {
  RunLedger.initialize(db, { runId: 'crash', workflowId: 'crash', definitionHash: 'fixture', definition: {}, request: {}, runtimeIdentity: {}, source: 'definition', ...(phase === 'provider-started' ? { budget: { maxTokens: 10 } } : {}) })
  db.sqlite.exec('CREATE TABLE fixture_physical_calls(node TEXT)')
}
const lease = new RunLease(db, 'crash', now), token = lease.acquire(`worker-${process.pid}`), ledger = new RunLedger(db, token, { maxTransitions: 2, now })
let ready = false
function kill(at) {
  const fd = openSync(filename + '.fault', 'w', 0o600)
  writeSync(fd, JSON.stringify({ at, pid: process.pid })); fsyncSync(fd); closeSync(fd)
  try { process.kill(process.pid, 'SIGKILL'); writeFileSync(filename + '.kill-failed', 'kill returned') }
  catch (error) { writeFileSync(filename + '.kill-failed', String(error)); throw error }
}
try {
  const saver = new SqliteRunSaver(db, ledger, { fault: at => { if (ready && at === phase) kill(at) } })
  const state = Annotation.Root({ done: Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }), $commit: new EphemeralValue(false) })
  const execute = node => (_state, config) => {
    const info = config.executionInfo
    const frame = ledger.enter({ nodePath: node, kind: 'fixture', effect: 'read', requiresAI: false, scope: { id: 'root', nodePathPrefix: '' },
      task: { checkpointThreadId: info.threadId, checkpointId: info.checkpointId, taskCheckpointNs: info.checkpointNs, taskId: info.taskId }, retry: { maxAttempts: 3 } })
    if (node === 'one' && ['provider-started', 'reserve-after-crash'].includes(phase)) {
      ledger.startInvocation(frame, { invocationId: 'provider-' + process.pid, provider: 'fixture' }, { maxTokens: 10 })
      if (phase === 'provider-started') kill('provider-started')
    }
    if (phase === 'before-effect') kill('before-effect')
    db.sqlite.prepare('INSERT INTO fixture_physical_calls(node) VALUES (?)').run(node)
    ready = true
    return { done: [node], $commit: ledger.terminal(frame, { outcome: 'done', output: node }) }
  }
  const graph = new StateGraph(state).addNode('one', execute('one')).addNode('two', execute('two'))
    .addEdge(START, 'one').addEdge('one', 'two').addEdge('two', END).compile({ checkpointer: saver })
  await graph.invoke(created ? {} : null, { configurable: { thread_id: 'crash' }, durability: 'sync' })
  lease.release(token)
} finally { writeFileSync(filename + '.cleanup', 'graceful'); db.close() }
