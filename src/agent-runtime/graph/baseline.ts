import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pipelineStateDirectory, type PipelineContext } from '../../pipeline/pipeline-state.js'
import { TEST_FILE, readChangeDelta } from '../../pipeline/spec-trace.js'
import { TEST_FILE_PATTERN } from '../compact/test-reachability.js'
import { child, write } from './artifacts.js'
import { readCapabilityMap, qualifiedPath } from './capability-map.js'
import { designSection } from './clarifications.js'

/**
 * Baseline on touch: when the blast radius of a change reaches code no
 * capability covers, the plan gains a Baseline task group (characterization
 * tests of today's behaviour plus a minimal as-built spec) that must pass
 * against the unchanged code before the developer touches the module.
 */
export const BASELINE_SCHEMA_VERSION = 1
export const BASELINE_FILE = 'baseline.json'
/** Error code of the host blocker when characterization tests fail on the base code. */
export const BASELINE_BLOCKER = 'baseline_characterization_failed'

export interface BlastRadiusFile { repositoryId: string; path: string }
export interface BaselineDetection { blastRadius: string[]; covered: string[]; uncovered: string[]; skipped: string[] }
export interface BaselineRecord {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION
  change: string
  /** `not-needed`: every touched module is covered; `planned`: the architect added the Baseline group; `passed`/`failed`: characterization on the base code; `violated`: the baseline stage edited non-test files. */
  status: 'not-needed' | 'planned' | 'passed' | 'failed' | 'violated'
  recordedAt: string
  detection: BaselineDetection
  /** Characterization test files the developer wrote in the baseline stage. */
  tests: string[]
  receiptId?: string
  reason?: string
}

const GENERIC_DIRECTORIES = new Set(['src', 'lib', 'app', 'apps', 'packages', 'server', 'client', 'test', 'tests', 'spec', 'specs', 'source', 'internal', 'pkg', 'cmd'])
const NOT_CODE = /\.(?:md|mdx|txt|rst|adoc|lock|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|snap)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock)$/i
const posix = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '')

