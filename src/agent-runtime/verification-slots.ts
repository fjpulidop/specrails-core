import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { specrailsHome } from '../shared/specrails-home.js'

/**
 * Machine-wide verification turns.
 *
 * Every run verifies in its own worktree, but all of them share one machine:
 * a full test suite starts as many workers as there are cores, so several
 * runs verifying at once oversubscribe the CPU and timing-sensitive tests fail
 * although the code is right. A verification therefore takes one of a small
 * number of slots shared by every Core process on the machine (any project,
 * any Desktop window) and waits for a free one; planning, implementing and
 * reviewing stay fully parallel.
 *
 * A slot is a directory created atomically under
 * `<home>/.specrails/verification-slots/`; its owner file names the holding
 * process. A slot whose owner is no longer alive (a crash, a kill) is
 * reclaimed, so a lost process never blocks the machine.
 *
 * A verification nested inside one that holds a turn (the checked project's
 * own tests start Core and verify, as Desktop's suite does) runs within that
 * turn: a holder that is an ancestor of this process never makes it wait.
 *
 * `SPECRAILS_VERIFY_SLOTS` sets the number of slots (default 1); `0` or `off`
 * turns the turns off.
 */
export const VERIFY_SLOTS_ENV = 'SPECRAILS_VERIFY_SLOTS'
export const DEFAULT_VERIFY_SLOTS = 1
const MAX_VERIFY_SLOTS = 64

export function verificationSlotCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[VERIFY_SLOTS_ENV]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return DEFAULT_VERIFY_SLOTS
  if (raw === 'off') return 0
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? Math.min(value, MAX_VERIFY_SLOTS) : DEFAULT_VERIFY_SLOTS
}

export interface VerificationSlotOptions {
  slots?: number
  /** Directory holding the slots; defaults to `<home>/.specrails/verification-slots`. */
  root?: string
  signal?: AbortSignal
  pollMs?: number
  /** Called once when every slot is taken and this verification starts waiting. */
  onWait?: (holders: readonly SlotOwner[]) => void
  /** Liveness of a recorded owner (injectable for tests). */
  isAlive?: (owner: SlotOwner) => boolean
  /** Whether a recorded owner is an ancestor of this process (injectable for tests). */
  isAncestor?: (owner: SlotOwner) => boolean
  owner?: Omit<SlotOwner, 'since'>
}

export interface SlotOwner { pid: number; host: string; label?: string; since: string }

export type ReleaseSlot = () => void

const held = new Set<string>()
let exitHookInstalled = false
function releaseAllOnExit(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => { for (const dir of held) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } } })
}

function defaultAlive(owner: SlotOwner): boolean {
  // Another machine sharing the home directory: never reclaim what we cannot see.
  if (owner.host !== os.hostname()) return true
  try { process.kill(owner.pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function parentOf(pid: number): number | null {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    : spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
  const parent = Number.parseInt(String(result.stdout ?? '').trim(), 10)
  return result.status === 0 && Number.isInteger(parent) && parent > 0 && parent !== pid ? parent : null
}

let ancestorsCache: Set<number> | undefined
/** This process's ancestors (looked up once, only when a turn is contended). */
function ancestors(): Set<number> {
  if (ancestorsCache) return ancestorsCache
  const found = new Set<number>()
  let pid: number | null = process.ppid
  for (let depth = 0; pid && depth < 64 && !found.has(pid); depth++) { found.add(pid); pid = parentOf(pid) }
  return (ancestorsCache = found)
}

function defaultAncestor(owner: SlotOwner): boolean {
  return owner.host === os.hostname() && ancestors().has(owner.pid)
}

function readOwner(dir: string): SlotOwner | null {
  try {
    const value = JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')) as Partial<SlotOwner>
    return typeof value.pid === 'number' && typeof value.host === 'string' ? { pid: value.pid, host: value.host, since: String(value.since ?? ''), ...(typeof value.label === 'string' ? { label: value.label } : {}) } : null
  } catch { return null }
}

function abortError(): Error {
  const error = new Error('Verification was cancelled while waiting for a verification slot')
  error.name = 'AbortError'
  return error
}

/**
 * Take a verification slot, waiting for one when all are held. Resolves with
 * the release function (idempotent); with no slots configured it resolves
 * immediately with a no-op. Rejects with an `AbortError` when `signal` aborts
 * while waiting.
 */
export async function acquireVerificationSlot(options: VerificationSlotOptions = {}): Promise<ReleaseSlot> {
  const slots = options.slots ?? verificationSlotCount()
  if (slots <= 0) return () => {}
  const root = options.root ?? path.join(specrailsHome(), 'verification-slots')
  const pollMs = Math.max(10, options.pollMs ?? 1_000)
  const isAlive = options.isAlive ?? defaultAlive
  const isAncestor = options.isAncestor ?? defaultAncestor
  const owner: Omit<SlotOwner, 'since'> = options.owner ?? { pid: process.pid, host: os.hostname() }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  let waiting = false
  for (;;) {
    if (options.signal?.aborted) throw abortError()
    const holders: SlotOwner[] = []
    for (let index = 0; index < slots; index++) {
      const dir = path.join(root, `slot-${index}`)
      try {
        mkdirSync(dir, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const current = readOwner(dir)
        // An owner file not written yet belongs to a slot being taken right now.
        if (current && !isAlive(current)) { rmSync(dir, { recursive: true, force: true }); index--; continue }
        // Nested inside a verification that holds this turn: run within it.
        if (current && current.pid !== process.pid && isAncestor(current)) return () => {}
        if (current) holders.push(current)
        continue
      }
      writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ ...owner, since: new Date().toISOString() }) + '\n', { mode: 0o600 })
      held.add(dir)
      releaseAllOnExit()
      let released = false
      return () => {
        if (released) return
        released = true
        held.delete(dir)
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* reclaimed by the next waiter */ }
      }
    }
    if (!waiting) { waiting = true; try { options.onWait?.(holders) } catch { /* advisory */ } }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { options.signal?.removeEventListener('abort', onAbort); resolve() }, pollMs)
      const onAbort = () => { clearTimeout(timer); reject(abortError()) }
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
