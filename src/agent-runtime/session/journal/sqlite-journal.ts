import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import { sessionsRoot } from '../../../shared/specrails-home.js'
import { PersistenceError, privateSqlitePath } from '../../engine/storage/private-path.js'
import { SessionError } from '../domain/errors.js'
import type { SessionEvent, SessionEventEnvelope } from '../domain/events.js'
import { emptySnapshot, foldEvents, type SessionSnapshot } from '../domain/snapshot.js'
import type { UsageBaseline } from '../domain/usage.js'
import type { AppendOptions, SessionJournal, SessionRecord, SessionSummary } from '../ports.js'
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION } from './schema.js'

export const JOURNAL_LEASE_MS = 60_000
export const JOURNAL_HEARTBEAT_MS = 15_000
export const JOURNAL_FILENAME = 'sessions.sqlite'

export interface JournalLease {
  owner: string
  epoch: number
  expiresAt: number
  /** How the previous owner left: released cleanly, lost (expired), or first ever owner. */
  previous: 'none' | 'released' | 'lost'
}

export interface OpenJournalOptions {
  scope: string
  owner: string
  home?: string
  /** Explicit database file (tests); defaults to `<sessionsRoot(scope)>/sessions.sqlite`. */
  filename?: string
  now?: () => number
  leaseMs?: number
  /** Called when the heartbeat cannot renew the lease; the host must stop writing. */
  onLeaseLost?: (error: SessionError) => void
  /** Disable the heartbeat timer (tests drive `renew` explicitly). */
  heartbeat?: boolean
}

type Row = Record<string, SQLOutputValue>

/**
 * Durable per-scope session journal (`~/.specrails/sessions/<scope>/sessions.sqlite`).
 * One host owns it through an epoch-fenced lease that is asserted inside every
 * write transaction. Events and the folded snapshot commit together; provider
 * I/O never runs inside a transaction.
 */
export class SqliteSessionJournal implements SessionJournal {
  private readonly cache = new Map<string, SessionSnapshot>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  private constructor(
    readonly filename: string,
    private readonly db: DatabaseSync,
    readonly lease: JournalLease,
    private readonly now: () => number,
    private readonly leaseMs: number,
  ) {}

