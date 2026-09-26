import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { initializePipeline, inspectPipeline, pipelineStateDirectory, validatePipelineContext, type PipelineState } from '../../../pipeline/pipeline-state.js'
import { child, write } from '../../graph/artifacts.js'
import { expandedPlanCommands, forkVerificationPlan, readVerificationPlan } from '../../verification-plan.js'
import { contentDigest } from '../canonical-json.js'
import { EngineError } from '../contracts.js'
import type { CoreNodeId, CoreStateType } from '../../graph/state.js'
import type { ImplementationBinding } from './implementation-binding.js'

export interface ImplementationJournalSnapshot {
  schemaVersion: 1
  bindingHash: string
  files: Array<{ area: 'journal' | 'change' | 'main-spec'; path: string; hash: string; bytes: number }>
  digest: string
}
const MAX_FILES = 8192, MAX_BYTES = 256 * 1024 * 1024, MAX_MANIFEST = 1024 * 1024
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const objects = (binding: ImplementationBinding): string => child(binding.directory, 'agent-workflow/implementation-snapshots/objects')
function fail(message: string): never { throw new EngineError('implementation_snapshot_invalid', message) }
function validateBinding(binding: ImplementationBinding): void {
  const context = validatePipelineContext(binding.context)
  if (path.resolve(binding.directory) !== pipelineStateDirectory(context) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(binding.change)) fail('Snapshot journal binding is invalid')
}
function durableBlob(directory: string, digest: string, bytes: Buffer): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const target = child(directory, digest)
  if (existsSync(target)) { if (hash(readFileSync(target)) !== digest) fail('Immutable snapshot object changed'); return }
  const temporary = child(directory, digest + '.' + randomUUID() + '.tmp')
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(temporary, target) } finally { rmSync(temporary, { force: true }) }
  // Windows does not support opening directories for fsync; file contents are
  // already flushed and rename is atomic. Unix also persists the directory entry.
  if (process.platform !== 'win32') { const dir = openSync(directory, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } }
}

/** Immutable bytes precede the SQLite terminal which publishes this exact manifest. */
export function captureImplementationJournal(binding: ImplementationBinding): ImplementationJournalSnapshot {
  validateBinding(binding)
  const journal = inspectPipeline(binding.context)
  const state = JSON.parse(readFileSync(child(binding.directory, 'state.json'), 'utf8')) as PipelineState
  if (state.change !== binding.change || journal.runId !== binding.context.runId) fail('Snapshot does not belong to the admitted implementation')
  const entries: ImplementationJournalSnapshot['files'] = []
  let total = 0
  const add = (root: string, relative: string, area: 'journal' | 'change' | 'main-spec'): void => {
    const target = child(root, relative)
    if (!existsSync(target)) return
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) fail('Snapshot refuses symlink artifacts')
    if (stat.isDirectory()) { for (const name of readdirSync(target).sort()) add(root, relative + '/' + name, area); return }
    if (!stat.isFile() || entries.length >= MAX_FILES || (total += stat.size) > MAX_BYTES) fail('Implementation snapshot exceeds its bounded file budget')
    const bytes = readFileSync(target), digest = hash(bytes)
    durableBlob(objects(binding), digest, bytes)
    entries.push({ area, path: relative, hash: digest, bytes: bytes.length })
  }
  for (const relative of ['state.json', 'context.json', 'verification', 'receipts', 'openspec-archive.json', 'openspec-archive-base.json']) add(binding.directory, relative, 'journal')
  const active = child(binding.context.artifactRoot, 'openspec/changes/' + binding.change)
  const changeRoot = existsSync(active) ? active : state.archivePath
  if (changeRoot && existsSync(changeRoot)) {
    const safe = child(binding.context.artifactRoot, path.relative(binding.context.artifactRoot, changeRoot))
    for (const name of readdirSync(safe).sort()) add(safe, name, 'change')
  }
  const mainSpecs = existsSync(child(binding.directory, 'openspec-archive-base.json'))
    ? child(binding.directory, 'agent-workflow/openspec-base-specs')
    : child(binding.context.artifactRoot, 'openspec/specs')
  if (existsSync(mainSpecs)) for (const name of readdirSync(mainSpecs).sort()) add(mainSpecs, name, 'main-spec')
  const payload = { schemaVersion: 1 as const, bindingHash: contentDigest(binding), files: entries }
  const snapshot = { ...payload, digest: contentDigest(payload) }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_MANIFEST) fail('Implementation snapshot manifest exceeds 1 MiB')
  return snapshot
}