/** Files the design names under its Blast radius heading (backticked paths, or the first path-like token of a bullet). */
export function blastRadiusFiles(context: Pick<PipelineContext, 'repositories' | 'artifactRepositoryId'>, design: string): BlastRadiusFile[] {
  const lines = designSection(design, /\bblast\s+radius\b/i) ?? []
  const files: BlastRadiusFile[] = []
  for (const line of lines) {
    const ticks = [...line.matchAll(/`([^`\s]+)`/g)].map(match => match[1]!)
    const bare = /^\s*(?:[-*+]|\d+\.)\s+([\w@.~/-][^\s:—–(]*[\w)])/.exec(line)?.[1]
    for (const token of ticks.length ? ticks : bare ? [bare] : []) {
      const qualified = /^([A-Za-z0-9][\w.-]*):(.+)$/.exec(token)
      const repository = qualified && context.repositories.some(item => item.id === qualified[1]) ? qualified[1]! : context.artifactRepositoryId
      const file = posix(qualified && repository === qualified[1] ? qualified[2]! : token)
      if (!/[/.]/.test(file) || file.startsWith('..') || path.isAbsolute(file)) continue
      if (!files.some(item => item.repositoryId === repository && item.path === file)) files.push({ repositoryId: repository, path: file })
    }
  }
  return files
}
function specText(context: Pick<PipelineContext, 'artifactRoot'>): string {
  const root = path.join(context.artifactRoot, 'openspec', 'specs')
  try {
    return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
      try { return readFileSync(path.join(root, entry.name, 'spec.md'), 'utf8') } catch { return '' }
    }).join('\n')
  } catch { return '' }
}
/** A file is covered when the capability map lists it or a spec mentions it or one of its specific directories. */
function covered(file: string, mapped: ReadonlySet<string>, specs: string): boolean {
  if (mapped.has(file)) return true
  const plain = file.includes(':') ? file.slice(file.indexOf(':') + 1) : file
  if (specs.includes(plain)) return true
  const parts = plain.split('/').slice(0, -1)
  for (let depth = parts.length; depth >= 1; depth--) {
    const directory = parts.slice(0, depth).join('/')
    if (depth === 1 && GENERIC_DIRECTORIES.has(directory)) continue
    if (specs.includes(directory + '/')) return true
  }
  return false
}

/**
 * Intersects the design's blast radius with the capability map and the path
 * mentions in the canonical specs. Only existing code files can need a
 * baseline: new files, tests, documentation and lockfiles are skipped.
 */
export function detectBaseline(context: PipelineContext, change: string): BaselineDetection {
  const designFile = child(context.artifactRoot, 'openspec/changes/' + change + '/design.md')
  const design = existsSync(designFile) ? readFileSync(designFile, 'utf8') : ''
  const files = blastRadiusFiles(context, design)
  const map = readCapabilityMap(context)
  const mapped = new Set(Object.values(map.capabilities).flatMap(entry => entry.files))
  const specs = specText(context)
  const detection: BaselineDetection = { blastRadius: [], covered: [], uncovered: [], skipped: [] }
  for (const file of files) {
    const repository = context.repositories.find(item => item.id === file.repositoryId)
    const name = qualifiedPath(context, file.repositoryId, file.path)
    detection.blastRadius.push(name)
    const absolute = repository ? path.resolve(repository.path, file.path) : undefined
    if (!absolute || !existsSync(absolute) || NOT_CODE.test(file.path) || TEST_FILE.test(file.path) || TEST_FILE_PATTERN.test(file.path) || /^(?:openspec|\.specrails)\//.test(file.path)) { detection.skipped.push(name); continue }
    ;(covered(name, mapped, specs) ? detection.covered : detection.uncovered).push(name)
  }
  return detection
}

/** Throws a repairable error unless tasks.md has a Baseline group with a task and a delta spec adds at least one requirement. */
export function validateBaselinePlan(context: PipelineContext, change: string): void {
  const tasksFile = child(context.artifactRoot, 'openspec/changes/' + change + '/tasks.md')
  const tasks = existsSync(tasksFile) ? readFileSync(tasksFile, 'utf8') : ''
  const lines = tasks.split(/\r?\n/)
  const heading = lines.findIndex(line => /^#{1,6}\s.*\bbaseline\b/i.test(line))
  const next = heading < 0 ? -1 : lines.findIndex((line, index) => index > heading && /^#{1,6}\s/.test(line))
  const group = heading < 0 ? [] : lines.slice(heading + 1, next < 0 ? undefined : next)
  const problems: string[] = []
  if (!group.some(line => /^\s*-\s+\[[ x]\]/.test(line))) problems.push('tasks.md needs a `## Baseline` task group (before the change tasks) with at least one task')
  if (!readChangeDelta(context.artifactRoot, change).added.length) problems.push('a delta spec needs the as-built requirements under `## ADDED Requirements`')
  if (problems.length) throw new Error(`Invalid baseline plan: ${problems.join(' and ')}. Update the artifacts through the workflow, then resend the same JSON reply.`)
}

/** Test files among changed files (the characterization tests). */
export function testEdits(files: readonly string[]): string[] {
  return files.filter(file => (TEST_FILE.test(file) || TEST_FILE_PATTERN.test(file)) && !/^(?:openspec|\.specrails)\//.test(file))
}
/** Files of the baseline stage that are not tests: the module must stay untouched until characterization passes. */
export function nonTestEdits(files: readonly string[]): string[] {
  // OpenSpec artifacts (the Baseline tasks and as-built spec, OpenSpec's own config) are not the module.
  return files.filter(file => !(TEST_FILE.test(file) || TEST_FILE_PATTERN.test(file) || /^(?:openspec|\.specrails)\//.test(file)))
}

export function baselinePath(context: Pick<PipelineContext, 'backlogRoot' | 'runId'>): string {
  return path.join(pipelineStateDirectory(context as PipelineContext), BASELINE_FILE)
}
export function writeBaselineRecord(context: PipelineContext, entry: Omit<BaselineRecord, 'schemaVersion' | 'recordedAt'>): BaselineRecord {
  const record: BaselineRecord = { schemaVersion: BASELINE_SCHEMA_VERSION, recordedAt: new Date().toISOString(), ...entry }
  write(baselinePath(context), JSON.stringify(record, null, 2) + '\n')
  return record
}
export function readBaselineRecord(context: Pick<PipelineContext, 'backlogRoot' | 'runId'>): BaselineRecord | null {
  try {
    const file = baselinePath(context)
    if (!existsSync(file)) return null
    const value = JSON.parse(readFileSync(file, 'utf8')) as BaselineRecord
    return value && typeof value === 'object' && value.schemaVersion === BASELINE_SCHEMA_VERSION ? value : null
  } catch { return null }
}
