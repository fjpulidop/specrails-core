// Requirement ↔ test traceability.
//
// Every OpenSpec requirement (`### Requirement: <name>` in
// `openspec/specs/<capability>/spec.md`) has a stable id
// `<capability>/<slug>`. A test claims a requirement with a tag in its title
// (`[spec:<capability>/<slug>]`) or a comment on the line before it
// (`// spec: <capability>/<slug>`, `# spec: …` for Python and shell; any
// language). The scanner crosses the tags with verification receipts: a
// requirement is demonstrated when a tagged test file was executed by a
// verification command that exited 0.
//
// This file is copied on its own into projects as
// `.specrails/runtime/spec-trace.mjs`, like pipeline-state.ts: Node built-ins
// only, no imports from the rest of Core.
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const SPEC_TRACE_SCHEMA_VERSION = 1
export const SPEC_TRACE_FILE = 'spec-trace.json'
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 1_048_576
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage', '.specrails', 'vendor', 'target', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', '.cache', 'openspec'])

/** A file that IS a test across ecosystems: `x.test.ts`, `x.spec.js`, `test_x.py`, `x_test.go`, `x_spec.rb`, `XTest.java`, `test_x.sh`, `x.bats`. */
export const TEST_FILE = /(?:^|\/)(?:test_[^/]+\.(?:py|sh)|[^/]+(?:\.(?:test|spec)\.[a-z0-9]+|_test\.(?:go|py|rs|rb|exs?|ts|js|sh)|_spec\.rb|Tests?\.(?:java|kt|cs|swift)|\.bats))$/i

/** `capability/slug`: lowercase, accents removed (NFKD), every run of non-alphanumerics a single dash, no leading or trailing dash. */
export function requirementSlug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
export function requirementId(capability: string, name: string): string { return `${capability}/${requirementSlug(name)}` }

export interface SpecRequirement { id: string; capability: string; name: string; file: string; line: number }
export interface TraceTest { repositoryId: string; file: string; line: number }
export interface TraceTag extends TraceTest { tag: string; form: 'title' | 'comment' }
export interface TraceRepository { id: string; root: string }
export interface TraceCommand { repositoryId: string; command: string; args: string[]; cwd?: string; exitCode: number | null }
export type ReachesTest = (root: string, command: { command: string; args: string[]; cwd?: string }, file: string) => boolean
export interface SpecTraceInput {
  /** The checkout that holds `openspec/` (the run's artifact root). */
  specsRoot: string
  /** Changes whose ADDED/MODIFIED/RENAMED requirements are "touched" (and checked by `--check`). */
  changes?: string[]
  repositories: TraceRepository[]
  /** Explicit test files (the verification plan's or the developer's), repository-relative; added to discovery. */
  testFiles?: Array<{ repositoryId: string; file: string }>
  /** Restrict discovery to these repository-relative globs (`src/**\/*.test.ts`); default: every test-shaped file. */
  testGlobs?: string[]
  /** Verification evidence: the receipt Core recorded. */
  receipt?: { id?: string; commands: TraceCommand[] } | null
  /** No receipt, but the caller already ran the tests successfully (a CI step after `npm test`). */
  testsPassed?: boolean
  /** Whether a command executes a test file; Core injects its full reachability check. Default: literal argument inspection. */
  reaches?: ReachesTest
  now?: () => Date
}
export type UndemonstratedReason = 'no-test' | 'not-executed' | 'failed'
export interface SpecTraceReport {
  schemaVersion: typeof SPEC_TRACE_SCHEMA_VERSION
  generatedAt: string
  changes: string[]
  /** `receipt`: executed means reached by a passing receipt command; `tests-passed`: tagged files count as executed; `none`: nothing counts as executed. */
  evidence: 'receipt' | 'tests-passed' | 'none'
  receiptId: string | null
  requirements: number
  demonstrated: Array<{ id: string; name: string; tests: TraceTest[] }>
  undemonstrated: Array<{ id: string; name: string; reason: UndemonstratedReason; tests: TraceTest[] }>
  /** Tags that match no requirement (a typo, a renamed or removed requirement). Advisory. */
  untagged: TraceTag[]
  /** Requirements the changes add, modify or rename. */
  touched: string[]
  /** Touched requirements that are not demonstrated: what `--check` fails on. */
  touchedUndemonstrated: string[]
  scannedFiles: number
}