  static async open(options: OpenJournalOptions): Promise<SqliteSessionJournal> {
    const filename = options.filename ?? path.join(sessionsRoot(options.scope, options.home), JOURNAL_FILENAME)
    let target: string
    try {
      target = await privateSqlitePath(filename, { create: !existsSync(filename) })
    } catch (error) {
      if (error instanceof PersistenceError) throw new SessionError('internal', `Session journal storage is unsafe or unavailable: ${error.message}`)
      throw error
    }
    const db = new DatabaseSync(target)
    const now = options.now ?? Date.now
    const leaseMs = options.leaseMs ?? JOURNAL_LEASE_MS
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      migrate(db)
      const lease = acquireLease(db, options.owner, now, leaseMs)
      const journal = new SqliteSessionJournal(target, db, lease, now, leaseMs)
      if (options.heartbeat !== false) journal.startHeartbeat(options.onLeaseLost)
      return journal
    } catch (error) {
      db.close()
      throw error
    }
  }

  // ── SessionJournal ────────────────────────────────────────────────────────

  createSession(record: SessionRecord): void {
    this.write(() => {
      if (this.db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(record.sessionId)) {
        throw new SessionError('invalid_params', `Session ${record.sessionId} already exists`, { path: 'sessionId' })
      }
      const snapshot = emptySnapshot(record.sessionId)
      this.db.prepare('INSERT INTO sessions(session_id,driver,cwd,metadata_json,status,last_seq,snapshot_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(record.sessionId, record.driver, record.cwd, JSON.stringify(record.metadata ?? {}), 'open', 0, JSON.stringify(snapshot), record.createdAt, record.createdAt)
      this.cache.set(record.sessionId, snapshot)
    })
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db.prepare('SELECT session_id,driver,cwd,metadata_json,created_at FROM sessions WHERE session_id=?').get(sessionId)
    return row ? toRecord(row) : null
  }

  append(sessionId: string, events: SessionEvent[], options?: AppendOptions): SessionEventEnvelope[] {
    if (events.length === 0) return []
    return this.write(() => {
      const current = this.loadSnapshot(sessionId)
      if (!current) throw new SessionError('session_not_found', `Unknown session ${sessionId}`)
      const envelopes = events.map((event, index) => ({ sessionId, seq: current.lastSeq + index + 1, event }))
      const next = foldEvents(current, envelopes)
      const insert = this.db.prepare('INSERT INTO events(session_id,seq,type,at,payload_json) VALUES (?,?,?,?,?)')
      for (const envelope of envelopes) insert.run(sessionId, envelope.seq, envelope.event.type, envelope.event.at, JSON.stringify(envelope.event))
      this.db.prepare('UPDATE sessions SET last_seq=?, status=?, snapshot_json=?, updated_at=? WHERE session_id=?')
        .run(next.lastSeq, next.status, JSON.stringify(next), envelopes.at(-1)!.event.at, sessionId)
      if (options?.baseline) {
        this.db.prepare('INSERT INTO usage_baselines(provider_ref,baseline_json,updated_at) VALUES (?,?,?) ON CONFLICT(provider_ref) DO UPDATE SET baseline_json=excluded.baseline_json, updated_at=excluded.updated_at')
          .run(options.baseline.providerRef, JSON.stringify(options.baseline.value), envelopes.at(-1)!.event.at)
      }
      this.cache.set(sessionId, next)
      return envelopes
    }, () => this.cache.delete(sessionId))
  }

  read(sessionId: string, afterSeq: number, limit: number): { events: SessionEventEnvelope[]; hasMore: boolean } {
    const rows = this.db.prepare('SELECT seq,payload_json FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(sessionId, afterSeq, limit + 1)
    const events = rows.slice(0, limit).map((row) => ({ sessionId, seq: Number(row.seq), event: JSON.parse(String(row.payload_json)) as SessionEvent }))
    return { events, hasMore: rows.length > limit }
  }

  snapshot(sessionId: string): SessionSnapshot | null {
    const snapshot = this.loadSnapshot(sessionId)
    return snapshot ? structuredClone(snapshot) : null
  }

  list(filter: 'open' | 'closed' | 'all'): SessionSummary[] {
    const sql = 'SELECT session_id,driver,cwd,metadata_json,created_at,status,last_seq,snapshot_json FROM sessions'
    const rows = filter === 'all' ? this.db.prepare(`${sql} ORDER BY created_at`).all() : this.db.prepare(`${sql} WHERE status=? ORDER BY created_at`).all(filter)
    return rows.map((row) => {
      const snapshot = JSON.parse(String(row.snapshot_json)) as SessionSnapshot
      return {
        sessionId: String(row.session_id),
        driver: String(row.driver),
        model: snapshot.model,
        status: row.status === 'closed' ? 'closed' : 'open',
        phase: snapshot.phase,
        lastSeq: Number(row.last_seq),
        createdAt: String(row.created_at),
        metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
      }
    })
  }

  baseline(providerRef: string): UsageBaseline | null {
    const row = this.db.prepare('SELECT baseline_json FROM usage_baselines WHERE provider_ref=?').get(providerRef)
    return row ? JSON.parse(String(row.baseline_json)) as UsageBaseline : null
  }

  // ── Retention, lease and lifecycle ────────────────────────────────────────

  /** Remove closed sessions last updated before `olderThan` (epoch ms). Open sessions are never removed. */
  sweepClosed(olderThan: number): number {
    return this.write(() => {
      const cutoff = new Date(olderThan).toISOString()
      const ids = this.db.prepare("SELECT session_id FROM sessions WHERE status='closed' AND updated_at<?").all(cutoff).map((row) => String(row.session_id))
      const remove = this.db.prepare('DELETE FROM sessions WHERE session_id=?')
      for (const id of ids) { remove.run(id); this.cache.delete(id) }
      return ids.length
    })
  }

  /** Extend the lease; throws `journal_locked` when it was lost. */
  renew(): void {
    this.write(() => {
      this.db.prepare('UPDATE host_lease SET heartbeat_at=?, expires_at=? WHERE singleton=1 AND owner=? AND epoch=?')
        .run(new Date(this.now()).toISOString(), this.now() + this.leaseMs, this.lease.owner, this.lease.epoch)
    })
  }

  /** Release the lease (clean shutdown) and close the database. Idempotent. */
  close(): void {
    if (this.closed) return
    this.stopHeartbeat()
    try {
      this.transaction(() => {
        this.db.prepare('DELETE FROM host_lease WHERE singleton=1 AND owner=? AND epoch=?').run(this.lease.owner, this.lease.epoch)
      })
    } finally {
      this.closed = true
      this.db.close()
    }
  }

  checkIntegrity(): void {
    const result = this.db.prepare('PRAGMA integrity_check').get()
    if (result?.integrity_check !== 'ok') throw new SessionError('internal', `Journal integrity check failed: ${String(result?.integrity_check)}`)
  }

  private startHeartbeat(onLost?: (error: SessionError) => void): void {
    this.heartbeatTimer = setInterval(() => {
      try { this.renew() }
      catch (error) {
        this.stopHeartbeat()
        onLost?.(error instanceof SessionError ? error : new SessionError('journal_locked', String(error)))
      }
    }, JOURNAL_HEARTBEAT_MS)
    this.heartbeatTimer.unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private loadSnapshot(sessionId: string): SessionSnapshot | null {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const row = this.db.prepare('SELECT snapshot_json FROM sessions WHERE session_id=?').get(sessionId)
    if (!row) return null
    const snapshot = JSON.parse(String(row.snapshot_json)) as SessionSnapshot
    this.cache.set(sessionId, snapshot)
    return snapshot
  }

  /** A fenced write: the lease is asserted inside the same transaction. */
  private write<T>(fn: () => T, onRollback?: () => void): T {
    if (this.closed) throw new SessionError('internal', 'Session journal is closed')
    return this.transaction(() => {
      this.assertLease()
      return fn()
    }, onRollback)
  }

  private transaction<T>(fn: () => T, onRollback?: () => void): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      onRollback?.()
      throw error
    }
  }

  private assertLease(): void {
    const row = this.db.prepare('SELECT owner,epoch,expires_at FROM host_lease WHERE singleton=1').get()
    if (!row || String(row.owner) !== this.lease.owner || Number(row.epoch) !== this.lease.epoch || Number(row.expires_at) <= this.now()) {
      throw new SessionError('journal_locked', 'The session journal lease was lost; another host owns this scope')
    }
  }
}

