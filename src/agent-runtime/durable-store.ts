import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import type { JsonValue, WorkflowState } from './workflow-types.js'

export class WorkflowStoreError extends Error {
  constructor(public readonly code: 'INVALID_ID' | 'LOCKED' | 'CORRUPT_STATE', message: string) {
    super(message)
    this.name = 'WorkflowStoreError'
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
}

/** Reject non-JSON data instead of silently changing the fingerprint on serialization. */
export function fingerprint(value: unknown): string {
  const seen = new Set<object>()
  const canonical = (item: unknown): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || item === null || seen.has(item)) throw new TypeError('Checkpoint values must be finite, acyclic JSON data')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('Checkpoint values must be plain JSON objects')
    }
    seen.add(item)
    const result = Array.isArray(item)
      ? item.map(canonical)
      : Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]))
    seen.delete(item)
    return result
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function runDirectory(directory: string, runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId) || runId.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(runId)) {
    throw new WorkflowStoreError('INVALID_ID', 'Run ID must contain 1–128 letters, numbers, dots, underscores or dashes, start with a letter or number, and be a portable filename')
  }
  return join(resolve(directory), runId)
}

export async function readWorkflowState(directory: string, runId: string): Promise<WorkflowState | null> {
  let raw: string
  try {
    raw = await readFile(join(runDirectory(directory, runId), 'checkpoint.json'), 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  try {
    const envelope = JSON.parse(raw) as { format: number; checksum: string; state: WorkflowState }
    const state = envelope.state
    if (envelope.format !== 1 || !state || state.schemaVersion !== 1 || state.runId !== runId ||
        !Array.isArray(state.events) || !Array.isArray(state.history) || !state.steps ||
        envelope.checksum !== fingerprint(state)) throw new Error('Invalid envelope or checksum')
    return state
  } catch (error) {
    throw new WorkflowStoreError('CORRUPT_STATE', `Cannot read checkpoint for ${runId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Publish a complete checkpoint, receipt, usage and event ledger in one atomic rename. */
export async function writeWorkflowState(directory: string, state: WorkflowState): Promise<void> {
  const root = runDirectory(directory, state.runId)
  await mkdir(root, { recursive: true, mode: 0o700 })
  // JSON removes absent optional fields; validate the actual stored representation.
  const serialized = JSON.stringify(state)
  const normalized: WorkflowState = JSON.parse(serialized) as WorkflowState
  const payload = JSON.stringify({ format: 1, checksum: fingerprint(normalized), state: normalized })
  const temporary = join(root, `.checkpoint-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    // Node's rename replaces an existing file on supported macOS and Windows filesystems.
    await rename(temporary, join(root, 'checkpoint.json'))
    // POSIX directory sync makes the rename durable; Windows cannot open directories this way.
    if (process.platform !== 'win32') {
      const directoryHandle = await open(root, 'r')
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

interface LeaseOwner { pid: number; hostname: string; token: string }

async function ownerAt(path: string): Promise<LeaseOwner | null> {
  try {
    const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as LeaseOwner
    return Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === 'string' && typeof owner.token === 'string' ? owner : null
  } catch (error) {
    if (error instanceof SyntaxError || errorCode(error) === 'ENOENT') return null
    throw error
  }
}

function alive(owner: LeaseOwner): boolean {
  if (owner.hostname !== hostname()) return true // Never steal leases from another machine.
  try { process.kill(owner.pid, 0); return true } catch (error) { return errorCode(error) !== 'ESRCH' }
}

/** Atomic directory leases avoid platform-specific flock and native dependencies. */
export async function acquireWorkflowLease(directory: string, runId: string): Promise<() => Promise<void>> {
  const root = runDirectory(directory, runId)
  const lease = join(root, '.lease')
  const recovery = join(root, '.lease-recovery')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const locked = (): WorkflowStoreError => new WorkflowStoreError('LOCKED', `Workflow ${runId} has an active or unverifiable lease`)
  let created = false
  try { await mkdir(lease); created = true } catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
  if (!created) {
    // A separate election prevents two contenders from deleting each other's new lease.
    try { await mkdir(recovery) } catch (error) { if (errorCode(error) === 'EEXIST') throw locked(); throw error }
    try {
      const oldOwner = await ownerAt(lease)
      if (!oldOwner || alive(oldOwner)) throw locked()
      await rm(lease, { recursive: true, force: true })
      await mkdir(lease)
    } finally {
      await rm(recovery, { recursive: true, force: true })
    }
  }
  const owner: LeaseOwner = { pid: process.pid, hostname: hostname(), token: randomUUID() }
  try {
    const handle = await open(join(lease, 'owner.json'), 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync() } finally { await handle.close() }
  } catch (error) {
    await rm(lease, { recursive: true, force: true })
    throw error
  }
  return async () => {
    const current = await ownerAt(lease)
    if (current?.token === owner.token) await rm(lease, { recursive: true, force: true })
  }
}
