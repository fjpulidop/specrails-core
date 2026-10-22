/**
 * Project rules inventory (`specrails-core rules inventory`, also run by `init`).
 *
 * Two halves with a hard line between them:
 * - deterministic: discover the gates a repository already enforces (lint and
 *   format configs, strict TypeScript, architecture tests, git hooks, CI
 *   workflows, OpenSpec validation) and parse the rule statements written in
 *   CLAUDE.md, AGENTS.md and CONTRIBUTING.md, each with `file:line`;
 * - one AI call: classify every parsed statement as `enforcedBy` (a gate),
 *   `automatable` (with the check it would need) or `humanOnly`. The model never
 *   adds, drops or rewrites a statement; offline or without a provider every
 *   rule stays `unclassified`.
 *
 * The result is `.specrails/rules.json`. The runtime reads it back to give the
 * reviewer the `humanOnly` rules as human checks and to offer the discovered
 * gate commands as the default verification proposal.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PipelineContext } from '../pipeline/pipeline-state.js'
import type { ExecutorRegistry } from './executors.js'
import type { AgentExecutor, AgentUsage, RuntimeConfig } from './executor-types.js'

export const RULES_INVENTORY_VERSION = 1
export const RULES_FILE = '.specrails/rules.json'
export const RULE_SOURCE_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'] as const
export const GATE_KINDS = ['lint', 'format', 'typecheck', 'test', 'architecture', 'hook', 'ci', 'spec'] as const
export const RULE_STATUSES = ['enforcedBy', 'automatable', 'humanOnly', 'unclassified'] as const
export type GateKind = typeof GATE_KINDS[number]
export type RuleStatus = typeof RULE_STATUSES[number]

export interface RulesGate {
  id: string
  kind: GateKind
  /** Shell-free command line a host can run from the repository root. */
  command: string
  /** Repository-relative file that revealed the gate. */
  source: string
}
export interface ProjectRule {
  /** Stable across line moves: hash of the source file and the normalized statement. */
  id: string
  text: string
  /** `<repository-relative file>:<line>` of the statement's first line. */
  source: string
  status: RuleStatus
  /** With `enforcedBy`: the gate id (or the named test/check) that already enforces the rule. */
  enforcedBy?: string
  /** With `automatable`: the check that would enforce it. */
  proposedCheck?: string
}
export interface RulesClassification {
  status: 'classified' | 'cached' | 'offline' | 'unavailable' | 'failed' | 'empty'
  provider?: string
  model?: string
  reason?: string
  classifiedAt?: string
  usage?: AgentUsage
}
export interface RulesInventory {
  schemaVersion: 1
  generatedAt: string
  gates: RulesGate[]
  rules: ProjectRule[]
  classification: RulesClassification
}

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', '.specrails', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.turbo', '.cache', 'tmp'])
const MAX_WALK_ENTRIES = 20_000
const MAX_RULES = 200
const MAX_RULE_CHARS = 600
const MAX_CI_GATES = 20
const CHECK_COMMAND = /\b(test|tests|lint|eslint|prettier|biome|tsc|typecheck|type-check|vitest|jest|mocha|pytest|ruff|mypy|flake8|black|clippy|fmt|go\s+vet|go\s+test|cargo\s+test|rubocop|rspec|phpunit|phpstan|openspec\s+validate|check|verify|validate|audit)\b/i

