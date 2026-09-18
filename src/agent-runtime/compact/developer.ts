import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { detectCheckCommand, installEnvironment, runGroupCheck } from './environment.js'
import { unreachedTestFiles, unreachedTestsReason } from './test-reachability.js'
import type { ChatMessage } from './chat-client.js'
import path from 'node:path'
import { AgentExecutionError, type AgentResult } from '../executor-types.js'
import { artifactPath, type OpenSpecApply, type OpenSpecStatus } from '../openspec.js'
import { readVerificationEvidence } from '../../installer/runtime/pipeline-state.js'
import { bounded } from './prompt-inputs.js'
import { finalJson, on, openspecCall, strings, text, toolStep, type CompactEnv } from './step.js'

/** Tool calls one task group may spend before it must report. */
export const DEFAULT_TASK_TOOL_BUDGET = 25
/** Frozen planning artifacts: the developer edits application code, never the plan. */
const FROZEN_PATH = /(?:^|[\\/])openspec[\\/]/i
const DEVELOPER_TOOLS = ['list_files', 'read_file', 'read_lines', 'search_text', 'get_diff', 'write_file', 'apply_patch']
const stringList = { type: 'array', items: { type: 'string' } }
export const TASK_RESULT_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'files', 'tests', 'verification', 'incomplete'], properties: { summary: { type: 'string' }, files: stringList, tests: stringList, verification: { type: 'string' }, incomplete: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['task', 'reason'], properties: { task: { type: 'string' }, reason: { type: 'string' } } } } } }

