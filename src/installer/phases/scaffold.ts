import { rmSync } from 'node:fs'
import path from 'node:path'

import { copyDir, copyFile, isDir, listDir, mkdirp, pathExists, readTextFile, writeFileLf } from '../util/fs.js'
import { info, ok, warn } from '../util/logger.js'

import type { Provider } from './provider-detect.js'

/**
 * The three baseline agents that every specrails install requires.
 * These are the only agents guaranteed to be present — the implement
 * pipeline depends on all three. sr-merge-resolver and every other
 * agent are optional add-ons selected at install time.
 *
 * Mirrors the `allOf` baseline in schemas/profile.v1.json — update
 * both files together if this set ever changes.
 */
export const CORE_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
])

/**
 * Agents excluded from the quick tier because they require a full
 * /specrails:enrich persona pass to function correctly.
 */
const QUICK_EXCLUDED_AGENTS = new Set(['sr-product-manager', 'sr-product-analyst'])
/**
 * Skills excluded from the quick tier because they depend on
 * VPC-only agents (sr-product-manager, sr-product-analyst).
 */
const QUICK_EXCLUDED_SKILLS = new Set([
  'sr-auto-propose-backlog-specs',
  'sr-get-backlog-specs',
])

/**
 * Claude top-level `sr-*` skills, GENERATED at install time from their
 * canonical slash-command body under `templates/commands/specrails/<command>.md`.
 * The command is the single source of truth; the skill is just that body wrapped
 * in skill frontmatter, so the two can never drift (the previous hand-maintained
 * `templates/skills/sr-<name>/SKILL.md` copies had drifted ~88% out of sync).
 * Codex does not use these — it invokes the command-ports (`$implement`, …).
 */
const SKILL_FROM_COMMAND: Record<string, { command: string; description: string }> = {
  'sr-implement': {
    command: 'implement',
    description:
      'sr:implement — Full OpenSpec lifecycle with specialized agents: architect designs, developer implements, reviewer validates. Use for implementing GitHub Issues or feature descriptions.',
  },
  'sr-batch-implement': {
    command: 'batch-implement',
    description:
      'sr:batch-implement — Batch implementation orchestrator. Accepts multiple feature references, computes dependency-aware execution waves, invokes sr:implement per wave.',
  },
  'sr-compat-check': {
    command: 'compat-check',
    description:
      'sr:compat-check — Snapshot the API surface and detect breaking changes against a prior baseline. Generates a migration guide when breaking changes are found.',
  },
  'sr-refactor-recommender': {
    command: 'refactor-recommender',
    description:
      'sr:refactor-recommender — Scan the codebase for refactoring opportunities ranked by impact/effort ratio. Optionally creates GitHub Issues for tracking.',
  },
  'sr-why': {
    command: 'why',
    description:
      'sr:why — Search explanation records written by specrails agents during the OpenSpec implementation pipeline.',
  },
  'sr-get-backlog-specs': {
    command: 'get-backlog-specs',
    description:
      'sr:get-backlog-specs — View product-driven backlog from GitHub Issues and propose top 3 for implementation.',
  },
  'sr-auto-propose-backlog-specs': {
    command: 'auto-propose-backlog-specs',
    description:
      'sr:auto-propose-backlog-specs — Generate new feature ideas through product discovery, create GitHub Issues.',
  },
}

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
  /** Optional explicit allow-list used by config-driven quick installs. */
  selectedAgents?: string[]
}

export interface ScaffoldResult {
  existingSetup: boolean
  createdDirs: string[]
  copiedFiles: number
}