const posix = (file: string): string => file.split(path.sep).join('/')
function readText(file: string): string | undefined {
  try { return readFileSync(file, 'utf8') } catch { return undefined }
}
function isFile(file: string): boolean {
  try { return statSync(file).isFile() } catch { return false }
}
function isDirectory(file: string): boolean {
  try { return statSync(file).isDirectory() } catch { return false }
}
function listDirectory(directory: string): string[] {
  try { return readdirSync(directory).sort() } catch { return [] }
}
/** JSON with comments and trailing commas (tsconfig, biome.jsonc). */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      out += char
      if (char === '\\') { out += text[index + 1] ?? ''; index++ }
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index++; out += '\n'; continue }
    if (char === '/' && text[index + 1] === '*') { index += 2; while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++; index++; continue }
    out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function packageRunner(root: string): (script: string) => string {
  if (isFile(path.join(root, 'pnpm-lock.yaml'))) return script => `pnpm run ${script}`
  if (isFile(path.join(root, 'yarn.lock'))) return script => `yarn run ${script}`
  if (isFile(path.join(root, 'bun.lockb')) || isFile(path.join(root, 'bun.lock'))) return script => `bun run ${script}`
  return script => script === 'test' ? 'npm test' : `npm run ${script}`
}
function scriptKind(name: string): GateKind | undefined {
  if (/(^|:)arch(itecture)?(:|$)/.test(name)) return 'architecture'
  if (/^lint(:[a-z0-9:_-]+)?$/.test(name)) return 'lint'
  if (/^(format|fmt|prettier)(:check)?$/.test(name) || /^format:check$/.test(name)) return 'format'
  if (/^(typecheck|type-check|types|tsc|check-types|check:types)$/.test(name)) return 'typecheck'
  if (/^test(:unit)?$/.test(name)) return 'test'
  if (/^(openspec|spec|specs)(:validate)?$/.test(name)) return 'spec'
  return undefined
}

