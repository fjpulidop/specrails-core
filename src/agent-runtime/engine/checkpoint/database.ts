import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { EngineError, type DurableEngineEvent, type JsonValue } from '../contracts.js'

import { PersistenceError, privateSqlitePath } from '../storage/private-path.js'
export { PersistenceError, ensurePrivateDirectory as ensurePrivateRunDirectory } from '../storage/private-path.js'
export type DatabaseRow = Record<string, SQLOutputValue>
export type WriteRow = Record<string, SQLInputValue>

/** Every identifier interpolated into SQL comes from this closed adapter-owned map. */
const keys = {
  runs: ['run_id'], visits: ['visit_id'], steps: ['run_id', 'node_path', 'scope_id'], attempts: ['attempt_id'],
  invocations: ['invocation_id'], receipts: ['receipt_id'], budget: ['run_id'], interrupts: ['interrupt_id'],
  control_inbox: ['request_id'], role_sessions: ['session_key'], piece_state: ['run_id', 'scope_id', 'node_path', 'key'], reservations: ['reservation_id'],
  events: ['run_id', 'sequence'], checkpoints: ['thread_id', 'checkpoint_ns', 'checkpoint_id'],
  writes: ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'idx'],
} as const
export type RevisionTable = keyof typeof keys

const schema = `
CREATE TABLE runs (
 run_id TEXT PRIMARY KEY, singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1),
 workflow_id TEXT NOT NULL, definition_hash TEXT NOT NULL, definition_json TEXT NOT NULL, request_json TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('definition','builtin')), engine_version INTEGER NOT NULL,
 runtime_identity_json TEXT NOT NULL, status TEXT NOT NULL, fork_of TEXT, completion_json TEXT,
 checkpoint_thread_id TEXT NOT NULL, head_checkpoint_json TEXT, current_revision INTEGER NOT NULL DEFAULT 0,
 transitions INTEGER NOT NULL DEFAULT 0, candidate_revision INTEGER NOT NULL DEFAULT 0,
 candidate_json TEXT, verified_json TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0,
 next_event_sequence INTEGER NOT NULL DEFAULT 1, consecutive_failures INTEGER NOT NULL DEFAULT 0,
 active_duration_ms REAL NOT NULL DEFAULT 0, active_started_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE visits (
 visit_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), node_path TEXT NOT NULL,
 scope_id TEXT NOT NULL, branch_id TEXT, kind TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('read','write')),
 requires_ai INTEGER NOT NULL, local_visit INTEGER NOT NULL, global_transition INTEGER NOT NULL,
 thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL, saver_checkpoint_ns TEXT,
 before_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(thread_id,checkpoint_ns,checkpoint_id,task_id), UNIQUE(run_id,node_path,scope_id,local_visit));
CREATE TABLE steps (
 run_id TEXT NOT NULL REFERENCES runs(run_id), node_path TEXT NOT NULL, scope_id TEXT NOT NULL, branch_id TEXT,
 kind TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, last_attempt_id TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(run_id,node_path,scope_id));
CREATE TABLE attempts (
 attempt_id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES visits(visit_id), run_id TEXT NOT NULL REFERENCES runs(run_id),
 node_path TEXT NOT NULL, scope_id TEXT NOT NULL, visit INTEGER NOT NULL, attempt INTEGER NOT NULL, branch TEXT,
 status TEXT NOT NULL, lease_epoch INTEGER NOT NULL, frame_json TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
 error_code TEXT, error_message TEXT, outcome TEXT, output_json TEXT, usage_json TEXT, terminal_digest TEXT,
 recovery_authorized INTEGER NOT NULL DEFAULT 0, interruption_json TEXT, inherited INTEGER NOT NULL DEFAULT 0,
 UNIQUE(visit_id,attempt));
CREATE TABLE invocations (
 invocation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
 node_path TEXT NOT NULL, role TEXT, provider TEXT NOT NULL, model TEXT, kind TEXT, status TEXT NOT NULL,
 started_at TEXT NOT NULL, ended_at TEXT, duration_ms REAL, tool_calls INTEGER, usage_json TEXT NOT NULL,
 prompt_bytes INTEGER, context_bytes INTEGER, result_json TEXT, inherited INTEGER NOT NULL DEFAULT 0, ordinal INTEGER NOT NULL,
 UNIQUE(attempt_id,ordinal));
CREATE TABLE receipts (
 receipt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), node_path TEXT NOT NULL,
 attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), kind TEXT NOT NULL, valid INTEGER NOT NULL,
 candidate_hash TEXT NOT NULL, candidate_revision INTEGER NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE budget (
 run_id TEXT PRIMARY KEY REFERENCES runs(run_id), max_cost_usd REAL, max_tokens INTEGER, max_duration_ms REAL,
 known_cost_usd REAL NOT NULL DEFAULT 0, known_tokens INTEGER NOT NULL DEFAULT 0, duration_ms REAL NOT NULL DEFAULT 0,
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 cost_unknown INTEGER NOT NULL DEFAULT 0, input_unknown INTEGER NOT NULL DEFAULT 0, output_unknown INTEGER NOT NULL DEFAULT 0);
CREATE TABLE interrupts (
 interrupt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), visit_id TEXT NOT NULL REFERENCES visits(visit_id),
 attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), node_path TEXT NOT NULL, scope_id TEXT NOT NULL, branch_id TEXT,
 kind TEXT NOT NULL, requested_at TEXT NOT NULL, payload_json TEXT NOT NULL, answered_at TEXT, answer_json TEXT);
CREATE TABLE control_inbox (
 request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), kind TEXT NOT NULL CHECK(kind IN ('cancel','steer')),
 payload_json TEXT NOT NULL, created_at TEXT NOT NULL, received_sequence INTEGER NOT NULL DEFAULT 0, consumed_by_attempt_id TEXT, consumed_at TEXT);
CREATE TABLE role_sessions (
 session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), scope_id TEXT NOT NULL, node_path TEXT NOT NULL,
 role TEXT NOT NULL, identity TEXT NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE reservations (
 reservation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
 max_tokens INTEGER, max_cost_usd REAL, created_at TEXT NOT NULL);
CREATE TABLE piece_state (
 run_id TEXT NOT NULL REFERENCES runs(run_id), scope_id TEXT NOT NULL, node_path TEXT NOT NULL, key TEXT NOT NULL,
 visit_id TEXT REFERENCES visits(visit_id), value_json TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(run_id,scope_id,node_path,key));
CREATE TABLE lease (
 run_id TEXT PRIMARY KEY REFERENCES runs(run_id), owner TEXT NOT NULL, epoch INTEGER NOT NULL,
 acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE events (
 run_id TEXT NOT NULL REFERENCES runs(run_id), sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
 type TEXT NOT NULL, at TEXT NOT NULL, payload_json TEXT NOT NULL, inherited INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id,sequence));
CREATE TABLE checkpoints (
 thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, parent_checkpoint_id TEXT,
 type TEXT NOT NULL, checkpoint BLOB NOT NULL, metadata BLOB NOT NULL, metadata_type TEXT NOT NULL,
 PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
CREATE TABLE writes (
 thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL,
 idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL, value BLOB NOT NULL,
 PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,idx));
CREATE TABLE durable_revisions (revision INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE row_versions (
 table_name TEXT NOT NULL, row_key TEXT NOT NULL, revision INTEGER NOT NULL REFERENCES durable_revisions(revision),
 row_json TEXT, PRIMARY KEY(table_name,row_key,revision));
CREATE INDEX visits_run ON visits(run_id,node_path,scope_id,local_visit);
CREATE INDEX attempts_visit ON attempts(visit_id,attempt);
CREATE INDEX events_cursor ON events(run_id,sequence);
CREATE INDEX revisions_cut ON row_versions(revision,table_name);
PRAGMA user_version=1;
`