export interface TaskGroup { index: number; title: string; tasks: { id: string; text: string; done: boolean }[] }
/** Parses the `## N. Title` / `- [ ] N.M text` layout the OpenSpec tasks template prescribes. */
export function parseTaskGroups(markdown: string): TaskGroup[] {
  const groups: TaskGroup[] = []
  let current: TaskGroup | undefined
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(\d+)\.\s*(.*)$/.exec(line)
    if (heading) { current = { index: Number(heading[1]), title: heading[2]!.trim(), tasks: [] }; groups.push(current); continue }
    const task = /^\s*-\s+\[([ xX])\]\s+((\d+(?:\.\d+)?)\s+)?(.*)$/.exec(line)
    if (!task) continue
    if (!current) { current = { index: groups.length + 1, title: 'Tasks', tasks: [] }; groups.push(current) }
    current.tasks.push({ id: task[3] ?? `${current.index}.${current.tasks.length + 1}`, text: task[4]!.trim(), done: task[1] !== ' ' })
  }
  return groups
}
/** Paths written or patched by successful tool calls in a loop transcript. */
export function writtenFiles(messages: readonly ChatMessage[]): string[] {
  const calls = new Map<string, string>()
  const files: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call.function.name !== 'write_file' && call.function.name !== 'apply_patch') continue
        try { const args = JSON.parse(call.function.arguments) as { path?: unknown }; if (typeof args.path === 'string') calls.set(call.id, args.path) } catch { /* malformed: not executed */ }
      }
    } else if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      const file = calls.get(message.tool_call_id)
      if (file && typeof message.content === 'string' && !/^\s*\{\s*"error"/.test(message.content) && !files.includes(file)) files.push(file)
    }
  }
  return files
}
/** Relative source/test paths a task sentence names (`src/game.js`, `tests/smoke.test.js`). */
export function namedFiles(task: string): string[] {
  // A plan may spell a path relative to the test file (`../src/tetris.js`,
  // `./tetromino.js`): the evidence gate checks repository-relative paths, so
  // the leading `./` and `../` segments are dropped and a bare `./x.js` keeps
  // only its basename to be located by extension family under any root dir.
  const matches = task.match(/(?:^|[\s`'"(,])((?:\.{1,2}\/)*(?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|rb|php|c|cc|cpp|h|hpp|vue|svelte|html|css|scss|sql|json|ya?ml|toml|md))(?=[\s`'"),.:;]|$)/g) ?? []
  return [...new Set(matches.map(match => match.replace(/^[\s`'"(,]/, '').trim().replace(/^(?:\.{1,2}\/)+/, '')))].filter(file => file.includes('/') ? !/^openspec\//.test(file) : false)
}
/**
 * Turns the two failure shapes small models never fix on their own into
 * concrete, file-precise correction items: an import that resolves to a file
 * that does not exist (the host locates the real one), and a missing module.
 * Generic Node/Jest/TS and Python signatures; anything else passes through.
 */
export function diagnoseVerificationFailure(feedback: string, roots: readonly string[]): string[] {
  const items: string[] = []
  const seen = new Set<string>()
  for (const match of feedback.matchAll(/Cannot find module '([^']+)' from '([^']+)'/g)) {
    const [, target, from] = match
    if (!target || !from || seen.has(target + from)) continue
    seen.add(target + from)
    if (!target.startsWith('.')) { items.push(`${from}: the import '${target}' is a package that is not installed or a file that does not exist; add the dependency or fix the import`); continue }
    const base = path.basename(target).replace(/\.[cm]?[jt]sx?$/, '')
    const found = roots.flatMap(root => findFiles(root, base)).map(file => file.replace(/\\/g, '/'))
    const fromDir = path.posix.dirname(from.replace(/\\/g, '/'))
    const suggestion = found.length ? ` The file exists at ${found.slice(0, 3).join(' / ')}; from ${from} the correct import is '${found.map(file => { const rel = path.posix.relative(fromDir, file.replace(/\.[cm]?[jt]sx?$/, '')); return rel.startsWith('.') ? rel : './' + rel }).slice(0, 1)[0]}'.` : ` No file named ${base} exists anywhere in the repository: create it or point the import at the real module.`
    items.push(`${from}: the import '${target}' does not resolve.${suggestion}`)
  }
  for (const match of feedback.matchAll(/ModuleNotFoundError: No module named '([^']+)'/g)) {
    const name = match[1]
    if (!name || seen.has(name)) continue
    seen.add(name)
    items.push(`Python cannot import '${name}': create that module in the package or fix the import path`)
  }
  return items
}
function findFiles(root: string, base: string, depth = 0): string[] {
  if (depth > 6) return []
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return [] }
  const out: string[] = []
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.') || entry === 'openspec') continue
    const full = path.join(root, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) out.push(...findFiles(full, base, depth + 1).map(file => path.join(entry, file)))
    else if (entry.replace(/\.[cm]?[jt]sx?$/, '') === base && /\.[cm]?[jt]sx?$/.test(entry)) out.push(entry)
  }
  return out
}
/** Application source/test files under the roots (bounded), excluding plans, deps and dot dirs. */
export function repositoryInventory(roots: readonly string[], limit = 60): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6 || out.length >= limit) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (entry === 'node_modules' || entry === 'target' || entry === 'openspec' || entry.startsWith('.')) continue
      const full = path.join(dir, entry)
      let stat
      try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory()) walk(full, rel ? `${rel}/${entry}` : entry, depth + 1)
      else if (/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|rb|php|c|cc|cpp|h|hpp|vue|svelte)$/.test(entry)) out.push(rel ? `${rel}/${entry}` : entry)
    }
  }
  for (const root of roots) walk(root, '', 0)
  return out
}
const LANGUAGE_BY_EXT: Record<string, string> = { ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift', cs: 'C#', rb: 'Ruby', php: 'PHP', c: 'C', cc: 'C++', cpp: 'C++', h: 'C', hpp: 'C++', vue: 'Vue', svelte: 'Svelte' }
export interface LanguageProfile { primary: string; others: string[] }
/**
 * The repository's primary language (most source files; a tsconfig.json or a
 * TypeScript `main` breaks a JS/TS tie towards TypeScript) plus every other
 * language present. Advisory: a mixed repository keeps every language, the
 * profile only tells the model which one NEW files default to.
 */
export function languageProfile(roots: readonly string[]): LanguageProfile | undefined {
  const counts = new Map<string, number>()
  for (const file of repositoryInventory(roots, 400)) {
    const language = LANGUAGE_BY_EXT[path.extname(file).slice(1).toLowerCase()]
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1)
  }
  const hasTsConfig = roots.some(root => existsSync(path.join(root, 'tsconfig.json')))
  const tsMain = roots.some(root => { try { return /\.[cm]?tsx?$/.test(String(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).main ?? '')) } catch { return false } })
  if ((hasTsConfig || tsMain) && !counts.has('TypeScript')) counts.set('TypeScript', 0)
  if (!counts.size) return undefined
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    if ((hasTsConfig || tsMain) && (a[0] === 'TypeScript') !== (b[0] === 'TypeScript')) return a[0] === 'TypeScript' ? -1 : 1
    return a[0].localeCompare(b[0])
  })
  // A JS/TS tie (or a TS project whose only files so far are JS config) still resolves to TypeScript when the project declares it.
  if ((hasTsConfig || tsMain) && counts.has('TypeScript') && ranked[0]![0] === 'JavaScript' && (counts.get('JavaScript')! - counts.get('TypeScript')!) <= 2) ranked.sort((a, b) => (a[0] === 'TypeScript' ? -1 : b[0] === 'TypeScript' ? 1 : 0))
  return { primary: ranked[0]![0], others: ranked.slice(1).map(([language]) => language) }
}
/**
 * A new file that would duplicate an existing sibling in the primary language
 * (`src/board.js` next to `src/board.ts`): the sibling to extend, else undefined.
 * Rewriting an existing file or adding a file in a secondary language with no
 * primary-language twin is never flagged, so mixed repositories keep working.
 */
export function duplicateSibling(roots: readonly string[], file: string, primary: string): string | undefined {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (!ext || LANGUAGE_BY_EXT[ext] === primary) return undefined
  const stem = file.slice(0, -ext.length - 1)
  for (const root of roots) {
    if (existsSync(path.join(root, file))) return undefined
    for (const [candidate, language] of Object.entries(LANGUAGE_BY_EXT)) {
      if (language !== primary) continue
      const sibling = `${stem}.${candidate}`
      if (existsSync(path.join(root, sibling))) return sibling
    }
  }
  return undefined
}
/**
 * A NEW source file in a language the repository does not use at all
 * (`src/feature.ts` in a JavaScript-only game): the reason to refuse, else
 * undefined. Only fires when the repository is monolingual — a mixed
 * repository may legitimately grow a second language — and never for
 * rewrites, config/data files or a language family sibling (a .ts repo
 * adding .tsx is fine).
 */
export function foreignLanguageFile(roots: readonly string[], file: string, languages: LanguageProfile): string | undefined {
  const ext = path.extname(file).slice(1).toLowerCase()
  const language = LANGUAGE_BY_EXT[ext]
  if (!language || language === languages.primary || languages.others.length) return undefined
  if (roots.some(root => existsSync(path.join(root, file)))) return undefined
  return `"${file}" is ${language}, but this repository is ${languages.primary}-only. Write the same behaviour in ${languages.primary} inside the existing modules; do not add a second language.`
}
/** Existing test directories (relative, POSIX) among the conventional names, e.g. `tests`, `test`, `__tests__`, `spec`. */
export function existingTestDirs(roots: readonly string[]): string[] {
  const names = ['tests', 'test', '__tests__', 'spec', 'specs']
  return [...new Set(roots.flatMap(root => names.filter(name => { try { return statSync(path.join(root, name)).isDirectory() } catch { return false } })))]
}
/**
 * A NEW test file outside the directory the repository already keeps its
 * tests in (`src/hold.test.js` next to an existing `tests/`): the reason to
 * refuse, else undefined. Co-located tests (`foo.test.js` beside `foo.js`)
 * are accepted when the repository has no test directory at all.
 */
export function misplacedTestFile(roots: readonly string[], file: string): string | undefined {
  const normalized = file.replace(/\\/g, '/')
  if (!/(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py|rs|rb)$/.test(normalized)) return undefined
  if (roots.some(root => existsSync(path.join(root, file)))) return undefined
  const dirs = existingTestDirs(roots)
  if (!dirs.length || dirs.some(dir => normalized === dir || normalized.startsWith(dir + '/'))) return undefined
  return `"${file}" is a test file outside the repository's test directory (${dirs.join(', ')}); write it under ${dirs[0]}/ so the test command finds it.`
}
const TEST_FILE = /^(.+)\.(?:test|spec)\.[cm]?[jt]sx?$/
/**
 * For a NEW test file whose name extends a module's canonical test file
 * (`tests/board.tick.test.ts` next to `tests/board.test.ts`), that canonical
 * file; else undefined. The canonical file itself and rewrites never flag.
 */
export function siblingTestFile(roots: readonly string[], file: string): string | undefined {
  const base = path.basename(file), dir = path.dirname(file)
  const stem = TEST_FILE.exec(base)?.[1]
  if (!stem || !stem.includes('.')) return undefined
  const module = stem.split('.')[0]!
  const canonical = new RegExp(`^${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\.(?:test|spec)\.[cm]?[jt]sx?$`)
  for (const root of roots) {
    if (existsSync(path.join(root, file))) return undefined
    let entries: string[] = []
    try { entries = readdirSync(path.join(root, dir)) } catch { continue }
    const existing = entries.find(entry => canonical.test(entry))
    if (existing) return (dir === '.' ? existing : `${dir}/${existing}`).split(path.sep).join('/')
  }
  return undefined
}
const SIBLING_EXTENSIONS: Record<string, string[]> = { js: ['ts', 'tsx', 'jsx', 'mjs', 'cjs', 'mts', 'cts'], ts: ['tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'], jsx: ['tsx', 'js', 'ts'], tsx: ['jsx', 'ts', 'js'], mjs: ['js', 'ts', 'mts'], cjs: ['js', 'ts', 'cts'], mts: ['ts', 'mjs'], cts: ['ts', 'cjs'] }
/** The absolute path a task-named file resolves to: the exact path, else the same stem in a sibling extension of the same language family. */
export function locateNamedFile(roots: readonly string[], file: string): string | undefined {
  for (const root of roots) if (existsSync(path.join(root, file))) return path.join(root, file)
  const ext = path.extname(file).slice(1).toLowerCase()
  const stem = ext ? file.slice(0, -ext.length - 1) : file
  for (const alternative of SIBLING_EXTENSIONS[ext] ?? []) for (const root of roots) if (existsSync(path.join(root, `${stem}.${alternative}`))) return path.join(root, `${stem}.${alternative}`)
  return undefined
}
/** Extra tool calls a correction group gets on top of the task budget: it must read AND patch, and the feedback is long. */
export const CORRECTION_BUDGET_BONUS = 10
/**
 * Source excerpts around every `file:line` the feedback names (Jest/Babel
 * `path/file.js: … (30:56)`, TS `file.ts(12,3)` / `file.ts:12:3`, mocha
 * `at … (file.js:44:9)`), read by the HOST so a correction round starts with
 * the offending lines in front of the model instead of spending its tool
 * budget re-reading the whole repository (observed: 19 reads, 2 patches).
 */
export function feedbackExcerpts(feedback: string, roots: readonly string[], options: { context?: number; maxBytes?: number } = {}): string {
  const context = options.context ?? 15, maxBytes = options.maxBytes ?? 8000
  const refs = new Map<string, Set<number>>()
  const add = (file: string, line: number): void => {
    if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|rb|php|c|cc|cpp|h|hpp|vue|svelte)$/.test(file) || /node_modules|^\/?openspec\//.test(file)) return
    const set = refs.get(file) ?? new Set<number>()
    set.add(line); refs.set(file, set)
  }
  // Windows paths (`C:\...\file.js`) are accepted and folded to `/` so the node_modules/openspec guards and the root lookup see one shape.
  for (const match of feedback.matchAll(/((?:[A-Za-z]:)?(?:[\/\\]|[\w.-]+[\/\\])?[\w.\/\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|rb|php|c|cc|cpp|h|hpp|vue|svelte))(?::(\d+)(?::\d+)?|\((\d+),\d+\)|:[^\n]{0,160}?\((\d+):\d+\))/g)) {
    const line = Number(match[2] ?? match[3] ?? match[4])
    if (Number.isFinite(line) && line > 0) add(match[1]!.replace(/\\/g, '/'), line)
  }
  const chunks: string[] = []
  let bytes = 0
  for (const [file, lines] of refs) {
    const absolute = path.isAbsolute(file) ? file : roots.map(root => path.join(root, file)).find(candidate => existsSync(candidate))
    if (!absolute || !existsSync(absolute)) continue
    let text: string
    try { text = readFileSync(absolute, 'utf8') } catch { continue }
    const all = text.split('\n')
    const relative = (roots.map(root => path.relative(root, absolute)).find(rel => rel && !rel.startsWith('..')) ?? file).split(path.sep).join('/')
    for (const line of [...lines].sort((a, b) => a - b).slice(0, 4)) {
      const from = Math.max(1, line - context), to = Math.min(all.length, line + context)
      const body = all.slice(from - 1, to).map((row, index) => `${String(from + index).padStart(4)}${from + index === line ? '>' : ' '} ${row}`).join('\n')
      const chunk = `--- ${relative} (lines ${from}-${to}, error at ${line}) ---\n${body}`
      if (bytes + chunk.length > maxBytes) return chunks.join('\n\n')
      chunks.push(chunk); bytes += chunk.length
    }
  }
  return chunks.join('\n\n')
}
/** An existing file this long is edited with apply_patch, never regenerated whole (observed: a 1.4k-line test rewritten twice in one group, ~25 minutes of generation). */
export const REWRITE_MAX_LINES = 150
/** Above this many lines, `read_file` answers with an outline (head + index of definitions) instead of the whole file. */
export const OUTLINE_MIN_LINES = 400
const OUTLINE_HEAD_LINES = 120
const DEFINITION_LINE = /^\s*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*\w+|(?:export\s+)?class\s+\w+|(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)|(?:static\s+|async\s+|get\s+|set\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{|(?:describe|it|test|suite|context)\s*\(|def\s+\w+|func\s+(?:\([^)]*\)\s*)?\w+|(?:pub\s+)?fn\s+\w+)/
/**
 * A large file as an outline: the first lines (imports, top-level state) and
 * an index of definitions with their line numbers, so the model asks for the
 * range it needs with read_lines instead of putting 15k tokens of test file
 * into the transcript on every read (observed: 4-minute prefills).
 */
export function outlineLargeFile(file: string, content: string): string | undefined {
  const lines = content.split('\n')
  if (lines.length <= OUTLINE_MIN_LINES) return undefined
  const index: string[] = []
  for (let i = OUTLINE_HEAD_LINES; i < lines.length && index.length < 120; i++) if (DEFINITION_LINE.test(lines[i]!)) index.push(`L${i + 1}: ${lines[i]!.trim().slice(0, 110)}`)
  return JSON.stringify({ outline: true, path: file, totalLines: lines.length, head: lines.slice(0, OUTLINE_HEAD_LINES).join('\n'), definitions: index, note: `${file} has ${lines.length} lines; this is its first ${OUTLINE_HEAD_LINES} lines plus an index of definitions. Read only the range you need with read_lines(path, startLine, endLine); do not read the whole file.` })
}
/** Files a model writes to narrate its own work; never part of a task, always noise for the reviewer (observed: fix_summary.json, task-summary.json in the repository root). */
export const NARRATION_FILE = /(?:^|\/)(?:[\w.-]*(?:summary|progress|scratch|handoff)[\w.-]*)\.(?:json|md|txt)$/i
/** Media/binary extensions a text-only tool can never produce correctly. */
export const BINARY_ASSET = /\.(?:wav|mp3|ogg|flac|m4a|aac|png|jpe?g|gif|webp|bmp|ico|woff2?|ttf|otf|eot|mp4|webm|mov|zip|gz|tar|pdf|wasm)$/i
/** Extra write-only calls a task group gets when it spent its whole budget reading. */
export const WRITE_EXTENSION_CALLS = 6
/** Tool calls the in-place fix round after a failed group check may spend. */
export const GROUP_FIX_BUDGET = 20
/**
 * One bounded correction round for a group whose check just failed: the exact
 * output plus host-read excerpts around every reported file:line, the group's
 * tasks as context, and the developer tools. Returns the files it wrote.
 */
async function fixGroupInPlace(env: CompactEnv, group: TaskGroup, output: string, budget: number, evidence: Parameters<typeof readVerificationEvidence>[0] | undefined, extraTools: unknown[], languages: LanguageProfile | undefined, headline = `The repository's test command failed right after your changes. Fix the failure with the tools; patch the exact files and lines the output names (apply_patch, or rewrite the file); do not list or re-read the repository beyond those files`): Promise<string[]> {
  const excerpts = feedbackExcerpts(output, env.toolset.roots)
  const written: string[] = []
  try {
    const loop = await toolStep(env, {
      system: `${headline}; do not edit anything under openspec/. Finish with one JSON object: {"summary":"what you fixed","files":["path"],"tests":[],"verification":"none","incomplete":[]}.`,
      user: `${/^Test file/.test(output) ? 'Host finding' : 'Failing test output'} (bounded):\n${bounded(output, 6000)}${excerpts ? `\n\nSource around each reported error (already read for you):\n${excerpts}` : ''}\n\nThe group you just implemented (group ${group.index}: ${group.title}):\n${group.tasks.map(task => `- ${task.id} ${task.text}`).join('\n')}\nEdit only inside: ${env.toolset.roots.join(', ')}.`,
      tools: DEVELOPER_TOOLS, maxToolCalls: Math.min(budget, GROUP_FIX_BUDGET), extraTools: extraTools as never,
      writeExtension: { tools: ['write_file', 'apply_patch'], extraCalls: 4 },
      execute: async (name, args) => {
        if ((name === 'write_file' || name === 'apply_patch') && typeof args.path === 'string' && FROZEN_PATH.test(args.path)) return JSON.stringify({ error: `"${args.path}" is under openspec/: the planning artifacts are frozen.` })
        if (name === 'write_file' && typeof args.path === 'string' && BINARY_ASSET.test(args.path)) return JSON.stringify({ error: `"${args.path}" is a binary asset; there is no shell to generate or download media. Produce the effect in application code instead.` })
        if (name === 'write_file' && typeof args.path === 'string' && NARRATION_FILE.test(args.path) && !/(?:^|\/)README\.md$/i.test(args.path)) return JSON.stringify({ error: `"${args.path}" is a narration file, not part of any task; do not write summary/progress/notes files.` })
        if (name === 'write_file' && typeof args.path === 'string') { const existing = env.toolset.roots.map(root => path.join(root, args.path as string)).find(file => existsSync(file)); if (existing && readFileSync(existing, 'utf8').split('\n').length > REWRITE_MAX_LINES) return JSON.stringify({ error: `"${args.path}" already exists and is large: change it with apply_patch, never regenerate it whole.` }) }
        if (name === 'read_file' && typeof args.path === 'string') { const existing = env.toolset.roots.map(root => path.join(root, args.path as string)).find(file => existsSync(file)); if (existing) { const outline = outlineLargeFile(args.path, readFileSync(existing, 'utf8')); if (outline) return outline } }
        if (on(env, 'primary-language') && name === 'write_file' && typeof args.path === 'string' && languages) { const foreign = foreignLanguageFile(env.toolset.roots, args.path, languages); if (foreign) return JSON.stringify({ error: foreign }) }
        if (on(env, 'one-test-per-module') && name === 'write_file' && typeof args.path === 'string') { const misplaced = misplacedTestFile(env.toolset.roots, args.path); if (misplaced) return JSON.stringify({ error: misplaced }) }
        if (on(env, 'duplicate-sibling') && name === 'write_file' && typeof args.path === 'string' && languages) { const twin = duplicateSibling(env.toolset.roots, args.path, languages.primary); if (twin) return JSON.stringify({ error: `"${args.path}" would duplicate "${twin}"; extend it instead.` }) }
        if (name === 'read_verification_evidence' && evidence) return JSON.stringify(readVerificationEvidence(evidence, args as Parameters<typeof readVerificationEvidence>[1]))
        const outcome = await env.toolset.execute(name, args)
        if ((name === 'write_file' || name === 'apply_patch') && typeof args.path === 'string' && !/"error"/.test(String(outcome).slice(0, 40))) written.push(args.path)
        return outcome
      },
    })
    void loop
  } catch (error) {
    if (!(error instanceof AgentExecutionError) || (error.code !== 'tool_loop' && error.code !== 'invalid_response')) throw error
    env.onEvent?.({ kind: 'text', text: `Group ${group.index} fix round stopped — ${error.message}.` })
  }
  return [...new Set(written)]
}
/** Test files among `reported` that the repository's own test command (per root) does not execute; empty when no command is detected. */
export function unreachedGroupTests(roots: readonly string[], reported: readonly string[]): string[] {
  return roots.flatMap(root => { const check = detectCheckCommand(root); return check ? unreachedTestFiles(root, [check], reported) : [] })
}
/** A source file that exists but carries no implementation: a handful of lines, a placeholder import, or only TODOs. */
export function isStubFile(file: string, minLines = 15): boolean {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return true }
  if (/from ['"]\?\?\?['"]|\bTODO\b.*implement|throw new Error\(['"]not implemented/i.test(text)) return true
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.py$|^test_/.test(path.basename(file))) return text.split('\n').filter(line => line.trim()).length < 5
  if (/\.(?:json|ya?ml|toml|md)$/.test(file) || /(?:^|[\\/])(?:index|mod)\.[cm]?[jt]sx?$/.test(file)) return false
  const code = text.split('\n').filter(line => line.trim() && !/^\s*(?:\/\/|#|\*|\/\*)/.test(line))
  // A barrel (only re-exports / imports) is complete however short it is —
  // observed: a 7-line src/exports.js re-declared a stub on every pass, the
  // task never ticked and the developer rewrote it for 20 minutes.
  if (code.length && code.every(line => /^\s*(?:export\s+(?:\*|\{|type\s*\{|default\s+\w+\s*;?$)[^;]*(?:from\s+['"][^'"]+['"])?\s*;?\s*$|export\s+\{[^}]*\}\s*;?\s*$|import\s|module\.exports\s*=|exports\.\w+\s*=|(?:const|let|var)\s+\w+\s*=\s*require\()/.test(line))) return false
  return code.length < minLines
}
/** Ticks the given task ids; every other byte of tasks.md is preserved, as the developer write rule requires. */
export function tickTasks(markdown: string, ids: Set<string>): string {
  return markdown.split('\n').map(line => {
    const task = /^(\s*-\s+)\[ \](\s+)(\d+(?:\.\d+)?)(\s.*)?$/.exec(line)
    return task && ids.has(task[3]!) ? `${task[1]}[x]${task[2]}${task[3]}${task[4] ?? ''}` : line
  }).join('\n')
}
function readArtifact(status: OpenSpecStatus, name: string): string {
  try { return readFileSync(artifactPath(status.changeRoot, name), 'utf8') } catch { return '' }
}

/**
 * The compact developer: one bounded mini-loop per task group with the full
 * developer tool set, the host ticking tasks.md and saving progress after each
 * group, and the DEVELOPER_OUTPUT_SCHEMA object assembled from the group results.
 */
export async function runCompactDeveloper(env: CompactEnv, options: { taskToolBudget?: number } = {}): Promise<AgentResult> {
  const budget = options.taskToolBudget ?? DEFAULT_TASK_TOOL_BUDGET
  const loaded = await openspecCall(env, { action: 'load_skill' }) as { planning?: { status: OpenSpecStatus; apply: OpenSpecApply }; savedProgress?: { record?: { progress?: unknown } | null } }
  const status = loaded.planning?.status ?? await openspecCall(env, { action: 'status' }) as OpenSpecStatus
  const tasksMarkdown = readArtifact(status, 'tasks.md')
  const groups = parseTaskGroups(tasksMarkdown)
  let pending = groups.filter(group => group.tasks.some(task => !task.done))
  // A correction pass arrives with every task already ticked: without this the
  // loop below runs nothing, reports "already checked" and the reviewer sees
  // the same issues again (observed: three rounds, scores 82 → 58 → 42, zero
  // edits). Turn the feedback into one synthetic correction group instead.
  if (!pending.length && env.inputs.feedback && on(env, 'synthetic-corrections')) {
    const diagnosed = diagnoseVerificationFailure(env.inputs.feedback, env.toolset.roots)
    const items = [...diagnosed, ...env.inputs.feedback.split('\n').map(line => line.replace(/^[\s*\-•]+/, '').trim()).filter(line => /^(?:[\w./-]+\.\w+\s*[:(]|[A-Z(])/.test(line) && line.length > 20 && !/^##/.test(line))].slice(0, 8)
    pending = [{ index: groups.length + 1, title: 'Review corrections', tasks: (items.length ? items : ['Address every issue listed in the feedback']).map((text, n) => ({ id: `R.${n + 1}`, text, done: false })) }]
  }
  const shared = [
    `Requested work (frozen scope):\n${bounded(env.inputs.scope, 3000)}`,
    `Design (excerpt):\n${bounded(readArtifact(status, 'design.md'), 3000)}`,
    `Specs (excerpt):\n${bounded((status.artifactPaths.specs?.existingOutputPaths ?? []).map(file => { try { return readFileSync(path.isAbsolute(file) ? file : path.join(status.changeRoot, file), 'utf8') } catch { return '' } }).join('\n\n'), 3000)}`,
    ...(env.inputs.feedback ? [`Feedback from the host (fix precisely):\n${bounded(env.inputs.feedback, 4000)}`] : []),
    ...(loaded.savedProgress?.record?.progress ? [`Saved progress from an earlier session (advisory):\n${bounded(JSON.stringify(loaded.savedProgress.record.progress), 1500)}`] : []),
  ].join('\n\n')
  const evidence = env.request.openspec?.evidenceScope
  const extraTools = evidence ? [{ type: 'function', function: { name: 'read_verification_evidence', description: 'Read host verification evidence by opaque id (from the feedback) with bounded cursors.', parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, section: { type: 'string', enum: ['summary', 'stdout', 'stderr', 'source'] }, sourceId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }] : []
  const summaries: string[] = [], files = new Set<string>(), tests = new Set<string>(), verification: string[] = [], incomplete: { task: string; reason: string }[] = [], completed: string[] = []
  for (const group of pending) {
    const open = group.tasks.filter(task => !task.done)
    // A small model sometimes gives up on a late group with an excuse the disk
    // contradicts ("no source files to test against" while src/ is populated).
    // The host does not accept that excuse: it retries the group ONCE with the
    // real inventory in front of the model. A second surrender stands.
    let contradiction = ''
    for (let attempt = 0; attempt < 2; attempt++) {
    const correction = group.title === 'Review corrections' || env.stance === 'fixer'
    const groupBudget = correction ? budget + CORRECTION_BUDGET_BONUS : budget
    const excerpts = correction && env.inputs.feedback ? feedbackExcerpts(env.inputs.feedback, env.toolset.roots) : ''
    // A "tests" group that arrives after every earlier group already wrote its
    // tests must extend them, not rewrite them (observed: smoke.test.js and
    // game-logic.test.js rewritten twice in the final group).
    const existingTests = /test|spec|verif/i.test(group.title) && !correction ? repositoryInventory(env.toolset.roots, 200).filter(file => /(?:\.|_|\/)(?:test|spec)s?[./]/i.test(file)) : []
    const testsNote = existingTests.length ? `\n\nTest files that already exist (written by earlier groups): ${existingTests.slice(0, 20).join(', ')}. EXTEND them with the missing cases (read, then apply_patch); do not rewrite them and do not create parallel files for the same module.` : ''
    const correctionNote = correction ? `\n\nThis is a CORRECTION round: the feedback names exact files and lines. Patch those lines directly with apply_patch (or rewrite the file); do not list or re-read the repository beyond the files named.${excerpts ? `\n\nSource around each reported error (already read for you):\n${excerpts}` : ''}` : ''
    // The FIXER stance for correction rounds: the verifier's exact output and
    // the host-read excerpts lead, only the plan tasks whose files the failure
    // names follow, and neither the frozen scope/design/specs dump nor the
    // OpenSpec apply guidance is sent — a correction is a repair, not an
    // implementation (observed: the developer re-read every file before its
    // first patch when the plan dump preceded the feedback).
    const fixerFiles = correction && env.inputs.feedback ? new Set(feedbackExcerpts(env.inputs.feedback, env.toolset.roots).match(/^--- (\S+) \(/gm)?.map(line => line.slice(4, -2)) ?? []) : new Set<string>()
    const relevantTasks = correction ? groups.flatMap(other => other.tasks).filter(task => namedFiles(task.text).some(file => [...fixerFiles].some(hit => hit.endsWith(file) || file.endsWith(hit)))).slice(0, 6) : []
    // The stance text is the host-editable fixer definition (Settings ▸ Agent
    // prompts ▸ Fixer) when the prompt carries one; the compact mechanics
    // (which tools, the openspec/ freeze, the JSON contract) are appended here.
    const fixerStance = env.stance === 'fixer' && env.inputs.definition ? env.inputs.definition : `You are the FIXER of a Specrails pipeline. The repository's verification just failed; your only job is to make it pass with minimal, precise edits. Read the failing output and the excerpts first; patch exactly the files and lines they name; never re-implement features, never rename or restructure.`
    const fixerSystem = `${fixerStance}\n\nMechanics: use apply_patch for exact fragments (rewrite a file only when a patch cannot express the change); never list or read the repository beyond the files the failure names; never edit anything under openspec/. Finish with one JSON object: {"summary":"what you fixed","files":["path"],"tests":["test path"],"verification":"none","incomplete":[{"task":"${open[0]!.id}","reason":"why"}]} listing under "incomplete" only failures you could not fix.`
    const fixerUser = correction ? `Verification output (exact, bounded):\n${bounded(env.inputs.feedback ?? '', 6000)}${excerpts ? `\n\nSource around each reported error (already read for you):\n${excerpts}` : ''}${relevantTasks.length ? `\n\nPlan tasks that cover the failing files (context, already implemented):\n${relevantTasks.map(task => `- ${task.id} ${task.text.slice(0, 300)}`).join('\n')}` : ''}\n\nFailures to fix (group ${group.index}: ${group.title}):\n${open.map(task => `- ${task.id} ${task.text}`).join('\n')}\nEdit only inside: ${env.toolset.roots.join(', ')}.` : ''
    // Each task group gets the full wall-clock budget: the previous groups'
    // work is already ticked and verified, so a slow third group must not be
    // paid for with the first two's minutes.
    env.resetDeadline?.()
    env.onEvent?.({ kind: 'text', text: `Compact ${correction ? 'fixer' : 'developer'}: task group ${group.index} (${group.title}) — ${open.length} task${open.length === 1 ? '' : 's'}, ${groupBudget} tool calls.${attempt ? ' (retry: the previous excuse contradicted the repository)' : ''}` })
    // Recomputed per group: the scaffold group decides the language the later
    // groups must follow (observed: a TS scaffold, then board.js/piece.js twins
    // of index.ts in the next group). Advisory in prose, enforced only for twins.
    const languages = languageProfile(env.toolset.roots)
    const languageNote = languages && on(env, 'primary-language') ? `\n\nPrimary language: ${languages.primary}${languages.others.length ? ` (also present: ${languages.others.join(', ')})` : ''}. New source files use the primary language unless the task or an existing sibling file says otherwise; never re-implement an existing module in another language.` : ''
    let loop: Awaited<ReturnType<typeof toolStep>>
    // Files this group wrote, tracked at the tool boundary so a group that
    // ends without any reply still gets credited for what landed on disk.
    const groupWrites: string[] = []
    try {
      loop = await toolStep(env, {
        system: correction ? fixerSystem : `Implement the listed tasks in the repository with the tools. Read before you edit; write complete files with write_file or exact fragments with apply_patch; keep changes minimal and consistent with the existing code; add or extend tests for what you change. Every test file you create must be executed by the repository's test command: when you add one, wire it into the test script or runner config in the same group — a test nobody runs proves nothing. There is NO shell here: you cannot run scripts, install packages, download or generate binary assets (audio, images, fonts) — anything that must exist at runtime is produced by application code (for example synthesize sounds with the Web Audio API instead of shipping .wav files), and a generator script you cannot run is worthless. Do not edit anything under openspec/. Finish with one JSON object: {"summary":"what you changed","files":["path"],"tests":["test path"],"verification":"commands you could not run: none","incomplete":[{"task":"${open[0]!.id}","reason":"why"}]} listing under "incomplete" only tasks you did not finish.`,
        user: correction ? fixerUser : `${shared}${contradiction}${languageNote}${testsNote}${correctionNote}\n\nTasks for this step (group ${group.index}: ${group.title}):\n${open.map(task => `- ${task.id} ${task.text}`).join('\n')}\nEdit only inside: ${env.toolset.roots.join(', ')}.`,
        tools: DEVELOPER_TOOLS, maxToolCalls: groupBudget, extraTools,
        writeExtension: { tools: ['write_file', 'apply_patch'], extraCalls: WRITE_EXTENSION_CALLS },
        execute: async (name, args) => {
          if (on(env, 'frozen-plan-writes') && (name === 'write_file' || name === 'apply_patch') && typeof args.path === 'string' && FROZEN_PATH.test(args.path)) return JSON.stringify({ error: `"${args.path}" is under openspec/: the planning artifacts are frozen. Implement the task in application source and test files instead (for example src/ or tests/).` })
          // The plan, design and specs are already in this prompt: browsing
          // openspec/ spends the budget on what the model was just given
          // (observed: 5 of 25 calls listing and reading the change directory).
          if ((name === 'read_file' || name === 'list_files' || name === 'read_lines' || name === 'search_text') && typeof args.path === 'string' && FROZEN_PATH.test(args.path + '/')) return JSON.stringify({ error: `"${args.path}" is the frozen plan you already received in this prompt (scope, design, specs, tasks). Do not read openspec/; spend the budget on application files.` })
          // An empty write_file over a populated file is a deletion in disguise (observed:
          // a correction pass left src/index.ts at 0 lines). Ask for intent instead.
          if (on(env, 'empty-write') && name === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string' && !args.content.trim()) {
            const target = env.toolset.roots.map(root => path.join(root, args.path as string)).find(file => existsSync(file))
            if (target && readFileSync(target, 'utf8').trim()) return JSON.stringify({ error: `"${args.path}" already has content; an empty write_file would erase it. Write the full new content, or apply_patch the fragment you want to change.` })
          }
          // One test file per module: a small model otherwise adds board.tick.test.ts,
          // tick-verification.test.ts… on every correction pass (observed: 10 suites for 7 modules).
          if (on(env, 'one-test-per-module') && name === 'write_file' && typeof args.path === 'string') {
            const sibling = siblingTestFile(env.toolset.roots, args.path)
            if (sibling) return JSON.stringify({ error: `"${args.path}" would add a second test file for the module "${sibling}" already covers. Extend "${sibling}" (read it, then write_file or apply_patch it) instead of creating a new test file.` })
          }
          // primary-language, enforced: a monolingual repository never grows a
          // second language through a stub (observed: `src/feature.ts` with
          // `export const feature = 2` in a vanilla-JS game, twice).
          // No shell ⇒ no way to produce real binary assets: a `write_file` of a
          // .wav/.png/… lands a 4-byte "RIFF" stub (observed) and a generator
          // script nobody can run. Refuse with the runtime alternative.
          if (name === 'write_file' && typeof args.path === 'string' && BINARY_ASSET.test(args.path)) return JSON.stringify({ error: `"${args.path}" is a binary asset; write_file only writes UTF-8 text and there is no shell to generate or download media. Produce the effect in application code instead (synthesize audio with the Web Audio API, draw graphics on the canvas), or make the feature fail open when the asset is absent.` })
          if (name === 'write_file' && typeof args.path === 'string' && NARRATION_FILE.test(args.path) && !/(?:^|\/)README\.md$/i.test(args.path)) return JSON.stringify({ error: `"${args.path}" is a narration file, not part of any task; the host records your summary from your final JSON reply. Do not write summary/progress/notes files.` })
          if (name === 'write_file' && typeof args.path === 'string') {
            const existing = env.toolset.roots.map(root => path.join(root, args.path as string)).find(file => existsSync(file))
            if (existing) { const lines = readFileSync(existing, 'utf8').split('\n').length; if (lines > REWRITE_MAX_LINES) return JSON.stringify({ error: `"${args.path}" already exists with ${lines} lines: do not regenerate it whole. Read the region you need with read_lines and change it with apply_patch (exact oldText → newText); several small patches are fine.` }) }
          }
          if (name === 'read_file' && typeof args.path === 'string') {
            const existing = env.toolset.roots.map(root => path.join(root, args.path as string)).find(file => existsSync(file))
            if (existing) { const outline = outlineLargeFile(args.path, readFileSync(existing, 'utf8')); if (outline) return outline }
          }
          if (name === 'list_files' && typeof args.path === 'string') {
            const listed = await env.toolset.execute(name, args)
            try { const parsed = JSON.parse(listed) as { entries?: Array<{ name: string }> }; if (Array.isArray(parsed.entries)) return JSON.stringify({ ...parsed, entries: parsed.entries.filter(entry => entry.name !== 'openspec') }) } catch { /* not json */ }
            return listed
          }
          if (on(env, 'primary-language') && name === 'write_file' && typeof args.path === 'string' && languages) {
            const foreign = foreignLanguageFile(env.toolset.roots, args.path, languages)
            if (foreign) return JSON.stringify({ error: foreign })
          }
          // A new test file goes where the repository keeps its tests (observed: `src/hold.test.js` beside an existing `tests/`, never run by the test script).
          if (on(env, 'one-test-per-module') && name === 'write_file' && typeof args.path === 'string') {
            const misplaced = misplacedTestFile(env.toolset.roots, args.path)
            if (misplaced) return JSON.stringify({ error: misplaced })
          }
          if (on(env, 'duplicate-sibling') && name === 'write_file' && typeof args.path === 'string' && languages) {
            const twin = duplicateSibling(env.toolset.roots, args.path, languages.primary)
            if (twin) return JSON.stringify({ error: `"${args.path}" would duplicate "${twin}" in ${languages.primary}, the repository's primary language. Extend "${twin}" (read it, then write_file or apply_patch it) instead of re-implementing it in another language.` })
          }
          if (name === 'read_verification_evidence' && evidence) return JSON.stringify(readVerificationEvidence(evidence, args as Parameters<typeof readVerificationEvidence>[1]))
          const outcome = await env.toolset.execute(name, args)
          if ((name === 'write_file' || name === 'apply_patch') && typeof args.path === 'string' && !/"error"/.test(String(outcome).slice(0, 40))) groupWrites.push(args.path)
          return outcome
        },
      })
    } catch (error) {
      // A small model stuck re-reading the same file (tool_loop), or one that
      // answers nothing even after the nudge (invalid_response), must not sink
      // a step whose earlier groups already produced verified code: close THIS
      // group as incomplete, credit the files it did write, and let the
      // workflow continue (observed: a 9B developer wrote five modules, then
      // went silent and the whole run failed).
      if (!(error instanceof AgentExecutionError) || (error.code !== 'tool_loop' && !(error.code === 'invalid_response' && on(env, 'silent-group-closure')))) throw error
      const written = [...new Set(groupWrites)]
      env.onEvent?.({ kind: 'text', text: `Compact developer: group ${group.index} stopped — ${error.message}; ${written.length ? `recorded ${written.length} written file${written.length === 1 ? '' : 's'}, ` : ''}its tasks stay open.` })
      incomplete.push(...open.slice(0, 20).map(task => ({ task: task.id, reason: error.message })))
      summaries.push(`Group ${group.index} (${group.title}): stopped — ${error.message}${written.length ? `; wrote ${written.join(', ')}` : ''}`)
      for (const file of written) files.add(file)
      for (const file of written.filter(file => /(?:\.|_|\/)(?:test|spec)s?[./]/i.test(file))) tests.add(file)
      continue
    }
    let result: Record<string, unknown>
    try {
      result = await finalJson(env, 'task', loop.messages, loop.text, TASK_RESULT_SCHEMA, value => text(value.summary) ? undefined : '"summary" must be a non-empty string')
    } catch (error) {
      // A small model sometimes ends a group with prose (or nothing) instead of
      // the result object, even after the structured retry. The work it did is
      // still on disk: reconstruct the result from the successful write calls
      // and leave the group's tasks open, so the graph continues instead of
      // failing a step whose earlier groups already landed code.
      if (!(error instanceof AgentExecutionError) || error.code !== 'invalid_response') throw error
      const written = writtenFiles(loop.messages)
      env.onEvent?.({ kind: 'text', text: `Compact developer: group ${group.index} gave no structured result; recorded ${written.length} written file${written.length === 1 ? '' : 's'} and left its tasks open.` })
      result = { summary: `Group ${group.index}: no structured reply; ${written.length ? `wrote ${written.join(', ')}` : 'no files written'}.`, files: written, tests: written.filter(file => /(?:\.|_|\/)(?:test|spec)s?[./]/i.test(file)), verification: 'none', incomplete: open.map(task => ({ task: task.id, reason: 'the model ended the step without a structured result' })) }
    }
    const unfinished = (Array.isArray(result.incomplete) ? result.incomplete : []).flatMap(item => {
      const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
      return entry && text(entry.task) ? [{ task: text(entry.task).slice(0, 1000), reason: text(entry.reason, 'not completed').slice(0, 2000) }] : []
    })
    if (attempt === 0 && on(env, 'inventory-retry') && unfinished.length && strings(result.files, 100, 500).length === 0) {
      const claimsEmpty = unfinished.some(item => /\bno\b[^.;:]{0,40}\b(?:files?|code|implementation|engine|modules?|sources?)\b|(?:is|are) missing|does not exist|not (?:been )?(?:implemented|created|found|present)|nothing to (?:test|build)/i.test(item.reason))
      const inventory = repositoryInventory(env.toolset.roots)
      if (claimsEmpty && inventory.length) {
        contradiction = `\n\nThe repository is NOT empty. It already contains these application files (read them, then implement the task on top of them):\n${inventory.map(file => `- ${file}`).join('\n')}\nYour previous reply claimed otherwise; that excuse is not accepted.`
        env.onEvent?.({ kind: 'text', text: `Compact developer: group ${group.index} claimed the repository lacks the code it needs, but ${inventory.length} application file${inventory.length === 1 ? '' : 's'} exist; retrying with the inventory.` })
        continue
      }
    }
    const unfinishedIds = new Set(open.filter(task => unfinished.some(item => item.task.includes(task.id) || task.text.includes(item.task))).map(task => task.id))
    // Evidence-gated ticking: a task that names files is done only when those
    // files exist. A model that reports "done" for src/game.js it never wrote
    // would otherwise tick the task and starve the next verify of a reason.
    const missingEvidence = new Map<string, string[]>()
    for (const task of open) {
      if (unfinishedIds.has(task.id) || !on(env, 'evidence-gated-ticking')) continue
      // A plan written before any code exists may say `src/engine.js` while the
      // developer (rightly) followed the repository's primary language and
      // wrote `src/engine.ts`: the same module in a sibling extension is evidence.
      const files = namedFiles(task.text)
      const located = new Map(files.map(file => [file, locateNamedFile(env.toolset.roots, file)]))
      const missing = files.filter(file => !located.get(file))
      const stubs = files.filter(file => located.get(file) && isStubFile(located.get(file)!))
      if (missing.length || stubs.length) { missingEvidence.set(task.id, [...missing, ...stubs.map(file => `${file} (stub)`)]); unfinishedIds.add(task.id) }
    }
    for (const [id, missing] of missingEvidence) { incomplete.push({ task: id, reason: `named files are missing or still stubs: ${missing.join(', ')}` }); env.onEvent?.({ kind: 'text', text: `Compact developer: task ${id} stays open — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing or still a stub.` }) }
    const done = open.filter(task => !unfinishedIds.has(task.id))
    summaries.push(`Group ${group.index} (${group.title}): ${text(result.summary).slice(0, 4000)}`)
    const groupFiles = new Set(strings(result.files, 100, 500))
    for (const file of groupFiles) files.add(file)
    // Manifests written by this group get their dependencies installed by the host, so verify checks the code and not the environment.
    if (on(env, 'environment-repair') && [...groupFiles].some(file => /(?:^|[\\/])(?:package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(file))) for (const outcome of installEnvironment(env.toolset.roots, { onEvent: env.onEvent, lockfileRepair: on(env, 'lockfile-repair') })) verification.push(outcome.detail)
    for (const file of strings(result.tests, 100, 500)) tests.add(file)
    if (text(result.verification)) verification.push(text(result.verification).slice(0, 500))
    // verify-per-group: run the repository's own test command now and let the
    // SAME group fix a failure while its context is fresh (one bounded round),
    // instead of discovering five broken suites at the end of the step.
    if (on(env, 'verify-per-group') && groupFiles.size && !correction) {
      const check = runGroupCheck(env.toolset.roots, { onEvent: env.onEvent })
      if (check.ran && !check.ok) {
        env.onEvent?.({ kind: 'text', text: `Group ${group.index} check failed (${check.command}); fixing in place before the next group.` })
        const fixed = await fixGroupInPlace(env, group, check.output, budget, evidence, extraTools, languages)
        for (const file of fixed) { files.add(file); groupFiles.add(file) }
        const again = runGroupCheck(env.toolset.roots, { onEvent: env.onEvent })
        env.onEvent?.({ kind: 'text', text: again.ok ? `Group ${group.index} check passed after the fix.` : `Group ${group.index} check still failing (${again.command}); the host verify will report it.` })
        verification.push(`group ${group.index} check ${again.ok ? 'passed' : 'failed'}: ${again.command ?? ''}`)
      } else if (check.ran) {
        env.onEvent?.({ kind: 'text', text: `Group ${group.index} check passed (${check.command}).` })
        // test-reachability, at group altitude: the check passed, but does it
        // RUN the test files this group wrote? An enumerating test script
        // skips a new file silently (observed: a browser suite with six
        // failing cases shipped green). Ask the same group to wire it in while
        // its context is fresh; the host verify re-checks at the end regardless.
        if (on(env, 'test-reachability')) {
          const unreached = unreachedGroupTests(env.toolset.roots, [...groupFiles, ...strings(result.tests, 100, 500)])
          if (unreached.length) {
            env.onEvent?.({ kind: 'text', text: `Group ${group.index} wrote ${unreached.join(', ')} but ${check.command} does not run ${unreached.length === 1 ? 'it' : 'them'}; asking the developer to wire ${unreached.length === 1 ? 'it' : 'them'} in.` })
            const fixed = await fixGroupInPlace(env, group, `${unreachedTestsReason(unreached)}\nThe repository's test command is: ${check.command}.`, budget, evidence, extraTools, languages, `The repository's test command does not execute test files you just wrote. Wire them into the test command (edit the package.json "test" script or the runner configuration so every test file runs), then make them pass; read only the manifest, the runner config and the test files named`)
            for (const file of fixed) { files.add(file); groupFiles.add(file) }
            const again = runGroupCheck(env.toolset.roots, { onEvent: env.onEvent })
            const still = unreachedGroupTests(env.toolset.roots, unreached)
            env.onEvent?.({ kind: 'text', text: still.length ? `Group ${group.index}: ${still.join(', ')} still not run by the test command; the host verify will report it.` : again.ok ? `Group ${group.index}: tests wired in and the check passed.` : `Group ${group.index}: tests wired in but the check now fails (${again.command}); the host verify will report it.` })
            verification.push(`group ${group.index} test reachability ${still.length ? `unresolved: ${still.join(', ')}` : 'ok'}${again.ran && !again.ok ? `; check failed: ${again.command ?? ''}` : ''}`)
          }
        }
      }
    }
    incomplete.push(...unfinished.slice(0, 20))
    completed.push(...done.map(task => `${task.id} ${task.text}`))
    const real = done.filter(task => !task.id.startsWith('R.'))
    if (real.length) await openspecCall(env, { action: 'write_artifact', path: 'tasks.md', content: tickTasks(readArtifact(status, 'tasks.md'), new Set(real.map(task => task.id))) })
    try {
      await openspecCall(env, { action: 'write_progress', progress: { summary: text(result.summary, 'No summary').slice(0, 1600), completedTasks: completed.slice(-20).map(item => item.slice(0, 400)), nextTasks: pending.filter(other => other.index > group.index).flatMap(other => other.tasks.filter(task => !task.done).map(task => `${task.id} ${task.text}`.slice(0, 400))).slice(0, 20), checks: [], blockers: unfinished.map(item => `${item.task}: ${item.reason}`.slice(0, 500)).slice(0, 12) } })
    } catch (error) { env.onEvent?.({ kind: 'text', text: `Progress handoff not saved: ${error instanceof Error ? error.message : String(error)}` }) }
    break
    }
  }
  if (!pending.length) summaries.push('Every task in tasks.md was already checked; nothing to implement.')
  const structured = { summary: summaries.join('\n'), files: [...files], tests: [...tests], verification: verification.length ? verification.join('; ') : 'none', incomplete }
  return { text: JSON.stringify(structured), usage: env.client.usage, structured }
}