/** Walk the repository for architecture tests and boundary configs, bounded and skipping generated trees. */
function architectureSources(root: string): string[] {
  const found: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let seen = 0
  while (queue.length && seen < MAX_WALK_ENTRIES) {
    const { dir, depth } = queue.shift()!
    for (const name of listDirectory(dir)) {
      if (++seen > MAX_WALK_ENTRIES) break
      const full = path.join(dir, name)
      let stats
      try { stats = statSync(full) } catch { continue }
      if (stats.isDirectory()) {
        if (depth < 6 && !SKIP_DIRECTORIES.has(name) && !name.startsWith('.')) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (/^(architecture|arch|boundaries|layering|dependency-rules)[._-].*\.(test|spec)\.[cm]?[jt]sx?$/i.test(name)
        || /^(architecture|arch)\.(test|spec)\.[cm]?[jt]sx?$/i.test(name)
        || /^test_(architecture|arch|boundaries|layering)\.py$/i.test(name)
        || /Arch(itecture)?Test\.(java|kt|cs)$/.test(name)) found.push(posix(path.relative(root, full)))
    }
  }
  return found.sort()
}

function testRunner(packageJson: Record<string, unknown> | undefined): string | undefined {
  const deps = { ...(packageJson?.dependencies as object | undefined), ...(packageJson?.devDependencies as object | undefined) } as Record<string, unknown>
  if ('vitest' in deps) return 'npx vitest run'
  if ('jest' in deps) return 'npx jest'
  if ('mocha' in deps) return 'npx mocha'
  return undefined
}

/** `run:` commands of a GitHub workflow (single line, literal `|` and folded `>` block scalars). */
export function workflowRunCommands(text: string): string[] {
  const commands: string[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[index]!)
    if (!match) continue
    const value = match[2]!.trim()
    if (value && !/^[|>][-+]?\s*(#.*)?$/.test(value)) { commands.push(value.replace(/^(['"])(.*)\1$/, '$2')); continue }
    const folded = value.startsWith('>')
    const indent = match[1]!.length
    const block: string[] = []
    for (index++; index < lines.length; index++) {
      const line = lines[index]!
      if (line.trim() && line.length - line.trimStart().length <= indent) { index--; break }
      block.push(line.trim())
    }
    if (folded) {
      // Folded scalars join lines with spaces; a blank line separates commands.
      commands.push(...block.join('\n').split(/\n\s*\n/).map(part => part.split('\n').join(' ').trim()).filter(Boolean))
      continue
    }
    let pending = ''
    for (const command of block) {
      if (!command || command.startsWith('#')) continue
      // Backslash continuations form one command.
      if (command.endsWith('\\')) { pending += command.slice(0, -1).trim() + ' '; continue }
      commands.push(pending + command)
      pending = ''
    }
    if (pending.trim()) commands.push(pending.trim())
  }
  return commands
}
/** Setup and shell plumbing, never a check on its own. */
const NOT_A_CHECK = /^(echo|printf|cd|export|mkdir|curl|wget|tar|unzip|chmod|sudo|apt|apt-get|brew|choco|winget|rm|cp|mv|ls|cat|source|set|if|then|else|fi|for|while|do|done|case|esac|git\s+config|test\s+-[a-z]|\[)\b|^\[/

/** The commands a simple hook runs; a scripted hook (control flow, variables, many lines) is one gate that runs the hook itself. */
function hookCommands(text: string, relative: string): string[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.includes('husky.sh') && !/^(exit\b|set\s)/.test(line))
  const scripted = lines.length > 3 || lines.some(line => /^(if|for|while|case|function)\b|[(){}]\s*$|^[A-Za-z_][A-Za-z0-9_]*=|^\./.test(line))
  return scripted ? [`sh ${relative}`] : lines
}

/** Deterministic gate discovery for one repository root. */
export function discoverGates(root: string): RulesGate[] {
  const gates: RulesGate[] = []
  const add = (gate: RulesGate): void => {
    if (!gate.command.trim() || gates.some(prior => prior.command === gate.command)) return
    let id = gate.id
    for (let suffix = 2; gates.some(prior => prior.id === id); suffix++) id = `${gate.id}-${suffix}`
    gates.push({ ...gate, id })
  }
  const exists = (relative: string): boolean => isFile(path.join(root, relative))
  const first = (candidates: readonly string[]): string | undefined => candidates.find(exists)

  let packageJson: Record<string, unknown> | undefined
  try { packageJson = JSON.parse(readText(path.join(root, 'package.json')) ?? 'null') ?? undefined } catch { packageJson = undefined }
  const scripts = (packageJson?.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {}) as Record<string, unknown>
  const run = packageRunner(root)
  const scriptKinds = new Map<GateKind, string>()
  for (const name of Object.keys(scripts).sort()) {
    const kind = scriptKind(name)
    if (!kind || typeof scripts[name] !== 'string') continue
    if (!scriptKinds.has(kind)) scriptKinds.set(kind, name)
    add({ id: name.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), kind, command: run(name), source: 'package.json' })
  }

  // Lint and format configurations without a package script still name a runnable tool.
  const eslint = first(['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'])
  if (eslint && !scriptKinds.has('lint')) add({ id: 'eslint', kind: 'lint', command: 'npx eslint .', source: eslint })
  const biome = first(['biome.json', 'biome.jsonc'])
  if (biome && !scriptKinds.has('lint')) add({ id: 'biome', kind: 'lint', command: 'npx biome check .', source: biome })
  const prettier = first(['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'])
  if (prettier && !scriptKinds.has('format')) add({ id: 'prettier', kind: 'format', command: 'npx prettier --check .', source: prettier })
  const pyproject = readText(path.join(root, 'pyproject.toml')) ?? ''
  if (exists('ruff.toml') || exists('.ruff.toml') || /^\[tool\.ruff/m.test(pyproject)) add({ id: 'ruff', kind: 'lint', command: 'ruff check .', source: exists('ruff.toml') ? 'ruff.toml' : exists('.ruff.toml') ? '.ruff.toml' : 'pyproject.toml' })
  if (/^\[tool\.black\]/m.test(pyproject)) add({ id: 'black', kind: 'format', command: 'black --check .', source: 'pyproject.toml' })
  if (/^\[tool\.mypy\]/m.test(pyproject) || exists('mypy.ini')) add({ id: 'mypy', kind: 'typecheck', command: 'mypy .', source: exists('mypy.ini') ? 'mypy.ini' : 'pyproject.toml' })
  const golangci = first(['.golangci.yml', '.golangci.yaml', '.golangci.toml'])
  if (golangci) add({ id: 'golangci-lint', kind: 'lint', command: 'golangci-lint run', source: golangci })
  if (exists('Cargo.toml')) {
    if (exists('rustfmt.toml') || exists('.rustfmt.toml')) add({ id: 'rustfmt', kind: 'format', command: 'cargo fmt --check', source: exists('rustfmt.toml') ? 'rustfmt.toml' : '.rustfmt.toml' })
    if (exists('clippy.toml') || exists('.clippy.toml')) add({ id: 'clippy', kind: 'lint', command: 'cargo clippy -- -D warnings', source: exists('clippy.toml') ? 'clippy.toml' : '.clippy.toml' })
  }
  const rubocop = first(['.rubocop.yml'])
  if (rubocop) add({ id: 'rubocop', kind: 'lint', command: 'bundle exec rubocop', source: rubocop })

  // Strict TypeScript is a gate only through the command that type-checks it.
  const tsconfigText = readText(path.join(root, 'tsconfig.json'))
  if (tsconfigText !== undefined) {
    let strict = false
    try { strict = (parseJsonc(tsconfigText) as { compilerOptions?: { strict?: unknown } } | null)?.compilerOptions?.strict === true } catch { strict = false }
    if (strict && !scriptKinds.has('typecheck')) add({ id: 'tsc-strict', kind: 'typecheck', command: 'npx tsc --noEmit', source: 'tsconfig.json' })
  }

  const runner = testRunner(packageJson)
  for (const file of architectureSources(root)) {
    const command = /\.py$/.test(file) ? `pytest ${file}` : /\.(java|kt|cs)$/.test(file) ? undefined : runner ? `${runner} ${file}` : undefined
    if (command) add({ id: 'architecture-tests', kind: 'architecture', command, source: file })
  }
  const cruiser = first(['.dependency-cruiser.js', '.dependency-cruiser.cjs', '.dependency-cruiser.json'])
  if (cruiser) add({ id: 'dependency-cruiser', kind: 'architecture', command: `npx depcruise --config ${cruiser} .`, source: cruiser })

  // Git hooks: the commands they run (husky, .githooks), or the hook manager.
  for (const hooksDir of ['.husky', '.githooks']) {
    for (const hook of listDirectory(path.join(root, hooksDir))) {
      if (!['pre-commit', 'pre-push', 'commit-msg'].includes(hook)) continue
      const relative = `${hooksDir}/${hook}`
      for (const command of hookCommands(readText(path.join(root, relative)) ?? '', relative)) add({ id: `hook-${hook}`, kind: 'hook', command, source: relative })
    }
  }
  if (exists('.pre-commit-config.yaml')) add({ id: 'pre-commit', kind: 'hook', command: 'pre-commit run --all-files', source: '.pre-commit-config.yaml' })
  const lefthook = first(['lefthook.yml', 'lefthook.yaml', '.lefthook.yml'])
  if (lefthook) add({ id: 'lefthook', kind: 'hook', command: 'npx lefthook run pre-commit', source: lefthook })

  // CI workflows: their check-like `run:` steps.
  let ciGates = 0
  for (const workflow of listDirectory(path.join(root, '.github', 'workflows')).filter(name => /\.ya?ml$/.test(name))) {
    const relative = `.github/workflows/${workflow}`
    const text = readText(path.join(root, relative)) ?? ''
    // Only workflows that gate changes (pull requests or pushes); release and scheduled jobs are not checks.
    if (!/^\s*(on:.*\b(pull_request|push)\b|(pull_request|pull_request_target|push)\s*:)/m.test(text)) continue
    for (const command of workflowRunCommands(text)) {
      if (ciGates >= MAX_CI_GATES || !CHECK_COMMAND.test(command) || NOT_A_CHECK.test(command) || /[$`{}]|\|\||^(Write-Host|node\s+-e)\b/.test(command) || command.length > 500) continue
      const before = gates.length
      add({ id: `ci-${workflow.replace(/\.ya?ml$/, '')}`, kind: 'ci', command, source: relative })
      if (gates.length > before) ciGates++
    }
  }

  if (isDirectory(path.join(root, 'openspec')) && !scriptKinds.has('spec')) add({ id: 'openspec-validate', kind: 'spec', command: 'npx openspec validate --all --strict', source: 'openspec/' })
  return gates
}

/** An imperative opening: list items outside a rules heading count when they start with one. */
const IMPERATIVE = /^(use|keep|prefer|avoid|follow|preserve|run|add|update|put|treat|report|append|ensure|never|always|do|don't|only|reuse|apply|bind|include|write|read|check|test|document|name|validate)\b/i
const STRONG = /\b(must|never|always|shall|do not|don't|required|forbidden|not allowed)\b/i
const RULE_HEADING = /\b(rule|rules|convention|conventions|guideline|guidelines|policy|policies|invariant|invariants|standard|standards|behaviou?r|design|style|contract|contracts|requirement|requirements|do|don't|must)\b/i

function cleanStatement(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?(?:a|b|i|em|strong|code|kbd|sup|sub|span|div|p|br|img|details|summary|small)(?:\s[^>]*)?\/?>/gi, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
function isStatement(text: string, underRuleHeading: boolean): boolean {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 4 || text.length < 16) return false
  if (/^[A-Z][\w /&-]*:$/.test(text)) return false
  return STRONG.test(text) || underRuleHeading || IMPERATIVE.test(text)
}
export function ruleId(file: string, text: string): string {
  return 'r-' + createHash('sha256').update(file + '\0' + text.toLowerCase()).digest('hex').slice(0, 12)
}

/**
 * Rule statements of one instruction file: list items (with their wrapped
 * continuation lines) and strongly normative paragraph sentences, outside code
 * fences, tables and Specrails-managed blocks.
 */
export function parseRuleStatements(text: string, file: string): Array<{ text: string; source: string }> {
  const out: Array<{ text: string; source: string }> = []
  const lines = text.split(/\r?\n/)
  let fence = false
  let managed = false
  let heading = ''
  let current: { text: string; line: number; list: boolean } | undefined
  const flush = (): void => {
    if (!current) return
    const cleaned = cleanStatement(current.text)
    const underRule = RULE_HEADING.test(heading)
    if (current.list) {
      if (isStatement(cleaned, underRule)) out.push({ text: cleaned.slice(0, MAX_RULE_CHARS), source: `${file}:${current.line}` })
    } else {
      // Paragraphs contribute their strongly normative sentences only.
      for (const sentence of cleaned.split(/(?<=[.!?])\s+(?=[A-Z`])/)) {
        if (STRONG.test(sentence) && isStatement(sentence, true)) out.push({ text: sentence.slice(0, MAX_RULE_CHARS), source: `${file}:${current.line}` })
      }
    }
    current = undefined
  }
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!
    const line = raw.trimEnd()
    if (line.includes('specrails-managed:start')) { flush(); managed = true; continue }
    if (line.includes('specrails-managed:end')) { managed = false; continue }
    if (managed) continue
    if (/^\s*(```|~~~)/.test(line)) { flush(); fence = !fence; continue }
    if (fence) continue
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line)
    if (headingMatch) { flush(); heading = headingMatch[1]!; continue }
    if (!line.trim() || /^\s*\|/.test(line) || /^\s*(<!--|-->)/.test(line) || /^\s*>/.test(line) || /^\s*[-*_]{3,}\s*$/.test(line)) { flush(); continue }
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      current = { text: item[2]!.replace(/^\[[ xX]\]\s+/, ''), line: index + 1, list: true }
      continue
    }
    if (current) { current.text += ' ' + line.trim(); continue }
    current = { text: line.trim(), line: index + 1, list: false }
  }
  flush()
  return out
}

/** Every rule statement of the instruction files present in `root`, deduplicated, with stable ids. */
export function collectRuleStatements(root: string): ProjectRule[] {
  const rules: ProjectRule[] = []
  const seen = new Set<string>()
  for (const file of RULE_SOURCE_FILES) {
    const text = readText(path.join(root, file))
    if (text === undefined) continue
    for (const statement of parseRuleStatements(text, file)) {
      const id = ruleId(file, statement.text)
      if (seen.has(id)) continue
      seen.add(id)
      rules.push({ id, text: statement.text, source: statement.source, status: 'unclassified' })
      if (rules.length >= MAX_RULES) return rules
    }
  }
  return rules
}

export const RULES_CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { enum: ['enforcedBy', 'automatable', 'humanOnly'] },
          enforcedBy: { type: 'string' },
          proposedCheck: { type: 'string' },
        },
      },
    },
  },
} as const

export function classificationPrompt(gates: readonly RulesGate[], rules: readonly ProjectRule[]): string {
  return [
    'You classify the written rules of a software project. Do not edit files, run commands or call tools: answer from the lists below.',
    '',
    'For each rule decide exactly one status:',
    '- `enforcedBy`: an existing gate below (or a test the repository already has) fails when the rule is broken. Set `enforcedBy` to the gate id, or to the named test or check when no gate id fits.',
    '- `automatable`: no gate enforces it today, but a deterministic check could (a lint rule, a test, a script). Set `proposedCheck` to that check in one sentence.',
    '- `humanOnly`: only a person can judge it (product intent, naming, UX, prose, process). No extra field.',
    'When unsure between `enforcedBy` and `automatable`, choose `automatable`: claim enforcement only when a listed gate plainly covers the rule.',
    '',
    '## Gates discovered in the repository',
    ...(gates.length ? gates.map(gate => `- \`${gate.id}\` (${gate.kind}, from ${gate.source}): \`${gate.command}\``) : ['- none']),
    '',
    '## Rules (id: text, source)',
    ...rules.map(rule => `- ${rule.id}: ${rule.text} (${rule.source})`),
    '',
    'Reply with exactly one JSON object and nothing else: {"rules":[{"id":"<id>","status":"enforcedBy|automatable|humanOnly","enforcedBy":"…","proposedCheck":"…"}]}, one entry per rule id above, ids copied verbatim. Never add, drop or rephrase a rule.',
  ].join('\n') + '\n'
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  for (const candidate of [trimmed, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)]) {
    try {
      const value = JSON.parse(candidate) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch { /* next candidate */ }
  }
  return undefined
}