/**
 * Returns true iff any of the provider directories already contains
 * content. The desktop-app-driven path skips the "merge existing?" prompt and
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
    // Codex skills live under <providerDir>/skills/ (e.g. .codex/skills/).
    // The pre-§18 code wrote to `.agents/skills/` which codex doesn't read;
    // that was a placeholder name from the gated state.
    mk(path.join(input.repoRoot, input.providerDir, 'skills', 'enrich'))
    mk(path.join(input.repoRoot, input.providerDir, 'skills', 'doctor'))
    mk(path.join(input.repoRoot, input.providerDir, 'skills', 'rails'))
  } else {
    mk(path.join(input.repoRoot, input.providerDir, 'commands', 'specrails'))
    mk(path.join(input.repoRoot, input.providerDir, 'skills'))
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
  pruneLegacyArtifacts(input)

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

  // --- Skills placement (both tiers, both providers) ---
  // Claude: top-level `sr-*` skills are generated from their canonical
  // command bodies (single source of truth). Codex: skips top-level skills
  // (it uses the command-ports) and instead receives the codex-native rails.
  // See placeSkills for the full per-provider contract.
  {
    const skills = placeSkills(input)
    copiedFiles += skills.filesCopied
    const skillSkipNote = skills.skipped > 0 ? ` (skipped ${skills.skipped} VPC-dependent)` : ''
    info(
      `Placed ${skills.placed} skill(s) into ${input.providerDir}/skills/${skillSkipNote}`,
    )
  }

  // --- Codex provider settings + AGENTS.md initial content ---
  if (input.provider === 'codex') {
    const written = applyCodexSettings(input)
    copiedFiles += written
    if (written > 0) {
      info(`Codex provider: wrote ${written} setting file(s) (config.toml, AGENTS.md)`)
    }
  }

  // --- Full-tier hint: enrich is required to generate VPC artefacts ---
  if (input.tier === 'full') {
    const cliName = input.provider === 'codex' ? 'Codex CLI' : 'Claude Code'
    info(
      `Full tier staged. Run \`/specrails:enrich\` in ${cliName} to generate ` +
        'VPC personas and adapt agents (including sr-product-manager and ' +
        'sr-product-analyst) to this codebase.',
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
    // Codex: each bundled command ships as a SKILL under
    // `.codex/skills/<name>/SKILL.md`. A codex-native override (spawn_agent
    // semantics + correct `.codex/skills/rails/` layout) wins; otherwise the
    // claude body is ported with frontmatter re-emitted in codex shape.
    let count = 0
    const codexOverrides = path.join(input.scriptDir, 'templates', 'codex-skills')
    for (const entry of listDir(commandsSrc)) {
      const name = path.basename(entry)
      if (!name.endsWith('.md')) continue
      if (name === 'setup.md') continue
      if (!input.agentTeams && /^team-/.test(name)) continue
      const skillName = name.replace(/\.md$/, '')
      const destDir = path.join(input.repoRoot, input.providerDir, 'skills', skillName)
      // A codex-native override (written for spawn_agent semantics + the
      // correct `.codex/skills/rails/` layout) wins over the claude port.
      // This is the ONLY codex command-placement pass in full tier, so
      // without the override check full-tier codex users get the claude
      // body — e.g. enrich's obsolete `.codex/agents/*.toml` model.
      const overrideSkill = path.join(codexOverrides, skillName, 'SKILL.md')
      if (pathExists(overrideSkill)) {
        copyDir(path.join(codexOverrides, skillName), destDir)
      } else {
        writeCodexSkillFromCommand({
          src: entry,
          dest: path.join(destDir, 'SKILL.md'),
          name: skillName,
        })
      }
      count++
    }
    input.copiedIncrement(count)
    return
  }

  // Claude: all bundled commands land under <providerDir>/commands/specrails/.
  const destDir = path.join(input.repoRoot, input.providerDir, 'commands', 'specrails')
  let count = 0
  for (const entry of listDir(commandsSrc)) {
    const name = path.basename(entry)
    if (!name.endsWith('.md')) continue
    if (name === 'setup.md') continue
    if (!input.agentTeams && /^team-/.test(name)) continue
    copyFile(entry, path.join(destDir, name))
    count++
  }
  input.copiedIncrement(count)
}

/**
 * Convert a claude slash-command markdown file into a codex SKILL.md.
 *
 * Claude commands ship with either no frontmatter or a minimal
 * `--- description: ... ---` block. Codex skill loader needs explicit
 * `name`, `description`, `license`, and `compatibility` keys. We strip
 * the source frontmatter (if any), keep its description, and re-emit
 * the canonical codex shape. The remaining body is preserved.
 *
 * If `args.description` is provided it overrides any value extracted
 * from the source frontmatter — used for the lifecycle skills where we
 * want a more polished one-liner than what the slash-command file ships
 * with.
 */