function encodeRow(row: WriteRow | DatabaseRow): string {
  return JSON.stringify(Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    ArrayBuffer.isView(value) ? { $sqliteBlob: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') } :
      typeof value === 'bigint' ? { $sqliteInteger: value.toString() } : value])))
}
function decodeRow(json: string): WriteRow {
  const row = JSON.parse(json) as Record<string, SQLInputValue | { $sqliteBlob?: string; $sqliteInteger?: string }>
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value && typeof value === 'object' && '$sqliteBlob' in value
    ? Buffer.from(value.$sqliteBlob!, 'base64') : value && typeof value === 'object' && '$sqliteInteger' in value ? BigInt(value.$sqliteInteger!) : value])) as WriteRow
}

/** Short synchronous transactions own graph writes and ledger evidence together. */
export class RunDatabase {
  private activeRevision: number | undefined
  private inTransaction = false
  private closed = false
  private constructor(readonly filename: string, readonly sqlite: DatabaseSync) {}

  static async open(filename: string, options: { create?: boolean; readOnly?: boolean } = {}): Promise<RunDatabase> {
    const target = await privateSqlitePath(filename, options)
    const sqlite = new DatabaseSync(target, { readOnly: options.readOnly ?? false })
    try {
      sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
      if (!options.readOnly) sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const version = Number(sqlite.prepare('PRAGMA user_version').get()?.user_version)
      if (version === 0 && options.create) { sqlite.exec('BEGIN IMMEDIATE'); try { sqlite.exec(schema); sqlite.exec('COMMIT') } catch (error) { sqlite.exec('ROLLBACK'); throw error } }
      else if (version !== 1) throw new PersistenceError('resume_incompatible', `Unsupported run database schema ${version}`)
      return new RunDatabase(target, sqlite)
    } catch (error) { sqlite.close(); throw error }
  }