/** Applies a model reply to the parsed rules: only known ids and statuses; text and source never change. */
export function applyClassification(rules: readonly ProjectRule[], reply: Record<string, unknown>): { rules: ProjectRule[]; classified: number } {
  const entries = Array.isArray(reply.rules) ? reply.rules : []
  const byId = new Map<string, Record<string, unknown>>()
  for (const entry of entries) if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') byId.set((entry as { id: string }).id, entry as Record<string, unknown>)
  let classified = 0
  const out = rules.map((rule): ProjectRule => {
    const entry = byId.get(rule.id)
    const status = entry?.status
    const base: ProjectRule = { id: rule.id, text: rule.text, source: rule.source, status: 'unclassified' }
    if (status === 'enforcedBy' && typeof entry!.enforcedBy === 'string' && entry!.enforcedBy.trim()) { classified++; return { ...base, status, enforcedBy: entry!.enforcedBy.trim().slice(0, 200) } }
    if (status === 'automatable') { classified++; return { ...base, status, ...(typeof entry!.proposedCheck === 'string' && entry!.proposedCheck.trim() ? { proposedCheck: entry!.proposedCheck.trim().slice(0, 400) } : {}) } }
    if (status === 'humanOnly') { classified++; return { ...base, status } }
    return base
  })
  return { rules: out, classified }
}

