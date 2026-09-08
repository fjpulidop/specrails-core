import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { realpathSync as requireRealpath } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InstallerError } from './errors.js'
import { isReservedPath, RESERVED_PATHS } from './paths.js'
import { restoreTree, snapshotTree, type LinkRecord } from './fs.js'

function exists(file: string): boolean {
  try { lstatSync(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export const frameworkLifecycleLockPath = (frameworkDir: string): string => path.join(frameworkDir, '.lifecycle.lock')

/** Separate from registry.lock: Desktop may hold the registry lock while invoking
 * a Core child. Never wait here (which would invert those locks). The lifecycle
 * lease covers snapshots, asynchronous provisioning, publication and rollback.
 */
function reclaimDeadLifecycleOwner(lockPath: string, token: string): boolean {
  // Serialize stale-owner reclamation too. Otherwise two processes can both
  // inspect the dead token, and the second unlink can erase the first new owner.
  const reclaimPath = lockPath + '.reclaim'
  let fd: number
  try { fd = openSync(reclaimPath, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeFileSync(fd, token)
    let previous: string
    try { previous = readFileSync(lockPath, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
    let owner: { pid?: unknown }
    try { owner = JSON.parse(previous) as { pid?: unknown } }
    catch { return false }
    if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) return false
    try { process.kill(Number(owner.pid), 0); return false }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false }
    if (readFileSync(lockPath, 'utf8') !== previous) return false
    unlinkSync(lockPath)
    return true
  } finally {
    closeSync(fd)
    unlinkSync(reclaimPath)
  }
}

export async function withFrameworkLifecycleLock<T>(frameworkDir: string, apply: () => T | Promise<T>): Promise<T> {
  mkdirSync(frameworkDir, { recursive: true })
  const lockPath = frameworkLifecycleLockPath(frameworkDir)
  const identity = randomUUID()
  const token = JSON.stringify({ pid: process.pid, token: identity })
  const candidate = path.join(frameworkDir, '.lifecycle-' + identity + '.candidate')
  // Publish a complete owner record atomically, including if the CLI crashes
  // during acquisition. No empty owner file can strand the next invocation.
  writeFileSync(candidate, token, { flag: 'wx', mode: 0o600 })
  let acquired = false
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { linkSync(candidate, lockPath); acquired = true; break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (attempt === 0 && reclaimDeadLifecycleOwner(lockPath, token)) continue
        throw new InstallerError('Another Core installation or update is active. Retry when it finishes; no framework files were changed.', 41)
      }
    }
  } finally { unlinkSync(candidate) }
  if (!acquired) throw new InstallerError('Could not acquire the Core framework lifecycle lock; retry the operation.', 41)
  try { return await apply() }
  finally {
    try {
      if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** Remove only installer-owned entries, preserving live reserved files in place.
 * A custom agent may have been edited/created/deleted while OpenSpec was running.
 * Restoring its old backup would lose that edit or resurrect a deliberate delete.
 */
function removeForRollback(target: string, relative: string): void {
  if (isReservedPath(relative)) return
  if (!exists(target)) return
  const stat = lstatSync(target)
  if (stat.isDirectory() && !stat.isSymbolicLink()
    && RESERVED_PATHS.some((reserved) => reserved.startsWith(relative + '/'))) {
    for (const child of readdirSync(target)) removeForRollback(path.join(target, child), relative + '/' + child)
    if (readdirSync(target).length === 0) rmSync(target, { recursive: true, force: true })
    return
  }
  rmSync(target, { recursive: true, force: true })
}

/**
 * A surface the transaction protects.
 *
 * `snapshotContents: false` marks a surface whose CONTENTS must not be copied:
 * the versioned framework store, which `installFramework` already rebuilds from
 * a content-hash stamp and stages through a temp directory. Rollback still
 * removes such a surface when the install CREATED it, and leaves a pre-existing
 * one exactly as it stands — copying it bought no safety and cost a full copy of
 * the framework store on every install.
 */
export type ProtectedSurface = string | { path: string; snapshotContents: boolean }

interface SurfaceSnapshot {
  target: string
  saved: string
  present: boolean
  snapshotContents: boolean
  links: LinkRecord[]
}

/** Snapshot only installer-owned surfaces; never follow links into a shared framework.
 * Backups survive a failed rollback and their location is reported for recovery.
 *
 * Snapshotting requires NO filesystem privilege: links are recorded by target
 * rather than recreated (see `snapshotTree`), so a protected surface that is —
 * or contains — a Windows junction no longer fails the install on an account
 * without SeCreateSymbolicLinkPrivilege.
 */
export async function withInstallRollback<T>(paths: ProtectedSurface[], apply: () => Promise<T>): Promise<T> {
  const backup = mkdtempSync(path.join(os.tmpdir(), 'specrails-update-backup-'))
  const seen = new Set<string>()
  const snapshots: SurfaceSnapshot[] = []
  for (const entry of paths) {
    const target = typeof entry === 'string' ? entry : entry.path
    if (seen.has(target)) continue
    seen.add(target)
    snapshots.push({
      target,
      saved: path.join(backup, String(snapshots.length)),
      present: exists(target),
      snapshotContents: typeof entry === 'string' ? true : entry.snapshotContents,
      links: [],
    })
  }
  let retainBackup = false
  try {
    for (const row of snapshots) {
      if (row.present && row.snapshotContents) row.links = snapshotTree(row.target, row.saved)
    }
    try { return await apply() } catch (error) {
      const failures: string[] = []
      for (const row of [...snapshots].reverse()) {
        try {
          // A pre-existing surface we deliberately did not copy is left alone:
          // there is no backup to put back, and removing it would destroy work
          // the transaction never owned.
          if (row.present && !row.snapshotContents) continue
          const relative = path.basename(row.target)
          removeForRollback(row.target, relative)
          if (row.present) {
            mkdirSync(path.dirname(row.target), { recursive: true })
            restoreTree(row.saved, row.target, row.links, {
              skip: (rel) => isReservedPath([relative, rel].filter(Boolean).join('/')),
            })
          }
        } catch (restoreError) { failures.push(`${row.target}: ${(restoreError as Error).message}`) }
      }
      if (failures.length) {
        retainBackup = true
        writeFileSync(path.join(backup, 'recovery.json'), JSON.stringify(snapshots, null, 2))
        throw new InstallerError(`Update failed: ${(error as Error).message}. Restore failed for ${failures.join('; ')}. Backups retained at ${backup}`, 41)
      }
      throw error
    }
  } finally {
    if (!retainBackup) rmSync(backup, { recursive: true, force: true })
  }
}

export function compareCoreVersions(left: string, right: string): number | null {
  const parse = (value: string): { core: number[]; pre: string[] } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
    return match ? { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] } : null
  }
  const a = parse(left); const b = parse(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]; const y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

/** Refuse an implicit downgrade. Explicit swap-current is the rollback interface. */
export function assertNoCoreDowngrade(current: string | null, target: string): void {
  if (current && compareCoreVersions(current, target) === 1) {
    throw new InstallerError(`Refusing to downgrade specrails-core ${current} to ${target}. Run the newer Core CLI to update or install projects. Use the explicit swap-current command only for an intentional framework rollback.`, 41)
  }
}

export function currentFrameworkVersion(frameworkDir: string): string | null {
  const current = path.join(frameworkDir, 'current')
  if (!existsSync(current)) return null
  for (const provider of ['.claude', '.codex', '.gemini', '.kimi-code']) {
    try {
      const stamp = JSON.parse(readFileSync(path.join(current, `.framework-stamp${provider}.json`), 'utf8')) as { version?: string }
      if (typeof stamp.version === 'string') return stamp.version
    } catch { /* Try the next materialized provider. */ }
  }
  try { return path.basename(requireRealpath(current)) } catch { return null }
}