  get revision(): number { return Number(this.sqlite.prepare('SELECT COALESCE(MAX(revision),0) AS value FROM durable_revisions').get()!.value) }
  get transactionRevision(): number {
    if (this.activeRevision === undefined) throw new PersistenceError('internal', 'A revision transaction is required')
    return this.activeRevision
  }

  /** Undefined reason is reserved for leases/read reservations, which do not change graph history. */
  transaction<T>(reason: string | undefined, operation: () => T): T {
    if (this.inTransaction) throw new PersistenceError('internal', 'Nested database transactions are not supported')
    this.sqlite.exec('BEGIN IMMEDIATE'); this.inTransaction = true
    try {
      if (reason !== undefined) this.activeRevision = Number(this.sqlite.prepare('INSERT INTO durable_revisions(reason,at) VALUES (?,?)').run(reason, new Date().toISOString()).lastInsertRowid)
      const result = operation()
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new PersistenceError('internal', 'Database transactions cannot await effects')
      this.sqlite.exec('COMMIT'); return result
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error }
    finally { this.activeRevision = undefined; this.inTransaction = false }
  }

  get(table: RevisionTable, key: WriteRow): DatabaseRow | undefined {
    const primary = keys[table]
    return this.sqlite.prepare(`SELECT * FROM ${table} WHERE ${primary.map(name => `${name}=?`).join(' AND ')}`).get(...primary.map(name => key[name]))
  }

