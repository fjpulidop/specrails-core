import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { contentDigest } from '../canonical-json.js'
import { EngineError } from '../contracts.js'
import { ensurePrivateDirectory, privateSqlitePath } from './private-path.js'

interface Allocation { target: string; temporary: string; inode?: string; device?: string; birth?: string }
interface Manifest { version: 1; requestId: string | null; digest: string; allocations: Allocation[] }

function flushDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** SQLite holds the construction lock across awaits and releases it on process
 * death. The separate, flushed manifest survives that rollback. Directories are
 * recorded by inode before their atomic rename, so recovery never removes a
 * replacement directory or a child already published by Core.
 */
export class ForkAllocation {
  private manifest: Manifest
  private constructor(private readonly lock: DatabaseSync, private readonly directory: string,
    private readonly parents: readonly string[], requestId: string | undefined, digest: string) {
    this.manifest = { version: 1, requestId: requestId ?? null, digest, allocations: [] }
  }

  static async open(target: string, artifactRoot: string, requestId: string | undefined, digest: string): Promise<ForkAllocation> {
    const directory = path.join(path.dirname(target), '.fork-allocations', contentDigest(target))
    await ensurePrivateDirectory(directory)
    const filename = path.join(directory, 'lock.sqlite')
    try { closeSync(openSync(filename, 'wx', 0o600)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const lock = new DatabaseSync(await privateSqlitePath(filename))
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE') }
    catch (error) { lock.close(); throw new EngineError('lease_held', `Fork construction is already active: ${String(error)}`) }
    return new ForkAllocation(lock, directory, [path.dirname(target), path.join(artifactRoot, 'openspec', 'changes')], requestId, digest)
  }

  /** Call only after ruling out a published child. No request ID means no retry. */
  recover(): void {
    const filename = path.join(this.directory, 'intent.json')
    if (!existsSync(filename)) return
    const previous = JSON.parse(readFileSync(filename, 'utf8')) as Manifest
    if (previous.version === 1 && Array.isArray(previous.allocations) && previous.allocations.length === 0) return
    if (!this.manifest.requestId || previous.version !== 1 || previous.requestId !== this.manifest.requestId ||
      previous.digest !== this.manifest.digest || !Array.isArray(previous.allocations)) throw new EngineError('run_exists', 'Unpublished fork belongs to another request')
    this.validate(previous)
    this.manifest = previous
    this.cleanup()
  }

  /** Reserve an empty directory before any journal/artifact writes occur. */
  reserve(target: string): void {
    if (!this.parents.includes(path.dirname(target)) || existsSync(target)) throw new EngineError('run_exists', 'Fork refuses to replace an existing allocation')
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const allocation: Allocation = { target, temporary: path.join(path.dirname(target), `.${path.basename(target)}.fork-${randomUUID()}`) }
    this.manifest.allocations.push(allocation)
    this.save()
    mkdirSync(allocation.temporary, { mode: 0o700 })
    const info = lstatSync(allocation.temporary, { bigint: true })
    allocation.inode = String(info.ino); allocation.device = String(info.dev); allocation.birth = String(info.birthtimeNs)
    this.save()
    // A single construction lock serializes every request for this child.
    if (existsSync(target)) throw new EngineError('run_exists', 'Fork allocation was concurrently created')
    renameSync(allocation.temporary, target)
    flushDirectory(path.dirname(target))
  }

  cleanup(): void {
    this.validate(this.manifest)
    // Validate every path before removing any: uncertain ownership is preserved.
    for (const allocation of this.manifest.allocations) for (const target of [allocation.target, allocation.temporary]) {
      if (!existsSync(target)) continue
      const info = lstatSync(target, { bigint: true })
      if (!allocation.inode && target === allocation.temporary && info.isDirectory() && !info.isSymbolicLink()) continue
      if (!info.isDirectory() || info.isSymbolicLink() || String(info.ino) !== allocation.inode || String(info.dev) !== allocation.device || String(info.birthtimeNs) !== allocation.birth) throw new EngineError('run_exists', 'Fork allocation ownership changed')
    }
    for (const allocation of [...this.manifest.allocations].reverse()) for (const target of [allocation.target, allocation.temporary]) {
      if (!existsSync(target)) continue
      if (!allocation.inode) rmdirSync(target) // A crash before recording its inode can leave only an empty temporary directory.
      else rmSync(target, { recursive: true })
      flushDirectory(path.dirname(target))
    }
    this.manifest.allocations = []
    this.save()
  }

  close(): void { try { this.lock.exec('ROLLBACK') } finally { this.lock.close() } }

  private validate(manifest: Manifest): void {
    for (const entry of manifest.allocations) {
      if (typeof entry.target !== 'string' || typeof entry.temporary !== 'string' || !this.parents.includes(path.dirname(entry.target)) ||
        path.dirname(entry.temporary) !== path.dirname(entry.target) || !path.basename(entry.temporary).startsWith(`.${path.basename(entry.target)}.fork-`)) throw new EngineError('unsafe_storage_path', 'Fork allocation escapes its frozen roots')
    }
  }

  private save(): void {
    const temporary = path.join(this.directory, 'intent.tmp')
    const fd = openSync(temporary, 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify(this.manifest)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path.join(this.directory, 'intent.json'))
    flushDirectory(this.directory)
  }
}