export function readRulesInventory(file: string): RulesInventory | undefined {
  const text = readText(file)
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as RulesInventory
    if (!value || value.schemaVersion !== RULES_INVENTORY_VERSION || !Array.isArray(value.gates) || !Array.isArray(value.rules)) return undefined
    return value
  } catch { return undefined }
}

function writeAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(temporary, file)
}

export interface RulesInventoryOptions {
  /** Repository whose gates and instruction files are inventoried. */
  root: string
  /** Directory holding `.specrails/` (rules.json and agent-runtime.json); defaults to `root`. */
  artifactRoot?: string
  /** false: deterministic only (gates + rules, unclassified unless cached). */
  classify?: boolean
  /** Ignore cached classifications and classify every rule again. */
  reclassify?: boolean
  /** Runtime configuration; defaults to `<artifactRoot>/.specrails/agent-runtime.json`. */
  config?: RuntimeConfig
  /** Programmatic executors (tests, hosts) replacing configured ones. */
  executors?: Record<string, AgentExecutor>
  registry?: ExecutorRegistry
  timeoutMs?: number
  signal?: AbortSignal
  now?: () => Date
}

/**
 * Builds and writes `.specrails/rules.json`. Rules whose statement did not
 * change keep their previous classification, so a re-run (and `init`) only
 * classifies what is new; the classification never blocks the inventory.
 */