const posix = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '')
function readText(file: string): string | undefined {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined
    return readFileSync(file, 'utf8')
  } catch { return undefined }
}
function directories(root: string): string[] {
  try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort() } catch { return [] }
}
const REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*$/

/** Requirements of the canonical specs, in capability then file order. */
export function readSpecRequirements(specsRoot: string): SpecRequirement[] {
  const base = path.join(specsRoot, 'openspec', 'specs')
  return directories(base).flatMap(capability => {
    const file = path.join(base, capability, 'spec.md')
    const text = readText(file)
    if (text === undefined) return []
    return text.split(/\r?\n/).flatMap((line, index) => {
      const match = REQUIREMENT.exec(line)
      return match ? [{ id: requirementId(capability, match[1]!), capability, name: match[1]!, file: posix(path.relative(specsRoot, file)), line: index + 1 }] : []
    })
  })
}

export interface ChangeDelta { added: SpecRequirement[]; modified: SpecRequirement[]; removed: string[]; renamed: Array<{ from: string; to: SpecRequirement }> }
/** The change's directory: active, or its most recent archive (`archive/YYYY-MM-DD-<change>`). */
export function changeDirectory(specsRoot: string, change: string): string | undefined {
  const active = path.join(specsRoot, 'openspec', 'changes', change)
  if (existsSync(active)) return active
  const archive = path.join(specsRoot, 'openspec', 'changes', 'archive')
  const found = directories(archive).filter(name => name === change || (/^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === change)).at(-1)
  return found ? path.join(archive, found) : undefined
}
/** ADDED / MODIFIED / REMOVED / RENAMED requirements of a change's delta specs. */
export function readChangeDelta(specsRoot: string, change: string): ChangeDelta {
  const delta: ChangeDelta = { added: [], modified: [], removed: [], renamed: [] }
  const directory = changeDirectory(specsRoot, change)
  if (!directory) return delta
  for (const capability of directories(path.join(directory, 'specs'))) {
    const file = path.join(directory, 'specs', capability, 'spec.md')
    const text = readText(file)
    if (text === undefined) continue
    let section = ''
    let from: string | undefined
    text.split(/\r?\n/).forEach((line, index) => {
      const heading = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\b/i.exec(line)
      if (heading) { section = heading[1]!.toUpperCase(); return }
      if (/^##\s/.test(line)) { section = ''; return }
      const requirement = (name: string): SpecRequirement => ({ id: requirementId(capability, name), capability, name, file: posix(path.relative(specsRoot, file)), line: index + 1 })
      if (section === 'RENAMED') {
        const rename = /^\s*-\s*(FROM|TO):\s*`?\s*###\s+Requirement:\s*(.+?)\s*`?\s*$/i.exec(line)
        if (!rename) return
        if (rename[1]!.toUpperCase() === 'FROM') from = requirementId(capability, rename[2]!)
        else if (from) { delta.renamed.push({ from, to: requirement(rename[2]!) }); from = undefined }
        return
      }
      const match = REQUIREMENT.exec(line)
      if (!match) return
      if (section === 'ADDED') delta.added.push(requirement(match[1]!))
      else if (section === 'MODIFIED') delta.modified.push(requirement(match[1]!))
      else if (section === 'REMOVED') delta.removed.push(requirementId(capability, match[1]!))
    })
  }
  return delta
}
/** Active (unarchived) changes, for a CI check that names none. */
export function activeChanges(specsRoot: string): string[] {
  return directories(path.join(specsRoot, 'openspec', 'changes')).filter(name => name !== 'archive' && existsSync(path.join(specsRoot, 'openspec', 'changes', name, 'specs')))
}

const TITLE_TAG = /\[spec:\s*([^\]\s]+)\s*\]/gi
const COMMENT_TAG = /^\s*(?:\/\/+|#+|--+|;+|%+|\/\*+|\*+|<!--|\{-|\(\*)\s*spec:\s*([^\s*]+)/i
/** Tags in a test file's text with their 1-based lines. */
export function scanTags(text: string): Array<{ tag: string; line: number; form: 'title' | 'comment' }> {
  const tags: Array<{ tag: string; line: number; form: 'title' | 'comment' }> = []
  text.split(/\r?\n/).forEach((line, index) => {
    const comment = COMMENT_TAG.exec(line)
    if (comment) { tags.push({ tag: comment[1]!.replace(/[,;.]+$/, '').toLowerCase(), line: index + 1, form: 'comment' }); return }
    for (const match of line.matchAll(TITLE_TAG)) tags.push({ tag: match[1]!.toLowerCase(), line: index + 1, form: 'title' })
  })
  return tags
}

function globToRegExp(glob: string): RegExp {
  const source = posix(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*')
  return new RegExp(`^${source}$`)
}
function discoverTests(root: string, globs: RegExp[] | undefined): string[] {
  const found: string[] = []
  const walk = (directory: string, relative: string): void => {
    if (found.length >= MAX_FILES) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (entry.isSymbolicLink()) continue
      const name = relative ? relative + '/' + entry.name : entry.name
      if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path.join(directory, entry.name), name); continue }
      if (entry.isFile() && (globs ? globs.some(glob => glob.test(name)) : TEST_FILE.test(name))) found.push(name)
      if (found.length >= MAX_FILES) return
    }
  }
  walk(root, '')
  return found
}

