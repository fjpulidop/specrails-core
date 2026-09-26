import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { closeSync, fsyncSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { SpikeSqliteSaver } from './sqlite-saver.mjs'

export const LinearState = Annotation.Root({ completed: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }) })

export function linearGraph(saver, count) {
  const builder = new StateGraph(LinearState)
  for (let index = 0; index < count; index += 1) {
    const id = `node-${String(index).padStart(3, '0')}`
    builder.addNode(id, async () => {
      saver.db.prepare('INSERT INTO executions VALUES (?)').run(id)
      return { completed: [id] }
    })
    builder.addEdge(index === 0 ? START : `node-${String(index - 1).padStart(3, '0')}`, id)
  }
  builder.addEdge(`node-${String(count - 1).padStart(3, '0')}`, END)
  return builder.compile({ checkpointer: saver })
}

if (process.argv[1]?.endsWith('crash-worker.mjs')) {
  const [database, faultPhase, target, countText] = process.argv.slice(2)
  const saver = new SpikeSqliteSaver(database, { fault(event) {
    if (event.phase === faultPhase && event.completed?.includes(target)) {
      const marker = openSync(database + '.fault.json', 'w', 0o600)
      try { writeSync(marker, JSON.stringify({ phase: faultPhase, target, pid: process.pid })); fsyncSync(marker) }
      finally { closeSync(marker) }
      try {
        process.kill(process.pid, 'SIGKILL')
        throw new Error('SIGKILL returned without terminating the worker')
      } catch (error) {
        writeFileSync(database + '.kill-failed.json', JSON.stringify({ phase: faultPhase, target, message: error.message }))
        throw error
      }
    }
  } })
  try {
    const config = { configurable: { thread_id: 'crash-run' }, durability: 'sync', recursionLimit: Number(countText) + 5 }
    const prior = await saver.getTuple(config)
    const result = await linearGraph(saver, Number(countText)).invoke(prior ? null : {}, config)
    process.stdout.write(JSON.stringify({ completed: result.completed.length, putMs: saver.putMs, writeMs: saver.writeMs }) + '\n')
  } finally {
    // A thrown process.kill() or unrelated error must never count as a crash:
    // graceful cleanup can close/rollback SQLite and would weaken the probe.
    writeFileSync(database + '.cleanup.json', JSON.stringify({ pid: process.pid }))
    saver.close()
  }
}