function writeCodexSkillFromCommand(args: {
  src: string
  dest: string
  name: string
  description?: string
}): void {
  if (!pathExists(args.src)) return
  const raw = readTextFile(args.src)
  const { body, description: srcDescription } = stripFrontmatter(raw)
  // The carried-over claude description may mention `/specrails:foo`; rewrite
  // those occurrences (description field only, not the body — body
  // translation runs further down) so the codex skill picker shows a
  // codex-shape name to the model.
  const translatedSrcDescription = srcDescription
    ?.replace(/\/specrails:([\w-]+)/g, '$$$1')
    ?.replace(/\/sr:([\w-]+)/g, '$$$1')
  const description =
    args.description ?? translatedSrcDescription ?? `specrails ${args.name} command (ported to codex skill).`
  const frontmatter = [
    '---',
    `name: ${args.name}`,
    `description: ${JSON.stringify(description)}`,
    'license: MIT',
    'compatibility: "Requires the specrails-core installation in this repository."',
    '---',
    '',
  ].join('\n')
  // Translate claude-specific paths and slash-command references to their
  // codex equivalents so the skill body reads natively on a codex project:
  //   .claude/                  → .codex/  (config + memory paths)
  //   /specrails:<name>         → $<name>  (codex skill mention syntax;
  //                                          our scaffold writes a matching
  //                                          .codex/skills/<name>/SKILL.md
  //                                          for every claude slash command)
  //   /sr:<name>                → $<name>  (alias used in some docs)
  // `/opsx:<name>` is intentionally left untouched: the claude→codex
  // mapping is non-trivial (most opsx commands map to
  // `$openspec-<name>-change` but a few drop the suffix, and a couple
  // don't map at all). The references appear inside docstrings only,
  // not at execution paths, so leaving them as-is keeps the skill
  // working without inventing a wrong mapping.
  const translated = body
    .replace(/\.claude\//g, '.codex/')
    .replace(/`\/specrails:([\w-]+)`/g, '`$$$1`')
    .replace(/`\/sr:([\w-]+)`/g, '`$$$1`')
    .replace(/\/specrails:([\w-]+)/g, '$$$1')
    .replace(/\/sr:([\w-]+)/g, '$$$1')
  writeFileLf(args.dest, frontmatter + translated)
}

/**
 * Generate a Claude skill (`SKILL.md`) from a slash-command body. The
 * command is the single source of truth; we strip any command-level
 * frontmatter and re-emit the canonical skill frontmatter (name +
 * description + license + compatibility + metadata) followed by the body
 * verbatim. Used by placeSkills so the `sr-*` skills can never drift from
 * their `templates/commands/specrails/<command>.md` counterpart.
 */
function writeClaudeSkillFromCommand(args: {
  src: string
  dest: string
  name: string
  description: string
}): void {
  if (!pathExists(args.src)) return
  const { body } = stripFrontmatter(readTextFile(args.src))
  const frontmatter = [
    '---',
    `name: ${args.name}`,
    `description: ${JSON.stringify(args.description)}`,
    'license: MIT',
    'compatibility: "Requires the specrails-core installation in this repository."',
    'metadata:',
    '  author: specrails',
    '  version: "1.0"',
    '---',
    '',
  ].join('\n')
  writeFileLf(args.dest, frontmatter + body)
}

/**
 * Strip a leading `---`-delimited YAML frontmatter block and return the
 * remaining body plus the `description:` value if present. Defensive
 * parser: only handles `key: value` lines (no nested maps), which is
 * the shape every slash-command file ships with today.
 */
function stripFrontmatter(raw: string): { body: string; description?: string } {
  if (!raw.startsWith('---\n')) return { body: raw }
  const endIdx = raw.indexOf('\n---\n', 4)
  if (endIdx < 0) return { body: raw }
  const yaml = raw.slice(4, endIdx)
  const body = raw.slice(endIdx + 5)
  let description: string | undefined
  for (const line of yaml.split('\n')) {
    const m = line.match(/^description\s*:\s*(.*)$/)
    if (m) {
      const v = m[1].trim()
      description = v.replace(/^['"](.*)['"]$/, '$1')
      break
    }
  }
  return { body, description }
}

function pruneLegacyArtifacts(input: Pick<ScaffoldInput, 'repoRoot' | 'provider' | 'providerDir'>): void {
  const legacyPaths = [
    path.join(input.repoRoot, '.specrails', 'bin', 'doctor.sh'),
    path.join(input.repoRoot, '.specrails', 'setup-templates', '.provider-detection.json'),
    path.join(input.repoRoot, '.specrails', 'setup-templates', 'settings', 'integration-contract.json'),
    path.join(input.repoRoot, '.specrails-version'),
  ]

  if (input.provider === 'codex') {
    // Pre-§18 layout used `.agents/skills/` — prune any leftovers from a
    // legacy install before settling on the canonical `.codex/skills/`.
    legacyPaths.push(path.join(input.repoRoot, '.agents'))
    legacyPaths.push(path.join(input.repoRoot, input.providerDir, 'skills', 'setup'))
  } else {
    legacyPaths.push(path.join(input.repoRoot, input.providerDir, 'commands', 'setup.md'))
    legacyPaths.push(path.join(input.repoRoot, input.providerDir, 'commands', 'specrails', 'setup.md'))
  }

  for (const target of legacyPaths) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch (err) {
      warn(`failed to prune legacy artifact ${target}: ${(err as Error).message}`)
    }
  }
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
 * retired bash installer and lets downstream consumers (specrails-desktop's
 * deployTemplates, /specrails:enrich, update flow) read from a single
 * canonical staging dir.
 */
function placeQuickTierArtefacts(input: ScaffoldInput): QuickPlacement {
  // Codex projects: the quick-tier `agents/` + `rules/` placement is
  // skipped (handled by `placeSkills` rail-skills + `applyCodexSettings`).
  // The slash-command catalogue under `setup-templates/commands/specrails/`
  // IS ported, but to `.codex/skills/<name>/SKILL.md` instead of
  // `.claude/commands/specrails/<name>.md`, so codex users get the same
  // command surface (`propose-spec`, `explore-spec`, `retry`, …) as
  // claude.
  if (input.provider === 'codex') {
    const setupTemplates = path.join(input.repoRoot, '.specrails', 'setup-templates')
    const commandsSrc = path.join(setupTemplates, 'commands', 'specrails')
    // Codex-native skill overrides live at `templates/codex-skills/<name>/`.
    // When one exists for a given slash-command name (e.g. `implement`), the
    // scaffold writes that file verbatim instead of porting the claude
    // command body. Use these to ship skills written for codex's
    // single-agent model (no `subagent_type`, no `.claude/agent-memory/`,
    // codex-shape spawn semantics).
    const codexOverridesSrc = path.join(input.scriptDir, 'templates', 'codex-skills')
    let commandsPlaced = 0
    if (isDir(commandsSrc)) {
      for (const src of listDir(commandsSrc)) {
        const name = path.basename(src)
        if (!name.endsWith('.md')) continue
        if (name === 'setup.md') continue
        if (!input.agentTeams && /^team-/.test(name)) continue
        const skillName = name.slice(0, -3)
        const dest = path.join(input.repoRoot, input.providerDir, 'skills', skillName, 'SKILL.md')

        // If a codex-native override exists, ship it verbatim and skip the
        // ported claude body entirely. Mirrors a directory copy in case the
        // override ships sibling assets.
        const overrideDir = path.join(codexOverridesSrc, skillName)
        const overrideSkill = path.join(overrideDir, 'SKILL.md')
        if (pathExists(overrideSkill)) {
          copyDir(overrideDir, path.dirname(dest))
          commandsPlaced++
          continue
        }

        writeCodexSkillFromCommand({
          src,
          dest,
          name: skillName,
        })
        commandsPlaced++
      }
    }
    return { agents: 0, commands: commandsPlaced, rules: 0, skippedAgents: 0 }
  }

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
  // When no agent selection is provided (fresh init with no install-config),
  // default to placing only the three core agents. This keeps the default
  // install lean — optional agents (sr-merge-resolver, layer specialists,
  // product agents) are explicitly opt-in via the TUI or install-config.
  const selectedAgents = input.selectedAgents
    ? new Set([...input.selectedAgents, ...CORE_AGENTS])
    : new Set([...CORE_AGENTS])
  if (isDir(agentsSrc)) {
    mkdirp(agentsDest)
    for (const src of listDir(agentsSrc)) {
      const name = path.basename(src)
      if (!name.endsWith('.md')) continue
      const agentId = name.slice(0, -3)
      if (selectedAgents && !selectedAgents.has(agentId)) continue

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

interface SkillsPlacement {
  placed: number
  skipped: number
  filesCopied: number
}

/**
 * Codex-specific provider settings. Writes `.codex/config.toml` (model +
 * reasoning effort + sandbox baseline; conforms to the codex 0.128.0+
 * top-level TOML schema) and `AGENTS.md` (top-level instructions file
 * consumed by `codex` on startup, sentinel-protected so user edits
 * outside the managed block survive).
 *
 * Idempotent: existing files outside the sentinel block are preserved.
 * Returns the count of files written/refreshed.
 */
function applyCodexSettings(input: ScaffoldInput): number {
  const settingsSrc = path.join(input.scriptDir, 'templates', 'settings')
  let written = 0

  // config.toml — model name interpolated from install-config (preset
  // default `gpt-5.5-mini`). Static for v1; future revisions may surface
  // reasoning_effort etc.
  const configTomlSrc = path.join(settingsSrc, 'codex-config.toml')
  if (pathExists(configTomlSrc)) {
    const dest = path.join(input.repoRoot, input.providerDir, 'config.toml')
    const rendered = readTextFile(configTomlSrc).replace(/\{\{MODEL_NAME\}\}/g, 'gpt-5.5-mini')
    writeFileLf(dest, rendered)
    written++
  }

  // AGENTS.md — top-level instructions file the codex CLI loads on startup.
  // Written with a sentinel block so update + enrich passes can refresh the
  // managed content while preserving anything the user added outside it.
  const agentsMdPath = path.join(input.repoRoot, 'AGENTS.md')
  const agentsMdContent = renderInitialAgentsMd(input.repoRoot)
  if (!pathExists(agentsMdPath)) {
    writeFileLf(agentsMdPath, agentsMdContent)
    written++
  } else {
    // Upsert sentinel block into an existing AGENTS.md.
    const existing = readTextFile(agentsMdPath)
    const next = upsertAgentsMdManagedBlock(existing, extractManagedBlock(agentsMdContent))
    if (next !== existing) {
      writeFileLf(agentsMdPath, next)
      written++
    }
  }

  return written
}

const AGENTS_MD_START = '<!-- specrails-managed:start -->'
const AGENTS_MD_END = '<!-- specrails-managed:end -->'

function renderInitialAgentsMd(repoRoot: string): string {
  const projectName = path.basename(repoRoot)
  return [
    AGENTS_MD_START,
    '',
    `# ${projectName} — agent instructions`,
    '',
    'This project uses the **specrails** agent workflow under `.codex/`.',
    'See `.codex/skills/` for the catalog of agent skills available to codex',
    'sessions in this repository.',
    '',
    '## Conventions',
    '',
    '- Read specs from `.specrails/local-tickets.json` when implementing',
    '  numbered tickets (`#42`, `#71` etc.).',
    '- Prefer the skills in `.codex/skills/sr-*` over ad-hoc edits when a',
    '  skill covers the task (implement, batch-implement, refactor-recommender,',
    '  compat-check, why, ...).',
    '- Honour the sandbox policy declared in `.codex/config.toml`',
    '  (`sandbox_mode` + `approval_policy` top-level keys).',
    '',
    AGENTS_MD_END,
    '',
  ].join('\n')
}

function extractManagedBlock(rendered: string): string {
  const s = rendered.indexOf(AGENTS_MD_START)
  const e = rendered.indexOf(AGENTS_MD_END)
  if (s < 0 || e < 0) return rendered
  return rendered.slice(s, e + AGENTS_MD_END.length)
}

function upsertAgentsMdManagedBlock(existing: string, managedBlock: string): string {
  const s = existing.indexOf(AGENTS_MD_START)
  const e = existing.indexOf(AGENTS_MD_END)
  if (s >= 0 && e >= 0 && e > s) {
    return existing.slice(0, s) + managedBlock + existing.slice(e + AGENTS_MD_END.length)
  }
  // Append the managed block + a leading blank line if the file doesn't end with one.
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return existing + sep + managedBlock + '\n'
}

// Place skills under `<providerDir>/skills/`.
//
// CLAUDE: the top-level `sr-*` skills (sr-implement, sr-why, …) are GENERATED
// from their canonical slash-command body (`templates/commands/specrails/
// <command>.md`) — the command is the single source of truth, so the skill can
// never drift from it. Quick tier excludes VPC-dependent ones.
//
// CODEX: top-level skills are NOT placed — every one has a command counterpart
// that the command path ports to `.codex/skills/<name>/` (with codex-native
// overrides), so the codex user invokes `$implement` etc. A claude-shaped
// `$sr-implement` port would be redundant AND broken (its `Skill()` /
// `subagent_type` calls have no codex equivalent). Codex DOES get the rails
// subtree below, sourced from `templates/codex-skills/rails/`.
function placeSkills(input: ScaffoldInput): SkillsPlacement {
  const destBase = path.join(input.repoRoot, input.providerDir, 'skills')
  const result: SkillsPlacement = { placed: 0, skipped: 0, filesCopied: 0 }

  // Top-level skills — Claude only, generated from the canonical command body.
  if (input.provider !== 'codex') {
    const commandsSrc = path.join(input.repoRoot, '.specrails', 'setup-templates', 'commands', 'specrails')
    const skillEntries = Object.entries(SKILL_FROM_COMMAND) as Array<
      [string, { command: string; description: string }]
    >
    for (const [skillName, spec] of skillEntries) {
      if (input.tier === 'quick' && QUICK_EXCLUDED_SKILLS.has(skillName)) {
        result.skipped++
        continue
      }
      const src = path.join(commandsSrc, `${spec.command}.md`)
      if (!pathExists(src)) continue
      writeClaudeSkillFromCommand({
        src,
        dest: path.join(destBase, skillName, 'SKILL.md'),
        name: skillName,
        description: spec.description,
      })
      result.placed++
      result.filesCopied++
    }
  }

  // Rail skills are a CODEX-ONLY concern. Codex doesn't honour Claude's
  // `.claude/agents/` convention, so each agent role ships as a codex-native
  // SKILL.md under `templates/codex-skills/rails/<name>/` that the codex
  // orchestrator invokes via spawn_agent / $-mention. On Claude the pipeline
  // launches `.claude/agents/sr-*.md` directly via `subagent_type`, so no
  // claude-shape rail skill is placed (the former templates/skills/rails/
  // copies were vestigial — unused on Claude, always overridden on codex,
  // and shipped with unsubstituted placeholders — and were removed).
  //
  // Only the three CORE_AGENTS are placed by default; sr-merge-resolver and
  // every layer specialist are placed only when selectedAgents includes them.
  const codexRailsOverridesDir = input.provider === 'codex'
    ? path.join(input.scriptDir, 'templates', 'codex-skills', 'rails')
    : null
  if (codexRailsOverridesDir && isDir(codexRailsOverridesDir)) {
    const destRails = path.join(destBase, 'rails')
    mkdirp(destRails)

    // Honour the wizard's agent selection. Without a selection (fresh install
    // with no install-config), default to the three core agents only.
    const selectedAgents = input.selectedAgents
      ? new Set([...input.selectedAgents, ...CORE_AGENTS])
      : new Set([...CORE_AGENTS])

    for (const entry of listDir(codexRailsOverridesDir)) {
      if (!isDir(entry)) continue
      const skillId = path.basename(entry)
      if (!selectedAgents.has(skillId)) {
        result.skipped++
        continue
      }
      if (!pathExists(path.join(entry, 'SKILL.md'))) continue
      const dest = path.join(destRails, skillId)
      copyDir(entry, dest)
      result.placed++
      result.filesCopied += countFiles(dest)
    }
  }

  return result
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
