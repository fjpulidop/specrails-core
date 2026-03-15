import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { JobRow, EventRow, StatsRow, JobStatus, ChatConversationRow, ChatMessageRow } from './types'

export type DbInstance = InstanceType<typeof Database>

// ─── Internal types ──────────────────────────────────────────────────────────

export interface NewJob {
  id: string
  command: string
  started_at: string
}

export interface JobResult {
  exit_code: number
  status: JobStatus
  tokens_in?: number
  tokens_out?: number
  tokens_cache_read?: number
  tokens_cache_create?: number
  total_cost_usd?: number
  num_turns?: number
  model?: string
  duration_ms?: number
  duration_api_ms?: number
  session_id?: string
}

export interface AppEvent {
  event_type: string
  source?: string | null
  payload: string
}

export interface ListJobsOpts {
  limit?: number
  offset?: number
  status?: string
  from?: string
  to?: string
}

// ─── Migrations ──────────────────────────────────────────────────────────────

type Migration = (db: DbInstance) => void

const MIGRATIONS: Migration[] = [
  // Migration 1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id                   TEXT    PRIMARY KEY,
        command              TEXT    NOT NULL,
        started_at           TEXT    NOT NULL,
        finished_at          TEXT,
        status               TEXT    NOT NULL DEFAULT 'running',
        exit_code            INTEGER,
        tokens_in            INTEGER,
        tokens_out           INTEGER,
        tokens_cache_read    INTEGER,
        tokens_cache_create  INTEGER,
        total_cost_usd       REAL,
        num_turns            INTEGER,
        model                TEXT,
        duration_ms          INTEGER,
        duration_api_ms      INTEGER,
        session_id           TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_started_at ON jobs(started_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        event_type  TEXT    NOT NULL,
        source      TEXT,
        payload     TEXT    NOT NULL,
        timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_events_job_id ON events(job_id);

      CREATE TABLE IF NOT EXISTS job_phases (
        job_id      TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        phase       TEXT    NOT NULL,
        state       TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        PRIMARY KEY (job_id, phase)
      );
    `)
  },

  // Migration 2: add queue_position column to jobs
  (db) => {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN queue_position INTEGER;
    `)
  },

  // Migration 3: add queue_state table for persisting queue config (e.g., paused)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS queue_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO queue_state (key, value) VALUES ('paused', 'false');
    `)
  },

  // Migration 4: chat conversations and messages
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id           TEXT PRIMARY KEY,
        title        TEXT,
        model        TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
        session_id   TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content         TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id);
    `)
  },
]

function applyMigrations(db: DbInstance): void {
  // Ensure the migrations table exists (migration 1 creates it, but we need
  // it before we can read from it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((r) => r.version)
  )

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1
    if (!appliedVersions.has(version)) {
      MIGRATIONS[i](db)
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version)
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function initDb(dbPath: string): DbInstance {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath)
    fs.mkdirSync(dir, { recursive: true })
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  applyMigrations(db)

  // Orphan sweep: mark any running jobs as failed on startup
  db.prepare(
    "UPDATE jobs SET status = 'failed', finished_at = ? WHERE status = 'running'"
  ).run(new Date().toISOString())

  return db
}

export function createJob(db: DbInstance, job: NewJob): void {
  db.prepare(
    'INSERT INTO jobs (id, command, started_at, status) VALUES (?, ?, ?, ?)'
  ).run(job.id, job.command, job.started_at, 'running')
}

export function finishJob(
  db: DbInstance,
  jobId: string,
  result: JobResult
): void {
  db.prepare(`
    UPDATE jobs SET
      status              = ?,
      exit_code           = ?,
      finished_at         = ?,
      tokens_in           = ?,
      tokens_out          = ?,
      tokens_cache_read   = ?,
      tokens_cache_create = ?,
      total_cost_usd      = ?,
      num_turns           = ?,
      model               = ?,
      duration_ms         = ?,
      duration_api_ms     = ?,
      session_id          = ?
    WHERE id = ?
  `).run(
    result.status,
    result.exit_code,
    new Date().toISOString(),
    result.tokens_in ?? null,
    result.tokens_out ?? null,
    result.tokens_cache_read ?? null,
    result.tokens_cache_create ?? null,
    result.total_cost_usd ?? null,
    result.num_turns ?? null,
    result.model ?? null,
    result.duration_ms ?? null,
    result.duration_api_ms ?? null,
    result.session_id ?? null,
    jobId,
  )
}

export function appendEvent(
  db: DbInstance,
  jobId: string,
  seq: number,
  event: AppEvent
): void {
  db.prepare(
    'INSERT INTO events (job_id, seq, event_type, source, payload) VALUES (?, ?, ?, ?, ?)'
  ).run(jobId, seq, event.event_type, event.source ?? null, event.payload)
}

