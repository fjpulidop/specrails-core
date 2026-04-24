import path from 'node:path'

import { copyDir, copyFile, isDir, listDir, mkdirp, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import { info, ok, warn } from '../util/logger.js'

import type { Provider } from './provider-detect.js'

/**
 * Agents excluded from the quick tier because they require a full
 * /specrails:enrich persona pass to function correctly.
 */
const QUICK_EXCLUDED_AGENTS = new Set(['sr-product-manager', 'sr-product-analyst'])

/**
 * Command → required agent dependency map. A command is excluded
 * from the quick tier when its required agent was excluded (i.e.
 * VPC-dependent) or when the feature flag (Agent Teams) is off.
 */
const COMMAND_AGENT_DEPENDENCIES: Array<{ command: string; requires: string[] }> = [
  { command: 'auto-propose-backlog-specs', requires: ['sr-product-manager'] },
  { command: 'vpc-drift', requires: ['sr-product-manager', 'sr-product-analyst'] },
  { command: 'get-backlog-specs', requires: ['sr-product-analyst'] },
  { command: 'merge-resolve', requires: ['sr-merge-resolver'] },
]

/**
 * Agents that write "explanation" memory records. When any of them
 * ships we also need a shared `.claude/agent-memory/explanations/`
 * directory alongside the per-agent memory dirs.
 */
const EXPLANATION_AUTHORS = new Set(['sr-architect', 'sr-reviewer'])

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
    copiedFiles += placed.agents + placed.commands + placed.rules
    const skippedNote = placed.skippedAgents > 0 ? ` (skipped ${placed.skippedAgents} VPC-dependent)` : ''
    info(
      `Quick tier: placed ${placed.agents} agent(s) + ${placed.commands} command(s) + ` +
        `${placed.rules} rule file(s) directly into ${input.providerDir}/${skippedNote}`,
    )
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

interface QuickPlacement {
  agents: number
  commands: number
  rules: number
  skippedAgents: number
}

/**
 * Quick-tier placement: copy agents / commands / rules from the
 * .specrails/setup-templates/ staging directory into the live
 * provider directory, substituting template placeholders and
 * excluding agents + commands whose dependencies are not present.
 *
 * Source is setup-templates/ (not scriptDir/templates/) so the pipeline
 * is: scriptDir/templates/ → setup-templates/ (earlier scaffold step)
 * → <providerDir>/ (this function). The intermediate hop mirrors the
 * retired bash installer and lets downstream consumers (specrails-hub's
 * deployTemplates, /specrails:enrich, update flow) read from a single
 * canonical staging dir.
 */
function placeQuickTierArtefacts(input: ScaffoldInput): QuickPlacement {
  const setupTemplates = path.join(input.repoRoot, '.specrails', 'setup-templates')
  const projectName = path.basename(input.repoRoot)
  const providerDirAbs = path.join(input.repoRoot, input.providerDir)

  const placeholders = {
    PROJECT_NAME: projectName,
    SECURITY_EXEMPTIONS_PATH: `${input.providerDir}/security-exemptions.yaml`,
    PERSONA_DIR: `${input.providerDir}/agents/personas/`,
  }

  // --- Agents ---
  const agentsSrc = path.join(setupTemplates, 'agents')
  const agentsDest = path.join(providerDirAbs, 'agents')
  let agentsPlaced = 0
  let agentsSkipped = 0
  const installedAgentNames = new Set<string>()
  if (isDir(agentsSrc)) {
    mkdirp(agentsDest)
    for (const src of listDir(agentsSrc)) {
      const name = path.basename(src)
      if (!name.endsWith('.md')) continue
      const agentId = name.slice(0, -3)

      if (QUICK_EXCLUDED_AGENTS.has(agentId)) {
        agentsSkipped++
        continue
      }

      const dest = path.join(agentsDest, name)
      const rendered = renderPlaceholders(readTextFile(src), {
        ...placeholders,
        MEMORY_PATH: `.claude/agent-memory/${agentId}/`,
      })
      writeFileLf(dest, rendered)
      agentsPlaced++
      installedAgentNames.add(agentId)

      // Per-agent memory directory. Created even when empty so
      // the first run of the agent doesn't error on ENOENT.
      mkdirp(path.join(input.repoRoot, '.claude', 'agent-memory', agentId))

      if (EXPLANATION_AUTHORS.has(agentId)) {
        mkdirp(path.join(input.repoRoot, '.claude', 'agent-memory', 'explanations'))
      }
    }
  }

  // --- Commands ---
  // Skip commands whose required agents were excluded.
  const excludedCommands = new Set<string>()
  for (const dep of COMMAND_AGENT_DEPENDENCIES) {
    const hasAllRequired = dep.requires.every((a) => installedAgentNames.has(a))
    if (!hasAllRequired) excludedCommands.add(dep.command)
  }
  if (!input.agentTeams) {
    excludedCommands.add('team-debug')
    excludedCommands.add('team-review')
  }

  const commandsSrc = path.join(setupTemplates, 'commands', 'specrails')
  const commandsDest = path.join(providerDirAbs, 'commands', 'specrails')
  let commandsPlaced = 0
  if (isDir(commandsSrc)) {
    mkdirp(commandsDest)
    for (const src of listDir(commandsSrc)) {
      const name = path.basename(src)
      if (!name.endsWith('.md')) continue
      const cmdId = name.slice(0, -3)
      if (excludedCommands.has(cmdId)) continue

      const dest = path.join(commandsDest, name)
      const rendered = renderPlaceholders(readTextFile(src), {
        ...placeholders,
        MEMORY_PATH: '.claude/agent-memory/',
      })
      writeFileLf(dest, rendered)
      commandsPlaced++
    }
  }

  // --- Rules ---
  const rulesSrc = path.join(setupTemplates, 'rules')
  const rulesDest = path.join(providerDirAbs, 'rules')
  let rulesPlaced = 0
  if (isDir(rulesSrc)) {
    mkdirp(rulesDest)
    for (const src of listDir(rulesSrc)) {
      const name = path.basename(src)
      if (!name.endsWith('.md')) continue
      const dest = path.join(rulesDest, name)
      const rendered = renderPlaceholders(readTextFile(src), placeholders)
      writeFileLf(dest, rendered)
      rulesPlaced++
    }
  }

  return { agents: agentsPlaced, commands: commandsPlaced, rules: rulesPlaced, skippedAgents: agentsSkipped }
}

/**
 * Substitutes `{{KEY}}` tokens in the input text with the provided
 * values, then strips any remaining `{{UNKNOWN}}` tokens (replacing
 * them with the empty string). Matches the retired bash installer's
 * `sed` pipeline byte-for-byte for the documented token set.
 */
function renderPlaceholders(text: string, values: Record<string, string>): string {
  let out = text
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`{{${k}}}`).join(v)
  }
  return out.replace(/\{\{[A-Z_]*\}\}/g, '')
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
