import { artifactPath, hash, resolveOpenSpecCli, runOpenSpec } from '../openspec.js'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  checkArchive, pipelineStateDirectory, transitionPipeline, validateVerificationRequest,
  type PipelineContext, type PipelineState, type VerificationCommand,
} from '../../pipeline/pipeline-state.js'
import type { DesignConfidence } from './state.js'
import { assertProposalInScope, withScopeDefault } from '../change-scope.js'

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a structured JSON object from agent')
  return value as Record<string, unknown>
}
/** Accepts the object wherever the model put it: bare, fenced, or surrounded by commentary. */
export function parseAgentObject(text: string): Record<string, unknown> {
  if (text.length > 2_000_000) throw new Error('Structured agent response is too large')
  const trimmed = text.trim()
  const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')]
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed)
  if (fenced) candidates.push(fenced[1]!)
  const first = trimmed.indexOf('{'), last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  let failure: unknown
  for (const candidate of candidates) {
    try { return object(JSON.parse(candidate)) } catch (error) { failure = error }
  }
  throw failure instanceof Error ? failure : new Error('Expected a structured JSON object from agent')
}
/** All generated paths are relative and reject symlink ancestors, including
 * already-existing archive/spec directories. */
export function child(root: string, relative: string): string {
  const target = path.resolve(root, relative)
  const rel = path.relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Artifact path escapes repository')
  let cursor = root
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part)
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Refusing symlink artifact path: ' + relative)
  }
  return target
}
export function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temp, content, { flag: 'wx', mode: 0o600 }); renameSync(temp, file) }
  finally { rmSync(temp, { force: true }) }
}
export function journal(context: PipelineContext): PipelineState {
  return JSON.parse(readFileSync(path.join(pipelineStateDirectory(context), 'state.json'), 'utf8')) as PipelineState
}

export function parseArchitecture(raw: Record<string, unknown>): { confidence: DesignConfidence; question?: string; verification: unknown; planningDepth: 'focused' | 'full'; planningReason?: string; referencePatterns: string[]; riskFlags: string[] } {
  if (!['high', 'medium', 'low'].includes(String(raw.confidence))) throw new Error('Invalid design confidence')
  if (raw.question !== undefined && (typeof raw.question !== 'string' || raw.question.length > 4000)) throw new Error('Invalid architect question')
  if (raw.planningDepth !== undefined && raw.planningDepth !== 'focused' && raw.planningDepth !== 'full') throw new Error('Invalid planning depth')
  if (raw.planningReason !== undefined && (typeof raw.planningReason !== 'string' || !raw.planningReason.trim() || raw.planningReason.length > 2000)) throw new Error('Invalid planning reason')
  const references = (key: string): string[] => {
    const value = raw[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000)) throw new Error('Invalid architect ' + key)
    return value as string[]
  }
  const referencePatterns = references('referencePatterns'), riskFlags = references('riskFlags')
  return { confidence: raw.confidence as DesignConfidence, ...(typeof raw.question === 'string' && raw.question.trim() ? { question: raw.question.trim() } : {}), verification: raw.verification,
    planningDepth: raw.planningDepth === 'focused' && referencePatterns.length > 0 && riskFlags.length === 0 ? 'focused' : 'full',
    ...(typeof raw.planningReason === 'string' ? { planningReason: raw.planningReason } : {}), referencePatterns, riskFlags,
  }
}
export function writeDesignConfidence(context: PipelineContext, change: string, architecture: ReturnType<typeof parseArchitecture>, options: { assumed?: boolean } = {}): void {
  // A question may precede change creation. Do not fabricate a change directory in that case.
  if (!existsSync(child(context.artifactRoot, 'openspec/changes/' + change + '/.openspec.yaml'))) return
  const confidence = options.assumed && architecture.confidence === 'low'
    ? { confidence: 'medium', assumed: true, reportedConfidence: 'low', question: architecture.question }
    : { confidence: architecture.confidence, question: architecture.question }
  write(child(context.artifactRoot, 'openspec/changes/' + change + '/design-confidence.json'), JSON.stringify(confidence, null, 2) + '\n')
}
/** Commands the architect proposed for repositories the configuration leaves uncovered. */
export function proposedVerification(context: PipelineContext, configured: VerificationCommand[], verification: unknown): VerificationCommand[] {
  if (verification === undefined || verification === null) return []
  if (!Array.isArray(verification) || verification.length > 100) throw new Error('Invalid proposed verification commands')
  const covered = new Set(configured.map(command => command.repositoryId))
  const proposed = verification.map(item => {
    const command = object(item)
    if (typeof command.repositoryId !== 'string' || typeof command.command !== 'string' || !command.command.trim() || !Array.isArray(command.args) || !command.args.every(arg => typeof arg === 'string')) throw new Error('Invalid proposed verification command')
    return { repositoryId: command.repositoryId, command: command.command, args: command.args as string[], ...(typeof command.cwd === 'string' && command.cwd ? { cwd: command.cwd } : {}) }
  }).filter(command => !covered.has(command.repositoryId) && context.repositories.some(repository => repository.id === command.repositoryId))
  for (const command of proposed) assertProposalInScope(context, command, 'proposed verification command')
  if (proposed.length) validateVerificationRequest(context, { kind: 'scoped', commands: proposed.map(command => withScopeDefault(context, command)) })
  return proposed
}
/** Publish an archive prepared by the real CLI. The durable write set makes a
 * crash between main-spec updates recoverable without applying a delta twice. */
