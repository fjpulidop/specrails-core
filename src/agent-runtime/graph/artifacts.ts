import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  checkArchive, pipelineStateDirectory, transitionPipeline, validateVerificationRequest,
  type PipelineContext, type PipelineState, type VerificationCommand,
} from '../../installer/runtime/pipeline-state.js'
import type { DesignConfidence } from './state.js'

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a structured JSON object from agent')
  return value as Record<string, unknown>
}
function markdown(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500_000) throw new Error('Invalid agent field: ' + name)
  return value.trim() + '\n'
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

export interface Architecture {
  proposal: string
  design: string
  tasks: string[]
  specs: Array<{ name: string; content: string }>
  confidence: DesignConfidence
  question?: string
  verification: unknown
}
/** Validates the architect's structured reply; throws `Invalid …` so the role gets one repair turn. */
export function parseArchitecture(raw: Record<string, unknown>): Architecture {
  const proposal = markdown(raw.proposal, 'proposal')
  const design = markdown(raw.design, 'design')
  if (!['high', 'medium', 'low'].includes(String(raw.confidence))) throw new Error('Invalid design confidence')
  if (!Array.isArray(raw.tasks) || !raw.tasks.length || raw.tasks.length > 200) throw new Error('Architecture requires 1–200 tasks')
  const tasks = raw.tasks.map(task => {
    const title = object(task).title
    if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title) || title.length > 1000) throw new Error('Invalid task title')
    return title.trim()
  })
  if (!Array.isArray(raw.specs) || !raw.specs.length || raw.specs.length > 100) throw new Error('Architecture requires 1–100 specifications')
  const specs = raw.specs.map((item) => {
    const spec = object(item)
    if (typeof spec.name !== 'string' || !SLUG.test(spec.name) || spec.name.length > 100) throw new Error('Invalid specification name')
    return { name: spec.name, content: markdown(spec.content, 'spec.content') }
  })
  if (new Set(specs.map(s => s.name)).size !== specs.length) throw new Error('Duplicate specification names')
  if (raw.question !== undefined && raw.question !== null && (typeof raw.question !== 'string' || raw.question.length > 4000)) throw new Error('Invalid architect question')
  const question = typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim() : undefined
  return { proposal, design, tasks, specs, confidence: raw.confidence as DesignConfidence, ...(question ? { question } : {}), verification: raw.verification }
}
/**
 * Writes the reviewed architecture artifacts. A low-confidence design that the
 * project chose to proceed with is recorded as `medium` (the contract for a
 * design resting on one named assumption) with its provenance kept alongside,
 * because Core's design gate admits only high or medium confidence.
 */
export function writeArchitecture(context: PipelineContext, change: string, architecture: Architecture, options: { assumed?: boolean } = {}): void {
  const tasks = architecture.tasks.map((title, i) => '- [ ] ' + (i + 1) + '. ' + title).join('\n') + '\n'
  const prefix = 'openspec/changes/' + change + '/'
  const confidence = options.assumed && architecture.confidence === 'low'
    ? { confidence: 'medium', assumed: true, reportedConfidence: 'low', ...(architecture.question ? { question: architecture.question } : {}) }
    : { confidence: architecture.confidence, ...(architecture.question ? { question: architecture.question } : {}) }
  const files = [
    ['proposal.md', architecture.proposal], ['design.md', architecture.design], ['tasks.md', tasks],
    ['design-confidence.json', JSON.stringify(confidence, null, 2) + '\n'],
    ...architecture.specs.map(s => ['specs/' + s.name + '/spec.md', s.content]),
  ]
  // Validate every destination before the first write.
  const targets = files.map(([name, content]) => [child(context.artifactRoot, prefix + name), content!] as const)
  for (const [target, content] of targets) write(target, content)
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
  if (proposed.length) validateVerificationRequest(context, { kind: 'scoped', commands: proposed })
  return proposed
}
export function openTasks(context: PipelineContext, change: string): string[] {
  const file = child(context.artifactRoot, 'openspec/changes/' + change + '/tasks.md')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /^\s*-\s+\[ \]/.test(line)).map(line => line.replace(/^\s*-\s+\[ \]\s*/, '').trim()).slice(0, 50)
}

/** Archive is deterministic and replayable only with explicit write recovery.
 * The reviewed specification documents are complete replacements, not deltas. */
export function archive(context: PipelineContext, change: string): void {
  const state = journal(context)
  if (state.phases.archive.status !== 'done') {
    const active = child(context.artifactRoot, 'openspec/changes/' + change)
    if (existsSync(active)) {
      checkArchive(context)
      transitionPipeline(context, 'archive', 'running')
      const specsDir = child(context.artifactRoot, 'openspec/changes/' + change + '/specs')
      const specs = readdirSync(specsDir, { withFileTypes: true }).filter(item => item.isDirectory())
      const writes = specs.map(spec => {
        if (!SLUG.test(spec.name)) throw new Error('Invalid archived specification name')
        return [child(context.artifactRoot, 'openspec/specs/' + spec.name + '/spec.md'), readFileSync(child(context.artifactRoot, 'openspec/changes/' + change + '/specs/' + spec.name + '/spec.md'), 'utf8')] as const
      })
      const destination = child(context.artifactRoot, 'openspec/changes/archive/' + state.createdAt.slice(0, 10) + '-' + change)
      if (existsSync(destination)) throw new Error('Archive destination already exists')
      for (const [file, content] of writes) write(file, content)
      mkdirSync(path.dirname(destination), { recursive: true })
      renameSync(active, destination)
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