/** Literal reachability: a command naming test-shaped paths reaches only those; any other command is assumed to discover every test. */
export const literalReaches: ReachesTest = (root, command, file) => {
  const base = path.resolve(root, command.cwd ?? '.')
  const target = posix(path.relative(base, path.resolve(root, file)))
  const tokens = [command.command, ...command.args].filter(token => !token.startsWith('-')).map(posix)
  // A bare word is a path only when it names an existing directory (`pytest tests`), never a script or verb (`npm test`).
  const directory = (token: string): boolean => { try { return lstatSync(path.resolve(base, token)).isDirectory() } catch { return false } }
  const paths = tokens.slice(1).filter(token => TEST_FILE.test(token) || token.includes('*') || ((token.includes('/') || directory(token)) && !/^(?:run|test|exec)$/.test(token)))
  if (!paths.length) return true
  return paths.some(token => token === target || target.startsWith(token.replace(/\/$/, '') + '/') || (token.includes('*') && globToRegExp(token).test(target)))
}

/** The traceability report for the specs and tests under the input roots. Never throws for unreadable files; they are skipped. */
export function traceSpecs(input: SpecTraceInput): SpecTraceReport {
  const changes = [...new Set(input.changes ?? [])]
  const requirements = new Map<string, SpecRequirement>()
  for (const requirement of readSpecRequirements(input.specsRoot)) if (!requirements.has(requirement.id)) requirements.set(requirement.id, requirement)
  const touched = new Set<string>()
  for (const change of changes) {
    const delta = readChangeDelta(input.specsRoot, change)
    for (const id of delta.removed) requirements.delete(id)
    for (const { from, to } of delta.renamed) { requirements.delete(from); requirements.set(to.id, to); touched.add(to.id) }
    for (const requirement of [...delta.added, ...delta.modified]) { if (!requirements.has(requirement.id)) requirements.set(requirement.id, requirement); touched.add(requirement.id) }
  }
  const globs = input.testGlobs?.length ? input.testGlobs.map(globToRegExp) : undefined
  const tags: TraceTag[] = []
  let scannedFiles = 0
  for (const repository of input.repositories) {
    const files = new Set(discoverTests(repository.root, globs))
    for (const explicit of input.testFiles ?? []) if (explicit.repositoryId === repository.id) files.add(posix(explicit.file))
    for (const file of [...files].sort()) {
      const absolute = path.resolve(repository.root, file)
      const relative = posix(path.relative(repository.root, absolute))
      if (!relative || relative.startsWith('..')) continue
      const text = readText(absolute)
      if (text === undefined) continue
      scannedFiles += 1
      for (const tag of scanTags(text)) tags.push({ ...tag, repositoryId: repository.id, file: relative })
    }
  }
  const receipt = input.receipt ?? null
  const evidence: SpecTraceReport['evidence'] = receipt ? 'receipt' : input.testsPassed ? 'tests-passed' : 'none'
  const reaches = input.reaches ?? literalReaches
  const roots = new Map(input.repositories.map(repository => [repository.id, repository.root]))
  const execution = new Map<string, 'passed' | 'failed' | 'not-executed'>()
  const executed = (test: TraceTest): 'passed' | 'failed' | 'not-executed' => {
    const key = test.repositoryId + '\0' + test.file
    const cached = execution.get(key)
    if (cached) return cached
    let result: 'passed' | 'failed' | 'not-executed' = evidence === 'tests-passed' ? 'passed' : 'not-executed'
    if (receipt) {
      const root = roots.get(test.repositoryId)!
      const reaching = receipt.commands.filter(command => command.repositoryId === test.repositoryId && safeReach(reaches, root, command, test.file))
      result = reaching.some(command => command.exitCode === 0) ? 'passed' : reaching.length ? 'failed' : 'not-executed'
    }
    execution.set(key, result)
    return result
  }
  const byRequirement = new Map<string, TraceTest[]>()
  const untagged: TraceTag[] = []
  for (const tag of tags) {
    if (!requirements.has(tag.tag)) { untagged.push(tag); continue }
    const list = byRequirement.get(tag.tag) ?? []
    if (!list.some(item => item.repositoryId === tag.repositoryId && item.file === tag.file && item.line === tag.line)) list.push({ repositoryId: tag.repositoryId, file: tag.file, line: tag.line })
    byRequirement.set(tag.tag, list)
  }
  const demonstrated: SpecTraceReport['demonstrated'] = []
  const undemonstrated: SpecTraceReport['undemonstrated'] = []
  for (const requirement of [...requirements.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
    const tests = byRequirement.get(requirement.id) ?? []
    const outcomes = tests.map(executed)
    if (outcomes.includes('passed')) demonstrated.push({ id: requirement.id, name: requirement.name, tests: tests.filter((_, index) => outcomes[index] === 'passed') })
    else undemonstrated.push({ id: requirement.id, name: requirement.name, reason: !tests.length ? 'no-test' : outcomes.includes('failed') ? 'failed' : 'not-executed', tests })
  }
  const missing = new Set(undemonstrated.map(item => item.id))
  return {
    schemaVersion: SPEC_TRACE_SCHEMA_VERSION, generatedAt: (input.now?.() ?? new Date()).toISOString(), changes, evidence, receiptId: receipt?.id ?? null,
    requirements: requirements.size, demonstrated, undemonstrated, untagged, touched: [...touched].sort(), touchedUndemonstrated: [...touched].filter(id => missing.has(id)).sort(), scannedFiles,
  }
}
function safeReach(reaches: ReachesTest, root: string, command: TraceCommand, file: string): boolean {
  try { return reaches(root, { command: command.command, args: command.args, ...(command.cwd ? { cwd: command.cwd } : {}) }, file) } catch { return true }
}

/** Requirement ids a change adds, modifies or renames: the ones its developer tags and `--check` enforces. */
export function touchedRequirements(specsRoot: string, change: string): string[] {
  const delta = readChangeDelta(specsRoot, change)
  return [...new Set([...delta.added, ...delta.modified, ...delta.renamed.map(item => item.to)].map(item => item.id))].sort()
}

/** One-line summary shown to hosts and reviewers: `Requirements demonstrated X/Y`. */
export function traceSummary(report: Pick<SpecTraceReport, 'demonstrated' | 'requirements'>): string {
  return `Requirements demonstrated ${report.demonstrated.length}/${report.requirements}`
}
export function renderTraceReport(report: SpecTraceReport): string {
  const lines = [traceSummary(report) + (report.evidence === 'none' ? ' (no verification evidence: pass --tests-passed after running the tests, or --context for a run receipt)' : '')]
  if (report.touched.length) lines.push(`Touched by ${report.changes.join(', ')}: ${report.touched.length - report.touchedUndemonstrated.length}/${report.touched.length} demonstrated`)
  for (const item of report.undemonstrated) lines.push(`  ${report.touched.includes(item.id) ? '!' : '-'} ${item.id} (${item.reason}${item.tests.length ? ': ' + item.tests.map(test => test.file + ':' + test.line).join(', ') : ''})`)
  for (const tag of report.untagged) lines.push(`  ? ${tag.repositoryId}:${tag.file}:${tag.line} tags unknown requirement ${tag.tag}`)
  return lines.join('\n') + '\n'
}

interface TraceFlags { root?: string; context?: string; change: string[]; tests: string[]; testsPassed: boolean; check: boolean; json: boolean; out?: string }
function parseTraceFlags(argv: string[]): TraceFlags {
  const flags: TraceFlags = { change: [], tests: [], testsPassed: false, check: false, json: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = (): string => {
      const next = inline ?? argv[++index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`)
      return next
    }
    if (name === 'trace') continue
    else if (name === '--check') flags.check = true
    else if (name === '--json') flags.json = true
    else if (name === '--tests-passed') flags.testsPassed = true
    else if (name === '--root') flags.root = value()
    else if (name === '--context') flags.context = value()
    else if (name === '--out') flags.out = value()
    else if (name === '--change') flags.change.push(...value().split(',').map(item => item.trim()).filter(Boolean))
    else if (name === '--tests') flags.tests.push(...value().split(',').map(item => item.trim()).filter(Boolean))
    else throw new Error('Unknown trace option: ' + arg)
  }
  return flags
}
function contextInput(file: string, flags: TraceFlags): Omit<SpecTraceInput, 'reaches'> {
  const context = JSON.parse(readFileSync(file, 'utf8')) as { artifactRoot?: unknown; backlogRoot?: unknown; runId?: unknown; repositories?: unknown }
  if (typeof context.artifactRoot !== 'string' || !Array.isArray(context.repositories)) throw new Error('Invalid pipeline context: artifactRoot and repositories are required')
  const repositories = context.repositories.map(item => item as { id?: unknown; path?: unknown }).filter(item => typeof item.id === 'string' && typeof item.path === 'string').map(item => ({ id: item.id as string, root: item.path as string }))
  let receipt: SpecTraceInput['receipt'] = null
  let change: string | undefined
  if (typeof context.backlogRoot === 'string' && typeof context.runId === 'string' && /^[A-Za-z0-9._-]+$/.test(context.runId)) {
    const stateFile = path.join(context.backlogRoot, '.specrails', 'pipeline', context.runId, 'state.json')
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) as { change?: unknown; verification?: { id?: string; commands?: TraceCommand[] } } : undefined
    if (typeof state?.change === 'string') change = state.change
    if (state?.verification && Array.isArray(state.verification.commands)) receipt = { ...(state.verification.id ? { id: state.verification.id } : {}), commands: state.verification.commands }
  }
  return { specsRoot: context.artifactRoot, repositories, changes: flags.change.length ? flags.change : change ? [change] : activeChanges(context.artifactRoot), receipt, testsPassed: flags.testsPassed, ...(flags.tests.length ? { testGlobs: flags.tests } : {}) }
}

/**
 * `pipeline trace [--root <dir>] [--context <context.json>] [--change <name>[,…]] [--tests <glob>[,…]] [--tests-passed] [--check] [--json] [--out <file>]`.
 * Normal mode is fail-open: it reports and exits 0 even when it cannot read
 * something. `--check` exits 1 when a requirement touched by the change is
 * not demonstrated (or the scan itself fails).
 */
export async function runSpecTraceCli(argv: string[], options: { reaches?: ReachesTest; stdout?: (text: string) => void; stderr?: (text: string) => void } = {}): Promise<number> {
  const stdout = options.stdout ?? (text => process.stdout.write(text))
  const stderr = options.stderr ?? (text => process.stderr.write(text))
  let flags: TraceFlags | undefined
  try {
    flags = parseTraceFlags(argv)
    const root = path.resolve(flags.root ?? process.cwd())
    const input: SpecTraceInput = flags.context
      ? contextInput(flags.context, flags)
      : { specsRoot: root, repositories: [{ id: path.basename(root) || 'root', root }], changes: flags.change.length ? flags.change : activeChanges(root), testsPassed: flags.testsPassed, ...(flags.tests.length ? { testGlobs: flags.tests } : {}) }
    const report = traceSpecs({ ...input, ...(options.reaches ? { reaches: options.reaches } : {}) })
    if (flags.out) writeFileSync(flags.out, JSON.stringify(report, null, 2) + '\n')
    stdout(flags.json ? JSON.stringify(report) + '\n' : renderTraceReport(report))
    if (flags.check && report.touchedUndemonstrated.length) {
      stderr(`Spec trace check failed: ${report.touchedUndemonstrated.length} touched requirement${report.touchedUndemonstrated.length === 1 ? '' : 's'} not demonstrated: ${report.touchedUndemonstrated.join(', ')}\n`)
      return 1
    }
    return 0
  } catch (error) {
    stderr('Spec trace: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    return flags?.check || argv.includes('--check') ? 1 : 0
  }
}
