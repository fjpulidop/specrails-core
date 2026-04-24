import path from 'node:path'

import { copyDir, copyFile, isDir, listDir, mkdirp, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import { info, ok, warn } from '../util/logger.js'

import type { Provider } from './provider-detect.js'

/**
 * Phase 2 + Phase 3 of the retired install.sh:
 *   - Detect prior installation state (.claude/.codex/openspec already present).
 *   - Create the directory skeleton.
 *   - Copy templates into `.specrails/setup-templates/` (the source of
 *     truth the enrich + update flows read from).
 *   - Ensure `.gitignore` excludes the runtime artefacts.
 *
 * The Quick-tier direct placement (Phase 3c in bash) short-circuits
 * the enrich step: it copies the templates directly into the user's
 * live `.claude/agents/` and `.claude/commands/specrails/` dirs so
 * the installer finishes without requiring a Claude Code run.
 */

export interface ScaffoldInput {
  /** Absolute path to the specrails-core package (installed via npx). */
  scriptDir: string
  /** Absolute path to the user's repo root. */
  repoRoot: string
  /** Resolved provider from prereqs. */
  provider: Provider
  /** Derived directory name (`.claude` or `.codex`). */
  providerDir: string
  /** Whether to install Agent Teams commands (team-review / team-debug). */
  agentTeams: boolean
  /** Install tier — `quick` triggers the direct-placement path. */
  tier: 'full' | 'quick'
}

export interface ScaffoldResult {
  existingSetup: boolean
  createdDirs: string[]
  copiedFiles: number
}

/**
 * Returns true iff any of the provider directories already contains
 * content. The hub-driven path skips the "merge existing?" prompt and
 * assumes `--yes`; the CLI dispatcher (bin/specrails-core.cjs) should
 * have prompted before entering this phase.
 */
export function detectExistingSetup(input: Pick<ScaffoldInput, 'repoRoot' | 'providerDir'>): boolean {
  const roots = [
    path.join(input.repoRoot, input.providerDir, 'agents'),
    path.join(input.repoRoot, input.providerDir, 'commands'),
    path.join(input.repoRoot, input.providerDir, 'rules'),
    path.join(input.repoRoot, 'openspec'),
  ]
  for (const r of roots) {
    if (isDir(r) && listDir(r).length > 0) return true
  }
  return false
}

/**
 * Entry point. Creates directories, copies templates, updates
 * .gitignore. Returns a summary for logging / tests.
 */
export function scaffoldInstallation(input: ScaffoldInput): ScaffoldResult {
  const createdDirs: string[] = []
  let copiedFiles = 0

  const mk = (abs: string): void => {
    mkdirp(abs)
    createdDirs.push(abs)
  }

  // --- Directory skeleton ---
  mk(path.join(input.repoRoot, input.providerDir))
  if (input.provider === 'codex') {
    mk(path.join(input.repoRoot, '.agents', 'skills', 'enrich'))
    mk(path.join(input.repoRoot, '.agents', 'skills', 'doctor'))
  } else {
    mk(path.join(input.repoRoot, input.providerDir, 'commands', 'specrails'))
  }
  const setupTemplates = path.join(input.repoRoot, '.specrails', 'setup-templates')
  mk(path.join(setupTemplates, 'agents'))
  mk(path.join(setupTemplates, 'commands'))
  mk(path.join(setupTemplates, 'skills'))
  mk(path.join(setupTemplates, 'rules'))
  mk(path.join(setupTemplates, 'personas'))
  mk(path.join(setupTemplates, 'claude-md'))
  mk(path.join(setupTemplates, 'settings'))

  // --- .gitignore hygiene ---
  ensureGitignore(input.repoRoot, ['.claude/agent-memory/', '.specrails/'])

  // --- Copy bundled templates into setup-templates/ ---
  const templatesSrc = path.join(input.scriptDir, 'templates')
  if (pathExists(templatesSrc)) {
    copyDir(templatesSrc, setupTemplates, {
      filter: (_src, rel) => {
        // Skip node_modules + package-lock; manifest excludes them too.
        if (rel.includes('node_modules')) return false
        if (rel.endsWith('package-lock.json')) return false
        return true
      },
    })
    // Count files copied (approximate — recount via a flat listDir walk).
    copiedFiles = countFiles(setupTemplates)
  } else {
    warn(`templates/ not found at ${templatesSrc} — skipping template copy`)
  }

  // --- Write bundled commands (enrich.md + doctor.md) ---
  copyBundledCommands({ ...input, copiedIncrement: (n) => (copiedFiles += n) })

  // --- Quick tier: direct-placement short-circuit ---
  if (input.tier === 'quick') {
    const placed = placeQuickTierArtefacts({ ...input })
    copiedFiles += placed
    info(`Quick tier: placed ${placed} agent/rule files directly into ${input.providerDir}/`)
  }

  ok(`Created ${createdDirs.length} directories, copied ${copiedFiles} files`)

  return {
    existingSetup: detectExistingSetup({
      repoRoot: input.repoRoot,
      providerDir: input.providerDir,
    }),
    createdDirs,
    copiedFiles,
  }
}

function copyBundledCommands(input: ScaffoldInput & { copiedIncrement: (n: number) => void }): void {
  const commandsSrc = path.join(input.scriptDir, 'commands')
  if (!isDir(commandsSrc)) return

  if (input.provider === 'codex') {
    // Codex: write enrich + doctor as Agent Skills.
    copyFile(
      path.join(commandsSrc, 'enrich.md'),
      path.join(input.repoRoot, '.agents', 'skills', 'enrich', 'SKILL.md'),
    )
    copyFile(
      path.join(commandsSrc, 'doctor.md'),
      path.join(input.repoRoot, '.agents', 'skills', 'doctor', 'SKILL.md'),
    )
    input.copiedIncrement(2)
    return
  }

  // Claude: all commands land under <providerDir>/commands/specrails/.
  const destDir = path.join(input.repoRoot, input.providerDir, 'commands', 'specrails')
  let count = 0
  for (const entry of listDir(commandsSrc)) {
    const name = path.basename(entry)
    if (!name.endsWith('.md')) continue
    // Agent Teams gating — skip team-* commands unless explicitly opted in.
    if (!input.agentTeams && /^team-/.test(name)) continue
    copyFile(entry, path.join(destDir, name))
    count++
  }
  input.copiedIncrement(count)
}

function placeQuickTierArtefacts(input: ScaffoldInput): number {
  // Directly copy templates/agents/* → <providerDir>/agents/*
  // and templates/rules/* → <providerDir>/rules/* so the user can
  // start invoking agents immediately after install without running
  // the enrich phase.
  let count = 0
  const agentsSrc = path.join(input.scriptDir, 'templates', 'agents')
  const rulesSrc = path.join(input.scriptDir, 'templates', 'rules')
  if (isDir(agentsSrc)) {
    const agentsDest = path.join(input.repoRoot, input.providerDir, 'agents')
    copyDir(agentsSrc, agentsDest)
    count += countFiles(agentsDest)
  }
  if (isDir(rulesSrc)) {
    const rulesDest = path.join(input.repoRoot, input.providerDir, 'rules')
    copyDir(rulesSrc, rulesDest)
    count += countFiles(rulesDest)
  }
  return count
}

function ensureGitignore(repoRoot: string, entries: string[]): void {
  const p = path.join(repoRoot, '.gitignore')
  let current = ''
  if (pathExists(p)) {
    current = readTextFile(p)
  }
  const needed = entries.filter((e) => !lineInFile(current, e))
  if (needed.length === 0) return

  const prefix = current.endsWith('\n') || current.length === 0 ? '' : '\n'
  const block = ['', '# specrails', ...needed, ''].join('\n')
  writeFileLf(p, `${current}${prefix}${block}`)
}

function lineInFile(contents: string, line: string): boolean {
  return contents.split(/\r?\n/).some((l) => l.trim() === line.trim())
}

function countFiles(dir: string): number {
  if (!isDir(dir)) return 0
  let n = 0
  for (const entry of listDir(dir)) {
    if (isDir(entry)) n += countFiles(entry)
    else n++
  }
  return n
}