/** Restore only checkpoint-owned objects, preserving the source and current repository files. */
export function forkImplementationJournal(snapshot: ImplementationJournalSnapshot, source: ImplementationBinding, target: ImplementationBinding): void {
  validateBinding(source); validateBinding(target)
  const { digest, ...payload } = snapshot
  if (snapshot.schemaVersion !== 1 || snapshot.bindingHash !== contentDigest(source) || digest !== contentDigest(payload)
    || !Array.isArray(snapshot.files) || snapshot.files.length > MAX_FILES || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_MANIFEST) fail('Implementation snapshot manifest failed its identity check')
  if (source.directory === target.directory || source.context.runId === target.context.runId || source.change === target.change) fail('A fork requires new journal and change identities')
  const targetChange = child(target.context.artifactRoot, 'openspec/changes/' + target.change)
  if (existsSync(child(target.directory, 'state.json')) || existsSync(targetChange)) fail('Fork refuses to overwrite an existing implementation')
  const files = new Map<string, Buffer>(), seen = new Set<string>()
  let total = 0
  for (const item of snapshot.files) {
    if (!['journal', 'change', 'main-spec'].includes(item.area) || !/^[a-f0-9]{64}$/.test(item.hash) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || (total += item.bytes) > MAX_BYTES) fail('Snapshot object metadata is invalid')
    const key = item.area + '/' + item.path
    if (seen.has(key)) fail('Snapshot contains duplicate paths'); seen.add(key)
    child(item.area === 'journal' ? target.directory : item.area === 'change' ? targetChange : child(target.directory, 'agent-workflow/openspec-base-specs'), item.path)
    if (item.area === 'journal' && !/^(?:state\.json|context\.json|openspec-archive(?:-base)?\.json|verification\/.+|receipts\/.+)$/.test(item.path)) fail('Snapshot contains an undeclared journal artifact')
    const bytes = readFileSync(child(objects(source), item.hash))
    if (bytes.length !== item.bytes || hash(bytes) !== item.hash) fail('Snapshot object is missing or corrupt')
    files.set(key, bytes)
  }
  const stateBytes = files.get('journal/state.json')
  if (!stateBytes) fail('Snapshot has no implementation journal')
  const state = JSON.parse(stateBytes.toString('utf8')) as PipelineState
  if (state.runId !== source.context.runId || state.change !== source.change) fail('Snapshot state belongs to another implementation')
  const priorBaseline = files.get('journal/openspec-archive-base.json')
  let sourceChange = source.change
  if (priorBaseline) {
    const baseline = JSON.parse(priorBaseline.toString('utf8')) as Record<string, unknown>
    if (baseline.schemaVersion !== 1 || baseline.directory !== 'agent-workflow/openspec-base-specs' || typeof baseline.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(baseline.snapshot)
      || typeof baseline.sourceChange !== 'string' || baseline.sourceChange.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(baseline.sourceChange)) fail('Snapshot archive baseline has invalid provenance')
    sourceChange = baseline.sourceChange
  }
  const fresh = initializePipeline(target.context, target.change)
  for (const [key, bytes] of files) {
    if (['journal/state.json', 'journal/context.json', 'journal/openspec-archive.json', 'journal/openspec-archive-base.json', 'journal/verification/plan.json'].includes(key)) continue
    const area = key.slice(0, key.indexOf('/')), relative = key.slice(key.indexOf('/') + 1)
    const destination = child(area === 'journal' ? target.directory : area === 'change' ? targetChange : child(target.directory, 'agent-workflow/openspec-base-specs'), relative)
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
  }
  const baseSpecs = child(target.directory, 'agent-workflow/openspec-base-specs')
  mkdirSync(baseSpecs, { recursive: true, mode: 0o700 })
  const archiveBytes = files.get('journal/openspec-archive.json')
  if (archiveBytes) {
    const archive = JSON.parse(archiveBytes.toString('utf8')) as { writes: Array<{ path: string; before: string | null }> }
    for (const item of archive.writes) {
      if (!item.path.startsWith('openspec/specs/')) fail('Snapshot archive baseline has an invalid path')
      const file = child(baseSpecs, item.path.slice('openspec/specs/'.length))
      if (item.before === null) rmSync(file, { force: true })
      else write(file, item.before)
    }
  }
  write(child(target.directory, 'openspec-archive-base.json'), JSON.stringify({ schemaVersion: 1, snapshot: snapshot.digest, directory: 'agent-workflow/openspec-base-specs', sourceChange }) + '\n')
  const planBytes = files.get('journal/verification/plan.json')
  if (planBytes) forkVerificationPlan(target.context, JSON.parse(planBytes.toString('utf8')), source.context)
  const prepared = JSON.parse(readFileSync(child(target.directory, 'state.json'), 'utf8')) as PipelineState
  const restored: PipelineState = { ...fresh, revision: state.revision + 1, updatedAt: new Date().toISOString(),
    phases: { ...fresh.phases, architect: state.phases.architect, developer: state.phases.developer },
    artifactExclusions: [...new Set([...state.artifactExclusions, ...fresh.artifactExclusions])],
    ...(prepared.verificationPlan ? { verificationPlan: prepared.verificationPlan } : {}) }
  write(child(target.directory, 'state.json'), JSON.stringify(restored) + '\n')
  write(child(target.directory, 'agent-workflow/implementation-fork.json'), JSON.stringify({ sourceRunId: source.context.runId, sourceChange: source.change, snapshot: snapshot.digest }) + '\n')
}

/** Public checkpoint projection; the caller updates the actual child namespace at its cut node. */
export function projectImplementationFork(target: ImplementationBinding): { next: CoreNodeId; update: Partial<CoreStateType> & { $next: CoreNodeId; $nodeResult: null } } {
  validateBinding(target)
  const inspection = inspectPipeline(target.context), plan = readVerificationPlan(target.context)
  const next: CoreNodeId = inspection.phases.architect.status !== 'done' ? 'architect' : inspection.phases.developer.status !== 'done' ? 'developer' : 'verify'
  return { next, update: { $next: next, $nodeResult: null, verifyResult: null, review: null, archived: null, verifyHistory: [],
    ...(plan ? { plan: expandedPlanCommands(target.context, plan) } : {}),
    ...(inspection.phases.architect.status !== 'done' ? { architecture: null } : {}),
    ...(inspection.phases.developer.status !== 'done' ? { development: null } : {}) } }
}