export async function runRulesInventory(options: RulesInventoryOptions): Promise<{ file: string; inventory: RulesInventory }> {
  const root = path.resolve(options.root)
  const artifactRoot = path.resolve(options.artifactRoot ?? root)
  const file = path.join(artifactRoot, RULES_FILE)
  const now = (options.now ?? (() => new Date()))().toISOString()
  const gates = discoverGates(root)
  const parsed = collectRuleStatements(root)
  const previous = options.reclassify ? undefined : readRulesInventory(file)
  const cached = new Map((previous?.rules ?? []).filter(rule => rule.status !== 'unclassified').map(rule => [rule.id, rule]))
  let rules = parsed.map(rule => {
    const prior = cached.get(rule.id)
    return prior ? { ...prior, text: rule.text, source: rule.source } : rule
  })
  const pending = rules.filter(rule => rule.status === 'unclassified')
  let classification: RulesClassification
  if (!rules.length) classification = { status: 'empty' }
  else if (!pending.length) classification = { ...(previous?.classification ?? {}), status: 'cached' }
  else if (options.classify === false) classification = { status: 'offline', reason: `${pending.length} rule(s) left unclassified; run specrails-core rules inventory with a configured provider to classify them` }
  else classification = await classifyPending()
  const inventory: RulesInventory = { schemaVersion: RULES_INVENTORY_VERSION, generatedAt: now, gates, rules, classification }
  writeAtomic(file, inventory)
  return { file, inventory }

  async function classifyPending(): Promise<RulesClassification> {
    // Loaded on demand: the prompt and node readers of rules.json never pull in the executors.
    const [{ loadRuntimeConfig }, { createExecutorRegistry }] = await Promise.all([import('./config.js'), import('./executors.js')])
    let config = options.config
    const configFile = path.join(artifactRoot, '.specrails', 'agent-runtime.json')
    try { config ??= existsSync(configFile) ? loadRuntimeConfig(configFile, { registeredProviderIds: Object.keys(options.executors ?? {}) }) : undefined }
    catch (error) { return { status: 'unavailable', reason: `Runtime configuration is invalid: ${error instanceof Error ? error.message : String(error)}` } }
    if (!config) return { status: 'unavailable', reason: `No provider configured (${posix(path.relative(artifactRoot, configFile))} is missing); rules left unclassified` }
    const agent = config.agents.architect
    try {
      const registry = options.registry ?? createExecutorRegistry(config, { executors: options.executors })
      const result = await registry.execute(agent.provider, {
        role: 'prompt', instructions: 'none', artifacts: 'none', access: 'read',
        prompt: classificationPrompt(gates, pending), cwd: root, allowedRoots: [root],
        ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}),
        maxTurns: 4, timeoutMs: options.timeoutMs ?? config.limits?.timeoutMs ?? 10 * 60_000,
        outputSchema: RULES_CLASSIFICATION_SCHEMA as unknown as Record<string, unknown>,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const reply = result.structured ?? jsonObject(result.text)
      if (!reply) return { status: 'failed', provider: agent.provider, ...(agent.model ? { model: agent.model } : {}), reason: 'The classifier did not reply with a JSON object; rules left unclassified', usage: result.usage }
      const applied = applyClassification(pending, reply)
      const byId = new Map(applied.rules.map(rule => [rule.id, rule]))
      rules = rules.map(rule => byId.get(rule.id) ?? rule)
      const missing = pending.length - applied.classified
      return {
        status: 'classified', provider: agent.provider, ...(agent.model ? { model: agent.model } : {}), classifiedAt: now, usage: result.usage,
        ...(missing ? { reason: `${missing} rule(s) the classifier did not answer stay unclassified` } : {}),
      }
    } catch (error) {
      return { status: 'failed', provider: agent.provider, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** What the runtime hands the roles: the human-only rules and the discovered gates. */
export interface ProjectRulesContext {
  humanOnly: Array<Pick<ProjectRule, 'text' | 'source'>>
  gates: Array<Pick<RulesGate, 'id' | 'kind' | 'command'>>
}

/** Reads `.specrails/rules.json` next to the run's backlog, else in the artifact repository. */
export function projectRulesContext(context: Pick<PipelineContext, 'backlogRoot' | 'artifactRoot'>): ProjectRulesContext | undefined {
  for (const root of [context.backlogRoot, context.artifactRoot]) {
    const inventory = readRulesInventory(path.join(root, RULES_FILE))
    if (!inventory) continue
    const humanOnly = inventory.rules.filter(rule => rule.status === 'humanOnly' && typeof rule.text === 'string').slice(0, 30).map(rule => ({ text: rule.text, source: rule.source }))
    const gates = inventory.gates.filter(gate => typeof gate.command === 'string' && GATE_KINDS.includes(gate.kind)).slice(0, 20).map(gate => ({ id: gate.id, kind: gate.kind, command: gate.command }))
    return humanOnly.length || gates.length ? { humanOnly, gates } : undefined
  }
  return undefined
}

function summary(inventory: RulesInventory, file: string): string {
  const count = (status: RuleStatus) => inventory.rules.filter(rule => rule.status === status).length
  return [
    `Project rules inventory written to ${file}`,
    `  gates: ${inventory.gates.length}${inventory.gates.length ? ' (' + inventory.gates.map(gate => gate.id).join(', ') + ')' : ''}`,
    `  rules: ${inventory.rules.length} — enforcedBy ${count('enforcedBy')}, automatable ${count('automatable')}, humanOnly ${count('humanOnly')}, unclassified ${count('unclassified')}`,
    `  classification: ${inventory.classification.status}${inventory.classification.reason ? ' — ' + inventory.classification.reason : ''}`,
  ].join('\n') + '\n'
}

/** `specrails-core rules inventory [--root <dir>] [--artifact-root <dir>] [--offline] [--reclassify] [--json]`. */
export async function runRulesCommand(flags: Record<string, string | boolean>, positionals: string[], io: { stdout?: (text: string) => void; stderr?: (text: string) => void; executors?: Record<string, AgentExecutor> } = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => { process.stdout.write(text) })
  const stderr = io.stderr ?? ((text: string) => { process.stderr.write(text) })
  if (positionals[0] !== 'inventory' || positionals.length > 1) {
    stderr('Usage: specrails-core rules inventory [--root <dir>] [--artifact-root <dir>] [--offline] [--reclassify] [--json]\n')
    return 1
  }
  for (const key of ['root', 'artifact-root'] as const) {
    if (flags[key] !== undefined && typeof flags[key] !== 'string') { stderr(`--${key} needs a directory\n`); return 1 }
  }
  const root = path.resolve(typeof flags.root === 'string' ? flags.root : process.cwd())
  if (!isDirectory(root)) { stderr(`Not a directory: ${root}\n`); return 1 }
  const { file, inventory } = await runRulesInventory({
    root,
    artifactRoot: typeof flags['artifact-root'] === 'string' ? flags['artifact-root'] : root,
    classify: flags.offline !== true,
    reclassify: flags.reclassify === true,
    ...(io.executors ? { executors: io.executors } : {}),
  })
  stdout(flags.json === true ? JSON.stringify({ type: 'rules-inventory', file, ...inventory }) + '\n' : summary(inventory, file))
  return 0
}
