import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { EngineError, type ExecutionLease } from '../contracts.js'
import { appendRunEvent, RunDatabase } from './database.js'

const LEASE_MS = 60_000
export const LEASE_HEARTBEAT_MS = 15_000

const OWNER_PROCESS = /^pid:(\d+)@([^:]+):(?:proc-([0-9a-f]{12})(?:\.(\d+))?:)?/
/**
 * Tells this process apart from an earlier one that had the same pid. Windows reuses a freed pid
 * at once, so the next Core process can be given the very pid a killed executor recorded: without
 * this it would take that dead owner's lease for its own and refuse with `lease_held` until expiry.
 */
const PROCESS_TOKEN = randomUUID().replace(/-/g, '').slice(0, 12)
/** When this process started (ms since the epoch): at or after the OS creation time. */
const PROCESS_STARTED_AT = Math.floor(performance.timeOrigin)
/**
 * An OS start time this much after the recorded one is another process. The OS creation time is at
 * or before `performance.timeOrigin`, and the readings round down (`ps` to the second, Linux boot time
 * to the second), so the margin only absorbs clock jitter; it must stay well under how long an
 * executor lives before it holds a lease, or a newer process that took its pid would pass for it.
 */
const START_TOLERANCE_MS = 250

/**
 * Where a process with `token` keeps its liveness lock on Windows. The executor opens it exclusively
 * (share mode 0) for as long as it lives; the OS closes that handle when the process dies however it
 * dies (TerminateProcess, a crash), so "the lock can be opened" proves the owner is gone without
 * asking anything about its pid, which Windows hands to the next process at once.
 */
export function ownerLockPath(token: string, directory: string = path.join(tmpdir(), 'specrails-core-executors')): string {
  return path.join(directory, `${token}.lock`)
}
/** A lock this old belongs to a process whose leases expired long ago (a lease lasts a minute). */
const STALE_LOCK_MS = 24 * 60 * 60_000
/**
 * libuv's UV_FS_O_EXLOCK on Windows: open with share mode 0. Node passes numeric open flags to libuv
 * unchanged but does not export this constant (fs.constants has no UV_FS_O_EXLOCK), so it is spelled here.
 */
export const WINDOWS_EXCLUSIVE_OPEN = (constants as Record<string, number | undefined>).UV_FS_O_EXLOCK ?? 0x10000000
let ownerLock: number | null | undefined
/** Opens this process's liveness lock (Windows only; once). A lock that cannot be held only leaves checks to the pid. */
function holdOwnerLock(): void {
  const exclusive = WINDOWS_EXCLUSIVE_OPEN
  if (ownerLock !== undefined || process.platform !== 'win32') return
  ownerLock = null
  const file = ownerLockPath(PROCESS_TOKEN), directory = path.dirname(file)
  try {
    mkdirSync(directory, { recursive: true })
    // A killed executor leaves its (released) lock behind; a held one cannot be deleted.
    for (const name of readdirSync(directory)) {
      const stale = path.join(directory, name)
      try { if (name.endsWith('.lock') && statSync(stale).mtimeMs < Date.now() - STALE_LOCK_MS) unlinkSync(stale) } catch {}
    }
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | exclusive)
    ownerLock = fd
    process.once('exit', () => { try { closeSync(fd); unlinkSync(file) } catch {} })
  } catch { ownerLock = null }
}

/** What the liveness lock of the process with `token` says: `missing` when there is none to ask. */
export type OwnerLockState = 'held' | 'released' | 'missing'
export function ownerLockState(token: string, platform: NodeJS.Platform = process.platform, file: string = ownerLockPath(token)): OwnerLockState {
  if (platform !== 'win32') return 'missing'
  let fd: number
  // A shared open fails with a sharing violation (EBUSY) while the owner holds the file exclusively.
  try { fd = openSync(file, 'r') }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === 'EBUSY' ? 'held' : 'missing' }
  closeSync(fd)
  return 'released'
}

/** A lease owner that names its process (pid, token and start), so a lease left by a process that died on this machine is not live. */
export function leaseOwner(): string {
  holdOwnerLock()
  return `pid:${process.pid}@${hostname()}:proc-${PROCESS_TOKEN}.${PROCESS_STARTED_AT}:${randomUUID()}`
}

/**
 * When the OS started process `pid` (ms since the epoch), `'gone'` when no process has the pid, or
 * null when it cannot tell. Read only when a lease owner's pid answers a signal, to tell the owner
 * from a newer process that was given its pid; a reading that fails keeps the owner live until its
 * lease expires.
 */
export type ProcessStartReading = number | 'gone' | null
type Run = (command: string, args: string[], options: { encoding: 'utf8'; timeout: number; windowsHide?: boolean; env?: NodeJS.ProcessEnv }) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout'>
/**
 * One query answers both whether a process has the pid and when it started. A process can hold a
 * reused pid for less time than PowerShell takes to start (a git or shell child of a concurrent run),
 * so a missing process must read as gone, not as a failed query.
 */
const WINDOWS_START_QUERY = (pid: number) => `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; ` +
  `if ($null -eq $p) { 'gone' } elseif ($null -eq $p.CreationDate) { 'unknown' } else { $p.CreationDate.ToUniversalTime().ToString('o') }`