async function archiveWithOpenSpec(context: PipelineContext, change: string, active: string, signal?: AbortSignal, adapter?: { directory: string; beforePublish(): void }): Promise<void> {
  const directory = adapter?.directory ?? pipelineStateDirectory(context)
  const receipt = path.join(directory, 'openspec-archive.json')
  type Plan = { activeHash: string; destination: string; writes: { path: string; before: string | null; after: string | null }[] }
  const files = (root: string, prefix = ''): string[] => {
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      const relative = prefix + entry.name
      if (entry.isSymbolicLink()) throw new Error('OpenSpec archive refuses symlink trees')
      return entry.isDirectory() ? files(path.join(root, entry.name), relative + '/') : [relative]
    })
  }
  const treeHash = (root: string): string => hash(JSON.stringify(files(root).sort().map(file => [file, readFileSync(artifactPath(root, file), 'utf8')])))
  const activeHash = treeHash(active)
  let plan: Plan
  if (existsSync(receipt)) plan = JSON.parse(readFileSync(receipt, 'utf8')) as Plan
  else {
    const staging = mkdtempSync(path.join(directory, '.openspec-archive-'))
    try {
      const source = artifactPath(context.artifactRoot, 'openspec')
      files(source) // Reject symlinks before copying or invoking the external CLI.
      cpSync(source, path.join(staging, 'openspec'), { recursive: true })
      // A fork prepares its delta against checkpoint-owned main specs. Publish
      // still compares all current preimages below; no source files are rewound.
      const forkBase = path.join(directory, 'openspec-archive-base.json')
      let beforeRoot = path.join(source, 'specs')
      let sourceChange: string | undefined
      if (existsSync(forkBase)) {
        const baseline = object(JSON.parse(readFileSync(forkBase, 'utf8')))
        if (baseline.schemaVersion !== 1 || baseline.directory !== 'agent-workflow/openspec-base-specs' || typeof baseline.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(baseline.snapshot)
          || typeof baseline.sourceChange !== 'string' || baseline.sourceChange.length > 64 || !SLUG.test(baseline.sourceChange)) throw new Error('Invalid fork archive baseline')
        sourceChange = baseline.sourceChange
        beforeRoot = child(directory, baseline.directory)
        files(beforeRoot)
        rmSync(path.join(staging, 'openspec/specs'), { recursive: true, force: true })
        cpSync(beforeRoot, path.join(staging, 'openspec/specs'), { recursive: true })
      }
      const output = await runOpenSpec(resolveOpenSpecCli(), staging, ['archive', change, '--yes'], signal)
      const archiveRoot = path.join(staging, 'openspec/changes/archive')
      const archives = existsSync(archiveRoot) ? readdirSync(archiveRoot).filter(name => name.endsWith('-' + change)) : []
      // OpenSpec can abort validation while exiting 0. Preserve its explanation;
      // process success alone is not an archive receipt.
      if (archives.length === 0) throw new Error(`OpenSpec did not create an archive for ${change}. Repair the reported cause before resuming.\n${output.slice(-6000)}`)
      if (archives.length !== 1) throw new Error(`OpenSpec archive has multiple destinations for ${change}: ${archives.join(', ')}.\n${output.slice(-6000)}`)
      if (existsSync(path.join(staging, 'openspec/changes', change))) throw new Error(`OpenSpec left the active change in place; archive was not completed.\n${output.slice(-6000)}`)
      const destination = 'openspec/changes/archive/' + archives[0]!
      if (existsSync(artifactPath(context.artifactRoot, destination))) throw new Error('OpenSpec archive destination already exists')
      const afterRoot = path.join(staging, 'openspec/specs')
      const names = new Set([...files(beforeRoot), ...files(afterRoot)])
      const contents = (root: string, name: string): string | null => existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), 'utf8') : null
      plan = { activeHash, destination, writes: [...names].map(name => {
        const before = contents(beforeRoot, name)
        let after = contents(afterRoot, name)
        // Pinned OpenSpec inserts a change ID into the placeholder for a newly
        // created specification. Preserve that provenance during fork replay;
        // authored text and all byte-for-byte publication guards stay intact.
        if (sourceChange && before === null && after !== null) after = after.replace(
          `\n## Purpose\nTBD - created by archiving change ${change}. Update Purpose after archive.\n## Requirements\n`,
          `\n## Purpose\nTBD - created by archiving change ${sourceChange}. Update Purpose after archive.\n## Requirements\n`)
        return { path: 'openspec/specs/' + name, before, after }
      }).filter(item => item.before !== item.after) }
      write(receipt, JSON.stringify(plan))
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  if (!new RegExp('^openspec/changes/archive/[0-9]{4}-[0-9]{2}-[0-9]{2}-' + change + '$').test(plan.destination)) throw new Error('Invalid OpenSpec archive receipt')
  if (adapter && !existsSync(active)) {
    const archived = artifactPath(context.artifactRoot, plan.destination)
    if (!existsSync(archived) || treeHash(archived) !== plan.activeHash || plan.writes.some(item => {
      if (!item.path.startsWith('openspec/specs/')) throw new Error('Invalid OpenSpec archive write')
      const target = artifactPath(context.artifactRoot, item.path)
      return (existsSync(target) ? readFileSync(target, 'utf8') : null) !== item.after
    })) throw new Error('OpenSpec archive recovery does not match the prepared write set')
    return
  }
  if (plan.activeHash !== activeHash) throw new Error('Reviewed artifacts changed since the OpenSpec archive was prepared')
  const targets = plan.writes.map(item => {
    if (!item.path.startsWith('openspec/specs/')) throw new Error('Invalid OpenSpec archive write')
    const target = artifactPath(context.artifactRoot, item.path)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null
    if (current !== item.before && current !== item.after) throw new Error('Main specification changed during archive; refusing to overwrite: ' + item.path)
    return { ...item, target, unchanged: current === item.after }
  })
  // The external CLI ran asynchronously; recheck the candidate and artifacts before publishing.
  signal?.throwIfAborted()
  if (treeHash(active) !== activeHash) throw new Error('Reviewed artifacts changed during OpenSpec archive preparation')
  if (adapter) adapter.beforePublish()
  else checkArchive(context)
  // Validate every path and preimage before publishing the first output.
  const destination = artifactPath(context.artifactRoot, plan.destination)
  if (existsSync(destination)) throw new Error('Archive destination already exists')
  for (const item of targets) {
    if (item.unchanged) continue
    if (item.after === null) rmSync(item.target, { force: true })
    else write(item.target, item.after)
  }
  mkdirSync(path.dirname(destination), { recursive: true })
  renameSync(active, destination)
}
/** Recoverable pinned-CLI archive for ledger-only runs; no implementation journal. */
export async function archiveOpenSpecChange(context: PipelineContext, change: string, adapter: { directory: string; beforePublish(): void }, signal?: AbortSignal): Promise<void> {
  if (!SLUG.test(change) || change.length > 64) throw new Error('Invalid OpenSpec change identifier')
  mkdirSync(adapter.directory, { recursive: true, mode: 0o700 })
  if (lstatSync(adapter.directory).isSymbolicLink()) throw new Error('Refusing symlink archive adapter directory')
  const active = artifactPath(context.artifactRoot, 'openspec/changes/' + change)
  if (!existsSync(active) && !existsSync(path.join(adapter.directory, 'openspec-archive.json'))) throw new Error('OpenSpec active change does not exist')
  await archiveWithOpenSpec(context, change, active, signal, adapter)
}
export async function archive(context: PipelineContext, change: string, signal?: AbortSignal): Promise<void> {
  const state = journal(context)
  if (state.phases.archive.status !== 'done') {
    const active = artifactPath(context.artifactRoot, 'openspec/changes/' + change)
    if (existsSync(active)) {
      checkArchive(context)
      transitionPipeline(context, 'archive', 'running')
      await archiveWithOpenSpec(context, change, active, signal)
    }
    // If the process died after rename, Core rechecks the saved archive approval.
    transitionPipeline(context, 'archive', 'done')
  }
  // A crash can also occur after Core's archive receipt but before these host
  // ownership markers. Reconcile them when repeating the interrupted step.
  if (context.ownership.git === 'host') {
    const current = journal(context)
    if (current.phases.ship.status !== 'skipped') transitionPipeline(context, 'ship', 'skipped')
    if (current.phases.ci.status !== 'skipped') transitionPipeline(context, 'ci', 'skipped')
  }
}
