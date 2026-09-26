// C1 experiment only. This file is not a production saver or package export.
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, openSync, closeSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { BaseCheckpointSaver, copyCheckpoint, WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint'

const configOf = row => ({ configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } })

/** Public BaseCheckpointSaver adapter, with a fixture ledger committed with pending writes. */
export class SpikeSqliteSaver extends BaseCheckpointSaver {
  constructor(filename, { fault = () => {}, observe = () => {} } = {}) {
    super()
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    const fd = openSync(filename, 'a', 0o600)
    closeSync(fd)
    if (process.platform !== 'win32') chmodSync(filename, 0o600)
    this.db = new DatabaseSync(filename)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT, type TEXT NOT NULL, checkpoint BLOB NOT NULL, metadata BLOB NOT NULL,
        PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id));
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL, value BLOB NOT NULL,
        PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
      CREATE TABLE IF NOT EXISTS node_results (
        thread_id TEXT NOT NULL, node_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL,
        PRIMARY KEY(thread_id, node_id));
      CREATE TABLE IF NOT EXISTS executions (node_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY, operation TEXT NOT NULL, at REAL NOT NULL);`)
    this.fault = fault
    this.observe = observe
    this.putMs = []
    this.writeMs = []
  }

  close() { this.db.close() }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  async tuple(row) {
    const pendingWrites = []
    for (const write of this.db.prepare('SELECT * FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? ORDER BY task_id, idx').all(row.thread_id, row.checkpoint_ns, row.checkpoint_id)) {
      pendingWrites.push([write.task_id, write.channel, await this.serde.loadsTyped(write.type, write.value)])
    }
    return {
      config: configOf(row), checkpoint: await this.serde.loadsTyped(row.type, row.checkpoint),
      metadata: await this.serde.loadsTyped(row.type, row.metadata), pendingWrites,
      ...(row.parent_checkpoint_id ? { parentConfig: configOf({ ...row, checkpoint_id: row.parent_checkpoint_id }) } : {}),
    }
  }

  async getTuple(config) {
    const { thread_id, checkpoint_ns = '', checkpoint_id } = config.configurable ?? {}
    if (typeof thread_id !== 'string' || !thread_id) throw new Error('thread_id is required')
    const row = checkpoint_id
      ? this.db.prepare('SELECT * FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?').get(thread_id, checkpoint_ns, checkpoint_id)
      : this.db.prepare('SELECT * FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? ORDER BY checkpoint_id DESC LIMIT 1').get(thread_id, checkpoint_ns)
    return row ? this.tuple(row) : undefined
  }

  async *list(config, { before, limit, filter } = {}) {
    const clauses = [], values = []
    for (const key of ['thread_id', 'checkpoint_ns', 'checkpoint_id']) {
      if (config.configurable?.[key] !== undefined) { clauses.push(key + '=?'); values.push(config.configurable[key]) }
    }
    if (before?.configurable?.checkpoint_id) { clauses.push('checkpoint_id<?'); values.push(before.configurable.checkpoint_id) }
    const rows = this.db.prepare('SELECT * FROM checkpoints' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ' ORDER BY checkpoint_id DESC').all(...values)
    let remaining = limit ?? Infinity
    for (const row of rows) {
      if (remaining <= 0) break
      const tuple = await this.tuple(row)
      if (filter && !Object.entries(filter).every(([key, value]) => tuple.metadata?.[key] === value)) continue
      remaining -= 1
      yield tuple
    }
  }

  async put(config, checkpoint, metadata) {
    const start = performance.now()
    const { thread_id, checkpoint_ns = '', checkpoint_id: parent = null } = config.configurable ?? {}
    if (typeof thread_id !== 'string' || !thread_id) throw new Error('thread_id is required')
    const [[type, bytes], [metaType, metaBytes]] = await Promise.all([this.serde.dumpsTyped(copyCheckpoint(checkpoint)), this.serde.dumpsTyped(metadata)])
    if (type !== metaType) throw new Error('Prototype requires matching checkpoint/metadata serializer tags')
    this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)').run(thread_id, checkpoint_ns, checkpoint.id, parent, type, bytes, metaBytes)
      this.db.prepare('INSERT INTO audit(operation, at) VALUES (?, ?)').run('checkpoint', performance.now())
      this.fault({ phase: 'during-checkpoint', checkpoint })
    })
    this.putMs.push(performance.now() - start)
    this.observe({ type: 'checkpoint-commit', at: performance.now(), checkpoint, ns: checkpoint_ns })
    this.fault({ phase: 'after-checkpoint', checkpoint })
    return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } }
  }

  async putWrites(config, writes, taskId) {
    const start = performance.now()
    const { thread_id, checkpoint_ns = '', checkpoint_id } = config.configurable ?? {}
    if (!thread_id || !checkpoint_id) throw new Error('thread_id and checkpoint_id are required')
    const dumped = await Promise.all(writes.map(async ([channel, value], index) => ({ channel, value, index: WRITES_IDX_MAP[channel] ?? index, blob: await this.serde.dumpsTyped(value) })))
    const completed = dumped.filter(write => write.channel === 'completed').flatMap(write => write.value)
    this.fault({ phase: 'before-writes', completed })
    this.transaction(() => {
      for (const write of dumped) {
        const verb = write.index < 0 ? 'REPLACE' : 'IGNORE'
        this.db.prepare(`INSERT OR ${verb} INTO writes VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(thread_id, checkpoint_ns, checkpoint_id, taskId, write.index, write.channel, write.blob[0], write.blob[1])
      }
      this.fault({ phase: 'between-writes-ledger', completed })
      for (const nodeId of completed) {
        this.db.prepare('INSERT OR IGNORE INTO node_results VALUES (?, ?, ?, ?, ?)').run(thread_id, nodeId, checkpoint_ns, checkpoint_id, taskId)
      }
      this.db.prepare('INSERT INTO audit(operation, at) VALUES (?, ?)').run('writes-and-ledger', performance.now())
    })
    this.writeMs.push(performance.now() - start)
    this.observe({ type: 'writes-commit', at: performance.now(), completed, ns: checkpoint_ns, taskId })
    this.fault({ phase: 'after-writes', completed })
  }

  async deleteThread(threadId) {
    this.transaction(() => {
      for (const table of ['node_results', 'writes', 'checkpoints']) this.db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId)
    })
  }
}