  put(table: RevisionTable, row: WriteRow): void {
    const revision = this.transactionRevision, primary = keys[table], columns = Object.keys(row)
    const allowed = new Set(this.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(info => String(info.name)))
    if (columns.some(column => !allowed.has(column)) || primary.some(column => row[column] === undefined)) throw new PersistenceError('internal', `Invalid ${table} row`)
    const update = columns.filter(column => !(primary as readonly string[]).includes(column))
    this.sqlite.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(${primary.join(',')}) DO ${update.length ? `UPDATE SET ${update.map(column => `${column}=excluded.${column}`).join(',')}` : 'NOTHING'}`).run(...columns.map(column => row[column]))
    const stored = this.get(table, row)!
    this.sqlite.prepare('INSERT OR REPLACE INTO row_versions(table_name,row_key,revision,row_json) VALUES (?,?,?,?)').run(table, JSON.stringify(primary.map(key => stored[key])), revision, encodeRow(stored))
  }

  delete(table: RevisionTable, key: WriteRow): void {
    const revision = this.transactionRevision, primary = keys[table]
    this.sqlite.prepare(`DELETE FROM ${table} WHERE ${primary.map(name => `${name}=?`).join(' AND ')}`).run(...primary.map(name => key[name]))
    this.sqlite.prepare('INSERT OR REPLACE INTO row_versions(table_name,row_key,revision,row_json) VALUES (?,?,?,NULL)').run(table, JSON.stringify(primary.map(name => key[name])), revision)
  }

  /** Immutable cut includes overwritten pending writes and all child namespaces. Caller holds an inactive-source reservation. */
  rowsAt(revision: number): Array<{ table: RevisionTable; row: WriteRow }> {
    if (!this.inTransaction) throw new PersistenceError('internal', 'Historical reads require a source transaction')
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > this.revision) throw new PersistenceError('invalid_arguments', 'Invalid historical revision')
    const rows = this.sqlite.prepare(`SELECT v.table_name,v.row_json FROM row_versions v JOIN (
      SELECT table_name,row_key,MAX(revision) revision FROM row_versions WHERE revision<=? GROUP BY table_name,row_key
    ) cut ON v.table_name=cut.table_name AND v.row_key=cut.row_key AND v.revision=cut.revision WHERE v.row_json IS NOT NULL`).all(revision)
    const order = Object.keys(keys)
    return rows.map(row => ({ table: String(row.table_name) as RevisionTable, row: decodeRow(String(row.row_json)) }))
      .sort((a, b) => order.indexOf(a.table) - order.indexOf(b.table))
  }

  /**
   * Copies a complete historical cut into an empty, separately staged database.
   * The source writer reservation prevents takeover/steering while rows are read;
   * serialized graph blobs, opaque thread IDs and child namespaces stay unchanged.
   */
  forkAt(destination: RunDatabase, options: { revision: number; runId: string; omitPieceStatePrefixes?: string[] }): { sourceRunId: string; checkpointThreadId: string; revision: number } {
    if (destination.filename === this.filename || destination.sqlite.prepare('SELECT run_id FROM runs').get()) throw new EngineError('run_exists', 'Fork destination must be an empty separate database')
    if (!options.runId) throw new EngineError('invalid_arguments', 'A fork needs a new run ID')
    return this.transaction(undefined, () => {
      const source = this.sqlite.prepare('SELECT * FROM runs').get()
      if (!source) throw new EngineError('run_not_found', 'Source run does not exist')
      if (source.run_id === options.runId) throw new EngineError('invalid_arguments', 'Fork must have a new run ID')
      const lease = this.sqlite.prepare('SELECT expires_at FROM lease WHERE run_id=?').get(source.run_id)
      if (lease && Date.parse(String(lease.expires_at)) > Date.now()) throw new EngineError('lease_held', 'Cannot fork an actively leased run')
      const activeRows = this.rowsAt(options.revision)
      const revisions = this.sqlite.prepare('SELECT * FROM durable_revisions WHERE revision<=? ORDER BY revision').all(options.revision)
      const versions = this.sqlite.prepare('SELECT * FROM row_versions WHERE revision<=? ORDER BY revision').all(options.revision)
      const cutAt = Date.parse(String(revisions.at(-1)?.at)), omitted = options.omitPieceStatePrefixes ?? ['session:']
      const keep = (table: RevisionTable, row?: WriteRow): boolean => table !== 'control_inbox' && table !== 'role_sessions' &&
        !(table === 'piece_state' && row && omitted.some(prefix => String(row.key).startsWith(prefix)))
      const revisionTimes = new Map(revisions.map(row => [Number(row.revision), Date.parse(String(row.at))]))
      const rewrite = (table: RevisionTable, original: WriteRow, at = cutAt): WriteRow => {
        const row = { ...original }
        if ('run_id' in row) row.run_id = options.runId
        if (table === 'runs') {
          row.fork_of = source.run_id; row.lease_epoch = 0
          row.active_duration_ms = Number(row.active_duration_ms) + (row.active_started_at ? Math.max(0, at - Date.parse(String(row.active_started_at))) : 0)
          row.active_started_at = null
        }
        if (table === 'events') {
          row.inherited = 1
          row.payload_json = JSON.stringify({ ...JSON.parse(String(row.payload_json)), runId: options.runId })
        }
        if (table === 'invocations' || table === 'attempts') row.inherited = 1
        return row
      }
      destination.transaction(undefined, () => {
        for (const row of revisions) destination.sqlite.prepare('INSERT INTO durable_revisions(revision,reason,at) VALUES (?,?,?)').run(row.revision, row.reason, row.at)
        for (const version of versions) {
          const table = String(version.table_name) as RevisionTable
          if (!(table in keys)) throw new EngineError('storage_corrupt', 'Unknown revision table')
          const original = version.row_json ? decodeRow(String(version.row_json)) : undefined
          if (!keep(table, original)) continue
          const row = original ? rewrite(table, original, revisionTimes.get(Number(version.revision))) : undefined
          const key = row ? keys[table].map(name => row[name]) : (JSON.parse(String(version.row_key)) as SQLInputValue[]).map((value, index) => keys[table][index] === 'run_id' ? options.runId : value)
          destination.sqlite.prepare('INSERT INTO row_versions(table_name,row_key,revision,row_json) VALUES (?,?,?,?)')
            .run(table, JSON.stringify(key), version.revision, row ? encodeRow(row) : null)
        }
        for (const { table, row: original } of activeRows) {
          if (!keep(table, original)) continue
          const row = rewrite(table, original), columns = Object.keys(row)
          const allowed = new Set(destination.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(info => String(info.name)))
          if (columns.some(column => !allowed.has(column))) throw new EngineError('storage_corrupt', 'Historical row has unknown fields')
          destination.sqlite.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]))
        }
        destination.checkIntegrity()
      })
      destination.transaction('workflow-forked', () => { appendRunEvent(destination, options.runId, 'workflow_forked', { forkOf: String(source.run_id), beforeRevision: options.revision }) })
      return { sourceRunId: String(source.run_id), checkpointThreadId: String(source.checkpoint_thread_id), revision: options.revision }
    })
  }

  checkIntegrity(): void {
    if (this.sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || this.sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new PersistenceError('storage_corrupt', 'Run database integrity check failed')
  }
  close(): void { if (!this.closed) { this.sqlite.close(); this.closed = true } }
}

/** Called inside the business transaction. Delivery/replay happens only after commit. */
export function appendRunEvent(db: RunDatabase, runId: string, type: string, payload: JsonValue,
  context: Partial<Pick<DurableEngineEvent, 'nodePath' | 'scopeId' | 'branchId' | 'visit' | 'attempt' | 'attemptId'>> = {},
  timestamp = new Date().toISOString()): DurableEngineEvent {
  const run = db.get('runs', { run_id: runId })
  if (!run) throw new EngineError('run_not_found', 'Run does not exist')
  const sequence = Number(run.next_event_sequence)
  const event: DurableEngineEvent = { sequence, runId, type, timestamp, ...context, payload }
  db.put('events', { run_id: runId, sequence, event_id: randomUUID(), type, at: timestamp, payload_json: JSON.stringify(event) })
  db.put('runs', { ...run, next_event_sequence: sequence + 1, current_revision: db.transactionRevision, updated_at: timestamp })
  return event
}
