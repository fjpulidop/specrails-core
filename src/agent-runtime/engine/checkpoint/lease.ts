import { EngineError, type ExecutionLease } from '../contracts.js'
import { appendRunEvent, RunDatabase } from './database.js'

const LEASE_MS = 60_000
export const LEASE_HEARTBEAT_MS = 15_000

/** Fencing is checked in the same SQLite transaction as every execution mutation. */
export class RunLease {
  constructor(private readonly db: RunDatabase, readonly runId: string, private readonly now: () => number = Date.now) {}

  current(): ExecutionLease | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM lease WHERE run_id=?').get(this.runId)
    return row ? { runId: this.runId, owner: String(row.owner), epoch: Number(row.epoch), expiresAt: Date.parse(String(row.expires_at)) } : undefined
  }

  acquire(owner: string, ttlMs = LEASE_MS): ExecutionLease {
    if (!owner || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new EngineError('invalid_arguments', 'Lease owner and positive TTL are required')
    return this.db.transaction('lease-acquired', () => {
      const now = this.now(), prior = this.current(), run = this.db.get('runs', { run_id: this.runId })
      if (!run) throw new EngineError('run_not_found', 'Run does not exist')
      if (prior && prior.expiresAt > now) throw new EngineError('lease_held', 'Another executor holds this run lease', { expiresAt: prior.expiresAt })
      const epoch = Number(run.lease_epoch) + 1, at = new Date(now).toISOString(), expiresAt = now + ttlMs
      this.db.sqlite.prepare('INSERT OR REPLACE INTO lease(run_id,owner,epoch,acquired_at,heartbeat_at,expires_at) VALUES (?,?,?,?,?,?)')
        .run(this.runId, owner, epoch, at, at, new Date(expiresAt).toISOString())
      const previousActive = run.active_started_at ? Math.max(0, Math.min(now, prior?.expiresAt ?? now) - Date.parse(String(run.active_started_at))) : 0
      this.db.put('runs', { ...run, lease_epoch: epoch, current_revision: this.db.transactionRevision, updated_at: at,
        active_duration_ms: Number(run.active_duration_ms) + previousActive, active_started_at: at })
      if (prior) appendRunEvent(this.db, this.runId, 'lease_recovered', { previousEpoch: prior.epoch, epoch }, {}, at)
      return { runId: this.runId, owner, epoch, expiresAt }
    })
  }

  assert(token: ExecutionLease): void {
    const current = this.current()
    if (token.runId !== this.runId || !current || current.owner !== token.owner || current.epoch !== token.epoch || current.expiresAt <= this.now()) {
      throw new EngineError('lease_lost', 'Execution lease expired or was replaced; late effects cannot commit')
    }
  }

  renew(token: ExecutionLease, ttlMs = LEASE_MS): ExecutionLease {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new EngineError('invalid_arguments', 'Lease TTL must be positive')
    return this.db.transaction(undefined, () => {
      this.assert(token)
      const now = this.now(), expiresAt = now + ttlMs
      this.db.sqlite.prepare('UPDATE lease SET heartbeat_at=?,expires_at=? WHERE run_id=? AND owner=? AND epoch=?')
        .run(new Date(now).toISOString(), new Date(expiresAt).toISOString(), this.runId, token.owner, token.epoch)
      return { ...token, expiresAt }
    })
  }

  release(token: ExecutionLease): boolean {
    return this.db.transaction('lease-released', () => {
      const current = this.current()
      if (!current || current.owner !== token.owner || current.epoch !== token.epoch) return false
      const run = this.db.get('runs', { run_id: this.runId })!
      const active = run.active_started_at ? Math.max(0, Math.min(this.now(), current.expiresAt) - Date.parse(String(run.active_started_at))) : 0
      this.db.put('runs', { ...run, active_duration_ms: Number(run.active_duration_ms) + active, active_started_at: null })
      this.db.sqlite.prepare('DELETE FROM lease WHERE run_id=? AND owner=? AND epoch=?').run(this.runId, token.owner, token.epoch)
      return true
    })
  }

  /** An observer aborts all effects on loss. It must never leave an unhandled timer exception. */
  heartbeat(token: ExecutionLease, onLost: (error: EngineError) => void): () => void {
    const timer = setInterval(() => {
      try { this.renew(token) }
      catch (error) { clearInterval(timer); onLost(error instanceof EngineError ? error : new EngineError('lease_lost', String(error))) }
    }, LEASE_HEARTBEAT_MS)
    timer.unref()
    return () => clearInterval(timer)
  }
}