export function upsertPhase(
  db: DbInstance,
  jobId: string,
  phase: string,
  state: string
): void {
  db.prepare(
    'INSERT OR REPLACE INTO job_phases (job_id, phase, state, updated_at) VALUES (?, ?, ?, ?)'
  ).run(jobId, phase, state, new Date().toISOString())
}

export function listJobs(
  db: DbInstance,
  opts: ListJobsOpts
): { jobs: JobRow[]; total: number } {
  const limit = Math.min(opts.limit ?? 50, 200)
  const offset = opts.offset ?? 0

  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.status) {
    conditions.push('status = ?')
    params.push(opts.status)
  }
  if (opts.from) {
    conditions.push('started_at >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    conditions.push('started_at <= ?')
    params.push(opts.to)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM jobs ${where}`)
    .get(...params) as { count: number }

  const jobs = db
    .prepare(
      `SELECT * FROM jobs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as JobRow[]

  return { jobs, total: countRow.count }
}

export function getJob(
  db: DbInstance,
  jobId: string
): JobRow | undefined {
  return db
    .prepare('SELECT * FROM jobs WHERE id = ?')
    .get(jobId) as JobRow | undefined
}

export function getJobEvents(
  db: DbInstance,
  jobId: string
): EventRow[] {
  return db
    .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq ASC')
    .all(jobId) as EventRow[]
}

export function deleteJob(db: DbInstance, jobId: string): void {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId)
}

export function purgeJobs(
  db: DbInstance,
  opts?: { from?: string; to?: string }
): number {
  const conditions: string[] = ["status IN ('completed', 'failed', 'canceled')"]
  const params: unknown[] = []

  if (opts?.from) {
    conditions.push('started_at >= ?')
    params.push(opts.from)
  }
  if (opts?.to) {
    conditions.push('started_at <= ?')
    params.push(opts.to)
  }

  const where = conditions.join(' AND ')

  // Delete associated events first
  db.prepare(`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE ${where})`).run(...params)
  // Delete associated phases
  db.prepare(`DELETE FROM job_phases WHERE job_id IN (SELECT id FROM jobs WHERE ${where})`).run(...params)
  // Delete the jobs
  const result = db.prepare(`DELETE FROM jobs WHERE ${where}`).run(...params)
  return result.changes
}

// ─── Chat DB functions ────────────────────────────────────────────────────────

export function createConversation(db: DbInstance, opts: { id: string; model: string }): void {
  db.prepare(
    'INSERT INTO chat_conversations (id, model) VALUES (?, ?)'
  ).run(opts.id, opts.model)
}

export function listConversations(db: DbInstance): ChatConversationRow[] {
  return db.prepare(
    'SELECT * FROM chat_conversations ORDER BY updated_at DESC'
  ).all() as ChatConversationRow[]
}

export function getConversation(db: DbInstance, id: string): ChatConversationRow | undefined {
  return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as ChatConversationRow | undefined
}

export function deleteConversation(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id)
}

export function updateConversation(
  db: DbInstance,
  id: string,
  patch: { title?: string; session_id?: string; model?: string }
): void {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [new Date().toISOString()]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.session_id !== undefined) { sets.push('session_id = ?'); params.push(patch.session_id) }
  if (patch.model !== undefined) { sets.push('model = ?'); params.push(patch.model) }
  params.push(id)
  db.prepare(`UPDATE chat_conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function addMessage(
  db: DbInstance,
  msg: { conversation_id: string; role: 'user' | 'assistant'; content: string }
): ChatMessageRow {
  const result = db.prepare(
    'INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)'
  ).run(msg.conversation_id, msg.role, msg.content)
  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(result.lastInsertRowid)) as ChatMessageRow
}

export function getMessages(db: DbInstance, conversationId: string): ChatMessageRow[] {
  return db.prepare(
    'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(conversationId) as ChatMessageRow[]
}

export function getStats(db: DbInstance): StatsRow {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  const totalRow = db.prepare(`
    SELECT
      COUNT(*) as totalJobs,
      SUM(total_cost_usd) as totalCostUsd,
      AVG(duration_ms) as avgDurationMs
    FROM jobs
  `).get() as { totalJobs: number; totalCostUsd: number | null; avgDurationMs: number | null }

  const todayRow = db.prepare(`
    SELECT
      COUNT(*) as jobsToday,
      SUM(total_cost_usd) as costToday
    FROM jobs
    WHERE strftime('%Y-%m-%d', started_at) = ?
  `).get(today) as { jobsToday: number; costToday: number | null }

  return {
    totalJobs: totalRow.totalJobs,
    jobsToday: todayRow.jobsToday,
    totalCostUsd: totalRow.totalCostUsd ?? 0,
    costToday: todayRow.costToday ?? 0,
    avgDurationMs: totalRow.avgDurationMs,
  }
}