export function processStartedAt(pid: number, platform: NodeJS.Platform = process.platform, run: Run = spawnSync): ProcessStartReading {
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ticks = Number(fields[19]), boot = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
      const hz = Number(run('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5_000 }).stdout.trim()) || 100
      return Number.isFinite(ticks) && boot ? Number(boot[1]) * 1000 + Math.round(ticks * 1000 / hz) : null
    }
    const result = platform === 'win32'
      // Win32_Process reads the system's process list, so it has the creation time of any process,
      // also one this user cannot open (Get-Process StartTime is access-denied for system processes,
      // which is where Windows often puts a freed pid).
      ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_START_QUERY(pid)], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
      : run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } })
    const output = result.status === 0 ? String(result.stdout ?? '').trim() : ''
    if (platform === 'win32' && output === 'gone') return 'gone'
    const at = output ? Date.parse(output) : NaN
    return Number.isFinite(at) ? at : null
  } catch { return null }
}

/** Why a lease owner is (or is not) taken to be live; `lease_held` reports it. */
export type LeaseOwnerState =
  | { alive: true; reason: 'unnamed' | 'other_machine' | 'this_process' | 'older_owner' | 'unverifiable' | 'same_process' | 'lock_held'; observedStart?: number | null }
  | { alive: false; reason: 'process_gone' | 'pid_reused' | 'lock_released'; observedStart?: number | null }

export function leaseOwnerState(owner: string, kill: (pid: number, signal: 0) => void = process.kill.bind(process), startedAt: (pid: number) => ProcessStartReading = processStartedAt, lock: (token: string) => OwnerLockState = ownerLockState): LeaseOwnerState {
  const match = OWNER_PROCESS.exec(owner)
  if (!match) return { alive: true, reason: 'unnamed' }
  if (match[2] !== hostname()) return { alive: true, reason: 'other_machine' }
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: true, reason: 'unnamed' }
  // Our own pid: this process's owner is live; one from an earlier process that had this pid
  // (another process token) is dead, since this process holds the pid now. An owner without a
  // token (an older Core) cannot be told apart and stays live until its lease expires.
  if (pid === process.pid) {
    if (match[3] === undefined) return { alive: true, reason: 'older_owner' }
    return match[3] === PROCESS_TOKEN ? { alive: true, reason: 'this_process' } : { alive: false, reason: 'pid_reused' }
  }
  // The owner's liveness lock (Windows) answers for the process itself, whoever has its pid now.
  if (match[3] !== undefined) {
    const state = lock(match[3])
    if (state === 'held') return { alive: true, reason: 'lock_held' }
    if (state === 'released') return { alive: false, reason: 'lock_released' }
  }
  try { kill(pid, 0) }
  catch (error) {
    // ESRCH: no such process. EPERM: a process this user cannot signal has the pid (on Windows, a
    // system process that was given it), checked like a live one below.
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return { alive: false, reason: 'process_gone' }
  }
  // A process has the pid. It is the owner unless it started after the owner did: the owner died
  // and the pid went to a newer process (Windows reuses pids at once).
  const recorded = match[4] === undefined ? NaN : Number(match[4])
  if (!Number.isSafeInteger(recorded)) return { alive: true, reason: 'older_owner' }
  const observedStart = startedAt(pid)
  // The process that answered the signal exited before its start could be read: the pid is free.
  if (observedStart === 'gone') return { alive: false, reason: 'process_gone', observedStart: null }
  if (observedStart === null) return { alive: true, reason: 'unverifiable', observedStart }
  return observedStart > recorded + START_TOLERANCE_MS ? { alive: false, reason: 'pid_reused', observedStart } : { alive: true, reason: 'same_process', observedStart }
}

/**
 * False only when the owner names a process on this machine that no longer exists (or one whose pid
 * a newer process now has): it can neither renew nor release its lease, so waiting for the expiry
 * (up to a minute after a host restart killed it) protects nothing. Any other owner (another
 * machine, an older owner without a process, a start time that cannot be read) is assumed alive
 * until its lease expires.
 */
export function leaseOwnerAlive(owner: string, kill?: (pid: number, signal: 0) => void, startedAt?: (pid: number) => ProcessStartReading, lock?: (token: string) => OwnerLockState): boolean {
  return leaseOwnerState(owner, kill, startedAt, lock).alive
}

/** Whether a lease still fences the run: unexpired and held by an owner that can still act. */
export function leaseLive(lease: Pick<ExecutionLease, 'owner' | 'expiresAt'> | undefined, now: number = Date.now()): boolean {
  return !!lease && lease.expiresAt > now && leaseOwnerAlive(lease.owner)
}

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
      if (prior && prior.expiresAt > now) {
        const owner = leaseOwnerState(prior.owner)
        if (owner.alive) throw new EngineError('lease_held', 'Another executor holds this run lease', { expiresAt: prior.expiresAt, owner: prior.owner, ownerCheck: owner.reason, ...(owner.observedStart !== undefined ? { observedStart: owner.observedStart } : {}) })
      }
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

  /**
   * The token still fences the run while the lease row names it (same owner and epoch). An
   * expiry alone does not end it: the expiry only lets ANOTHER executor take the run over, and
   * a takeover writes a new owner and epoch in the same transaction that would otherwise renew
   * this one. A process frozen past the expiry (a laptop that slept, SIGSTOP, a debugger) that
   * nobody replaced resumes its run: it used to fail `lease_lost` at its first heartbeat after
   * waking, although nothing else had run (a 3-minute SIGSTOP failed a 160-task run after an hour).
   */
  assert(token: ExecutionLease): void {
    const current = this.current()
    if (token.runId !== this.runId || !current || current.owner !== token.owner || current.epoch !== token.epoch) {
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