function migrate(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  if (version > JOURNAL_SCHEMA_VERSION) {
    throw new SessionError('store_incompatible', `Session journal schema ${version} is newer than supported ${JOURNAL_SCHEMA_VERSION}`)
  }
  for (let index = version; index < JOURNAL_SCHEMA_VERSION; index++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(JOURNAL_MIGRATIONS[index]!)
      db.exec(`PRAGMA user_version=${index + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

function acquireLease(db: DatabaseSync, owner: string, now: () => number, leaseMs: number): JournalLease {
  if (!owner) throw new SessionError('invalid_params', 'A journal owner is required')
  db.exec('BEGIN IMMEDIATE')
  try {
    const at = now()
    const prior = db.prepare('SELECT owner,expires_at FROM host_lease WHERE singleton=1').get()
    if (prior && Number(prior.expires_at) > at) {
      throw new SessionError('journal_locked', `Another session host (${String(prior.owner)}) owns this scope`)
    }
    const epoch = Number(db.prepare('SELECT epoch FROM lease_epoch WHERE singleton=1').get()!.epoch) + 1
    const previousEver = epoch > 1
    db.prepare('UPDATE lease_epoch SET epoch=? WHERE singleton=1').run(epoch)
    const iso = new Date(at).toISOString()
    db.prepare('INSERT INTO host_lease(singleton,owner,epoch,acquired_at,heartbeat_at,expires_at) VALUES (1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner, epoch=excluded.epoch, acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at')
      .run(owner, epoch, iso, iso, at + leaseMs)
    db.exec('COMMIT')
    return { owner, epoch, expiresAt: at + leaseMs, previous: prior ? 'lost' : previousEver ? 'released' : 'none' }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function toRecord(row: Row): SessionRecord {
  return {
    sessionId: String(row.session_id),
    driver: String(row.driver),
    cwd: String(row.cwd),
    createdAt: String(row.created_at),
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
  }
}
