import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  atomicSymlinkSwap,
  copyDir,
  copyFile,
  isDir,
  isSymlink,
  listDir,
  mkdirp,
  pathExists,
  readTextFile,
  removePath,
  symlinkOrCopy,
  writeFileLf,
} from '../util/fs.js'
import { info, ok, warn } from '../util/logger.js'

import { buildManifest, writeManifestFiles } from './manifest.js'
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
 * Gemini built-in tool ids granted to every `.gemini/agents/sr-*.md` subagent.
 * (Validated headless in the desktop spike — read/write/shell/glob/grep.) Because
 * gemini TOML commands cannot carry per-command tool/model routing, the tool +
 * model gating migrates into the subagent frontmatter.
 *
 * `activate_skill` is mandatory: the architect/developer/reviewer personas open
 * with a NON-NEGOTIABLE OpenSpec skill call (`opsx:ff`/`apply`/`archive`). Gemini
 * exposes skills through the `activate_skill` tool — without it in the tools list
 * the agent halts with "the required `Skill` tool is not available" and the only
 * way the pipeline ever completed was the orchestrator hand-patching the agent
 * file mid-run. See `translateOpsxSkillCallsForGemini` for the body half.
 */
const GEMINI_AGENT_TOOLS = ['read_file', 'write_file', 'run_shell_command', 'glob', 'search_file_content', 'activate_skill']

/**
 * Claude `Skill("opsx:<id>")` → Gemini `activate_skill(name="<skill>")` id map.
 * The agent persona templates are authored in Claude form (the shared source of
 * truth across providers); Gemini invokes the same OpenSpec workflow skills under
 * a different tool name and skill-directory names. The mapping is NOT a uniform
 * `-change` suffix (`sync` → `*-sync-specs`, `explore`/`onboard` have none), so it
 * must be explicit. Keys mirror the skill directories scaffolded under
 * `.gemini/skills/openspec-*`.
 */
const OPSX_TO_GEMINI_SKILL: Record<string, string> = {
  ff: 'openspec-ff-change',
  new: 'openspec-new-change',
  apply: 'openspec-apply-change',
  continue: 'openspec-continue-change',
  archive: 'openspec-archive-change',
  'bulk-archive': 'openspec-bulk-archive-change',
  sync: 'openspec-sync-specs',
  verify: 'openspec-verify-change',
  explore: 'openspec-explore',
  onboard: 'openspec-onboard',
}

/**
 * Rewrite every literal `Skill("opsx:<id>"[, …])` call in a Claude-authored agent
 * body into the Gemini `activate_skill(name="…")` form. Positional skill input
 * (e.g. `"<specName>"`) is dropped because `activate_skill` takes only `name` and
 * the surrounding persona prose already carries the context. Unknown ids are left
 * untouched (better a visible stale ref than a silent `name="undefined"`). This
 * runs ONLY on the gemini render path; Claude/Codex keep the `Skill(...)` form.
 */
export function translateOpsxSkillCallsForGemini(body: string): string {
  return body.replace(/Skill\("opsx:([a-z-]+)"(?:\s*,[^)]*)?\)/g, (match, id: string) => {
    const skill = OPSX_TO_GEMINI_SKILL[id]
    return skill ? `activate_skill(name="${skill}")` : match
  })
}

/**
 * Per-role gemini model. Defaults to `gemini-3.5-flash` — the stable flagship
 * (June 2026): strong agentic/coding, high quota, and unlike `gemini-2.5-pro`
 * it is NOT removed from the free tier (the old default produced 429
 * "exhausted capacity" errors on free/limited keys).
 */
const GEMINI_MODEL_BY_AGENT: Record<string, string> = {
  'sr-architect': 'gemini-3.5-flash',
  'sr-developer': 'gemini-3.5-flash',
  'sr-reviewer': 'gemini-3.5-flash',
}
const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash'

// NOTE: do NOT emit a `max_turns` (or `maxTurns`/`runConfig`) key in the gemini
// agent frontmatter. Although gemini's documented agent schema lists `max_turns`,
// the 0.46 runtime loader REJECTS a `.gemini/agents/*.md` file that carries it —
// the agent silently fails to register and `invoke_agent` reports "Subagent
// '<name>' not found", so the orchestrator falls back to a generic agent and the
// specialised personas never run. Verified empirically (two identical agents,
// one with `max_turns: 40` → not found, one without → loads). The 30-turn default
// cap is instead absorbed by the implement.toml MAX_TURNS → re-delegate/resume
// contract. Re-introduce only if a future gemini build is reconfirmed to accept it.

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
  /**
   * Absolute path to the relocated artifact root — where every Specrails-managed
   * artifact (.specrails/.claude/.codex/.gemini/CLAUDE.md/AGENTS.md/GEMINI.md/.mcp.json)
   * is written. Under relocate-always this is the `$HOME` workspace, NOT the repo.
   */
  artifactRoot: string
  /**
   * Absolute path to the user's repo root — the ONLY thing that stays in-repo is
   * `openspec/**` (installed by init.ts) and git/worktree ops. Used solely by
   * `detectExistingSetup`'s openspec probe and the gitignore no-op guard.
   */
  codeRoot: string
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
  /**
   * When false, the static-placement helpers do NOT create the per-workspace
   * mutable seeds (agent-memory dirs, gemini headless acknowledgments). Used by
   * `installFramework` so the SHARED framework copy stays purely provider-static
   * — the project layer is seeded separately by `assembleProjectWorkspace`.
   * Defaults to true (legacy in-place behaviour for `scaffoldInstallation`).
   */
  seedProjectDirs?: boolean
  /**
   * When true, place EVERY agent template (the full superset) regardless of
   * `selectedAgents` and `QUICK_EXCLUDED_AGENTS`. Used by `installFramework` so
   * the SHARED framework store is a superset that ANY project's selection can
   * link from — per-project agent filtering then happens at the workspace LINK
   * step (`linkAgentFiles`), not at materialization. Defaults to false (legacy
   * selection-honouring placement for in-place `scaffoldInstallation`).
   */
  materializeAllAgents?: boolean
}

export interface ScaffoldResult {
  existingSetup: boolean
  createdDirs: string[]
  copiedFiles: number
}

/**
 * Provider-static subtrees inside a providerDir that are SHARED via symlink from
 * the framework copy into each workspace. `agent-memory/` is deliberately absent
 * — it is mutable per-workspace state seeded as a real dir, never linked.
 *
 * The root instruction file (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`) and the codex
 * `config.toml` / gemini `settings.json` carry the project name / a deep-merge
 * with the user's file, so they are SEEDED per-workspace (not linked) by
 * `assembleProjectWorkspace`.
 */
const LINKED_PROVIDER_SUBTREES: Record<Provider, string[]> = {
  claude: ['agents', 'commands', 'skills', 'rules'],
  codex: ['skills'],
  gemini: ['agents', 'commands'],
}

/**
 * Returns true iff any of the provider directories already contains
 * content. The desktop-app-driven path skips the "merge existing?" prompt and
 * assumes `--yes`; the CLI dispatcher (bin/specrails-core.cjs) should
 * have prompted before entering this phase.
 */
export function detectExistingSetup(input: Pick<ScaffoldInput, 'artifactRoot' | 'codeRoot' | 'providerDir'>): boolean {
  const roots = [
    path.join(input.artifactRoot, input.providerDir, 'agents'),
    path.join(input.artifactRoot, input.providerDir, 'commands'),
    path.join(input.artifactRoot, input.providerDir, 'rules'),
    // openspec stays in the repo (codeRoot), not the relocated artifact root.
    path.join(input.codeRoot, 'openspec'),
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
  mk(path.join(input.artifactRoot, input.providerDir))
  if (input.provider === 'codex') {
    // Codex skills live under <providerDir>/skills/ (e.g. .codex/skills/).
    // The pre-§18 code wrote to `.agents/skills/` which codex doesn't read;
    // that was a placeholder name from the gated state.
    mk(path.join(input.artifactRoot, input.providerDir, 'skills', 'enrich'))
    mk(path.join(input.artifactRoot, input.providerDir, 'skills', 'doctor'))
    mk(path.join(input.artifactRoot, input.providerDir, 'skills', 'rails'))
  } else if (input.provider === 'gemini') {
    // Gemini: TOML commands under .gemini/commands/specrails/ + native
    // subagents under .gemini/agents/. No skills/ tree.
    mk(path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails'))
    mk(path.join(input.artifactRoot, input.providerDir, 'agents'))
  } else {
    mk(path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails'))
    mk(path.join(input.artifactRoot, input.providerDir, 'skills'))
  }
  const setupTemplates = path.join(input.artifactRoot, '.specrails', 'setup-templates')
  mk(path.join(setupTemplates, 'agents'))
  mk(path.join(setupTemplates, 'commands'))
  mk(path.join(setupTemplates, 'skills'))
  mk(path.join(setupTemplates, 'rules'))
  mk(path.join(setupTemplates, 'personas'))
  mk(path.join(setupTemplates, 'claude-md'))
  mk(path.join(setupTemplates, 'settings'))

  // --- .gitignore hygiene ---
  // Under relocate-always (artifactRoot !== codeRoot) NOTHING Specrails-owned
  // lands in the repo, so there is nothing to ignore — the gitignore step is a
  // guarded no-op. It only runs in the legacy in-repo layout where the two roots
  // coincide.
  if (input.artifactRoot === input.codeRoot) {
    const gitignoreEntries = ['.claude/agent-memory/', '.specrails/']
    if (input.provider === 'gemini') gitignoreEntries.push('.gemini/agent-memory/')
    ensureGitignore(input.codeRoot, gitignoreEntries)
  }

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
    const skillsLabel = input.provider === 'gemini' ? 'agent' : 'skill'
    const skillsSubdir = input.provider === 'gemini' ? 'agents' : 'skills'
    info(
      `Placed ${skills.placed} ${skillsLabel}(s) into ${input.providerDir}/${skillsSubdir}/${skillSkipNote}`,
    )
  }

  // --- Codex provider settings + AGENTS.md initial content ---
  if (input.provider === 'codex') {
    const written = applyCodexSettings(input)
    copiedFiles += written
    if (written > 0) {
      info(`Codex provider: wrote ${written} setting file(s) (config.toml, AGENTS.md)`)
    }
  } else if (input.provider === 'gemini') {
    const written = applyGeminiSettings(input)
    copiedFiles += written
    if (written > 0) {
      info(`Gemini provider: wrote ${written} setting file(s) (settings.json, GEMINI.md)`)
    }
  }

  // --- Full-tier hint: enrich is required to generate VPC artefacts ---
  if (input.tier === 'full') {
    const cliName =
      input.provider === 'codex' ? 'Codex CLI' : input.provider === 'gemini' ? 'Gemini CLI' : 'Claude Code'
    info(
      `Full tier staged. Run \`/specrails:enrich\` in ${cliName} to generate ` +
        'VPC personas and adapt agents (including sr-product-manager and ' +
        'sr-product-analyst) to this codebase.',
    )
  }

  ok(`Created ${createdDirs.length} directories, copied ${copiedFiles} files`)

  return {
    existingSetup: detectExistingSetup({
      artifactRoot: input.artifactRoot,
      codeRoot: input.codeRoot,
      providerDir: input.providerDir,
    }),
    createdDirs,
    copiedFiles,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Bundled-framework split: installFramework + ensureCurrentSymlink +
// assembleProjectWorkspace. The provider-INVARIANT subtree is materialized ONCE
// under `<frameworkDir>/<version>/<providerDir>/` and every workspace SYMLINKS
// it; the per-workspace PROJECT layer (agent-memory, manifest, gemini acks,
// settings/instructions files) is seeded as real writable files.
// ───────────────────────────────────────────────────────────────────────────

export interface InstallFrameworkInput {
  /** Absolute path to the specrails-core package (templates/ + commands/). */
  scriptDir: string
  /** Root of the versioned framework store, e.g. `<home>/.specrails/framework`. */
  frameworkDir: string
  /** Provider whose static subtree is being materialized. */
  provider: Provider
  /** Derived provider dir (`.claude`/`.codex`/`.gemini`). */
  providerDir: string
  /** Framework version (the `<version>/` segment). */
  version: string
  /** Install Agent Teams commands (team-review / team-debug). */
  agentTeams?: boolean
  /** Optional explicit agent allow-list (kept for parity with scaffold). */
  selectedAgents?: string[]
}

export interface InstallFrameworkResult {
  /** `<frameworkDir>/<version>/<providerDir>` — root of the static subtree. */
  providerFrameworkDir: string
  /** `<frameworkDir>/<version>` — the version root (also holds setup-templates/). */
  versionDir: string
  /** True when a fresh materialization happened; false when the idempotent skip fired. */
  materialized: boolean
}

/** Path to the per-version, per-provider materialization marker (manifest hash). */
function frameworkStampPath(versionDir: string, providerDir: string): string {
  // Store the stamp OUTSIDE the providerDir so it never leaks into the linked
  // subtree. `.stamp-<providerDir>.json` is provider-keyed.
  return path.join(versionDir, `.framework-stamp${providerDir}.json`)
}

/**
 * Materialize the provider-INVARIANT framework subtree ONCE into
 * `<frameworkDir>/<version>/<providerDir>/` (+ `<version>/setup-templates/`).
 * Idempotent: when the providerDir already exists with a matching stamp it is a
 * no-op (the second workspace assemble re-uses the same copy). Writes NO
 * per-workspace state (no agent-memory, no acks, no project-named instruction
 * files) — those are seeded by `assembleProjectWorkspace`.
 */
export function installFramework(input: InstallFrameworkInput): InstallFrameworkResult {
  const versionDir = path.join(input.frameworkDir, input.version)
  const providerFrameworkDir = path.join(versionDir, input.providerDir)
  const stampPath = frameworkStampPath(versionDir, input.providerDir)

  // Idempotency: existing materialization with a matching stamp → skip.
  if (isDir(providerFrameworkDir) && pathExists(stampPath)) {
    return { providerFrameworkDir, versionDir, materialized: false }
  }

  // Reuse scaffoldInstallation's static-placement helpers by pointing
  // `artifactRoot` at the version dir. `seedProjectDirs: false` keeps the copy
  // free of per-workspace mutable state. The `codeRoot` is irrelevant to the
  // STATIC subtree (the project-named instruction files are skipped below), so
  // we hand it the framework dir to satisfy the contract — and we DELETE any
  // project-named instruction file the settings helpers wrote.
  // The SHARED framework store is always the FULL SUPERSET — EVERY agent and the
  // team commands — so a SECOND project with a DIFFERENT agent selection links
  // its specialists from the same materialized copy instead of inheriting the
  // first project's narrower set. Per-project filtering moves to the workspace
  // LINK step (`linkAgentFiles` via `assembleProjectWorkspace`). `selectedAgents`
  // / `agentTeams` on the input are intentionally IGNORED here.
  const staticInput: ScaffoldInput = {
    scriptDir: input.scriptDir,
    artifactRoot: versionDir,
    codeRoot: versionDir,
    provider: input.provider,
    providerDir: input.providerDir,
    agentTeams: true,
    tier: 'quick',
    selectedAgents: undefined,
    materializeAllAgents: true,
    seedProjectDirs: false,
  }
  scaffoldInstallation(staticInput)

  // The settings helpers also emit a project-named root instruction file
  // (AGENTS.md/GEMINI.md/CLAUDE.md) + (for codex) config.toml / (gemini)
  // settings.json. The instruction file is per-project → strip it from the
  // shared copy; the settings file IS provider-invariant and stays as a
  // link target inside the providerDir.
  for (const f of ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md']) {
    rmSync(path.join(versionDir, f), { force: true })
  }

  writeFileLf(
    stampPath,
    `${JSON.stringify({ version: input.version, provider: input.provider, at: new Date().toISOString() }, null, 2)}\n`,
  )
  return { providerFrameworkDir, versionDir, materialized: true }
}

/**
 * Atomically point `<frameworkDir>/current` at `<version>` so every workspace's
 * provider links resolve through `current/...` and an update is a single swap.
 */
export function ensureCurrentSymlink(frameworkDir: string, version: string): void {
  const currentPath = path.join(frameworkDir, 'current')
  const versionDir = path.join(frameworkDir, version)
  mkdirp(frameworkDir)
  atomicSymlinkSwap(versionDir, currentPath)
}

export interface AssembleProjectWorkspaceInput {
  /** The per-project workspace artifact root (= resolveArtifacts artifactRoot). */
  workspace: string
  /** Root of the versioned framework store (the parent of `current/`). */
  frameworkDir: string
  /** Provider whose subtrees are linked into the workspace. */
  provider: Provider
  /** Derived provider dir (`.claude`/`.codex`/`.gemini`). */
  providerDir: string
  /** Framework version (used for the manifest record). */
  version: string
  /** The user's real repo (drives PROJECT_NAME + gemini ack keying). */
  codeRoot: string
  /** specrails-core package dir (for the manifest hash sources). */
  scriptDir: string
  /**
   * Optional agent allow-list. Drives BOTH which framework agents are LINKED
   * into the workspace (`linkAgentFiles`) AND which agent-memory dirs are seeded.
   * Undefined = the CORE trio only (the lean default). The SHARED framework store
   * is always the full superset; this is where per-project filtering happens.
   */
  selectedAgents?: string[]
  /**
   * Install the Agent Teams commands (`team-review` / `team-debug`) into the
   * workspace. The shared framework store always materializes them; when false
   * the workspace links commands/skills PER-FILE excluding the `team-*` entries.
   * Defaults to false (lean install — matches the legacy in-place behaviour).
   */
  agentTeams?: boolean
}

export interface AssembleProjectWorkspaceResult {
  /** Per-linked-subtree mechanism, for diagnostics (copy-fallback loses O(1) swap). */
  links: Record<string, 'symlink' | 'junction' | 'copy'>
  /** Agent ids whose memory dirs were seeded as real writable dirs. */
  seededMemoryAgents: string[]
}

/**
 * Assemble a project workspace with NO network and NO re-materialization: (a)
 * SYMLINK the static providerDir subtrees from `<frameworkDir>/current/
 * <providerDir>/` into `<workspace>/<providerDir>/`, then (b) seed the PROJECT
 * layer as real writable files (agent-memory dirs, the manifest, project-named
 * instruction/settings files, gemini headless acks re-hashed against the LINKED
 * files). `agent-memory/` is NEVER linked.
 */
export function assembleProjectWorkspace(
  input: AssembleProjectWorkspaceInput,
): AssembleProjectWorkspaceResult {
  const currentProviderDir = path.join(input.frameworkDir, 'current', input.providerDir)
  const workspaceProviderDir = path.join(input.workspace, input.providerDir)
  mkdirp(workspaceProviderDir)

  // (a) Link the static subtrees that exist in the framework copy.
  //
  // `agents/` is linked PER-FILE (a real workspace dir holding one symlink per
  // framework agent) so the workspace can also carry user/desktop `custom-*.md`
  // agents — a RESERVED region the installer must never touch. Every other
  // subtree (`commands/`, `skills/`, `rules/`) holds no user files and is linked
  // as a whole directory (cheapest, single inode).
  // Per-project AGENT selection: link only the selected framework agents (∪ the
  // CORE trio, minus the quick-excluded product agents) — the shared store holds
  // the full superset, so a project's narrower pick links a SUBSET. Undefined ⇒
  // CORE trio only. `custom-*.md` is always preserved (reserved path).
  const selectedAgentSet = input.selectedAgents
    ? new Set([...input.selectedAgents, ...CORE_AGENTS])
    : new Set([...CORE_AGENTS])
  const agentTeams = input.agentTeams ?? false

  const links: Record<string, 'symlink' | 'junction' | 'copy'> = {}
  for (const sub of LINKED_PROVIDER_SUBTREES[input.provider]) {
    const target = path.join(currentProviderDir, sub)
    if (!pathExists(target)) continue
    const dest = path.join(workspaceProviderDir, sub)
    if (sub === 'agents') {
      links[sub] = linkAgentFiles(target, dest, selectedAgentSet)
    } else if (!agentTeams && subtreeHasTeamEntries(target)) {
      // Lean install AND the superset store actually carries `team-*` entries:
      // link this subtree PER-FILE, excluding the team commands/skills. The
      // common case (no team-* in the store) keeps the cheap whole-dir symlink
      // below — preserving the single-inode contract.
      links[sub] = linkSubtreeExcludingTeams(target, dest)
    } else {
      links[sub] = symlinkOrCopy(target, dest)
    }
  }

  // Link the provider-invariant settings file (codex config.toml / gemini
  // settings.json) when the framework has one and the user has not authored a
  // local override in the workspace.
  const settingsFile =
    input.provider === 'codex' ? 'config.toml' : input.provider === 'gemini' ? 'settings.json' : null
  if (settingsFile) {
    const settingsTarget = path.join(currentProviderDir, settingsFile)
    const settingsLink = path.join(workspaceProviderDir, settingsFile)
    if (pathExists(settingsTarget) && !pathExists(settingsLink)) {
      links[settingsFile] = symlinkOrCopy(settingsTarget, settingsLink)
    }
  }

  // (b) Seed the PROJECT layer (real writable files / dirs).
  const seededMemoryAgents = seedProjectLayer(input, currentProviderDir)

  // Manifest: record the consumed framework version. `buildManifest` hashes the
  // package's templates/ + commands (provenance), written under the workspace.
  const manifest = buildManifest({
    scriptDir: input.scriptDir,
    repoRoot: input.workspace,
    version: input.version,
  })
  writeManifestFiles(input.workspace, manifest)

  return { links, seededMemoryAgents }
}

/**
 * Seed the per-workspace PROJECT layer: real agent-memory dirs (+ explanations/),
 * the project-named instruction file, and — for gemini — the headless
 * acknowledgments re-hashed against the LINKED agent files. Returns the agent
 * ids whose memory dirs were created.
 */
function seedProjectLayer(input: AssembleProjectWorkspaceInput, currentProviderDir: string): string[] {
  const selected = input.selectedAgents
    ? new Set([...input.selectedAgents, ...CORE_AGENTS])
    : new Set([...CORE_AGENTS])
  // Discover which agents the framework actually placed (so memory dirs match
  // the linked agent set), intersected with the selection.
  const agentsLinkDir = path.join(currentProviderDir, 'agents')
  const placedAgentIds: string[] = []
  if (isDir(agentsLinkDir)) {
    for (const entry of listDir(agentsLinkDir)) {
      const name = path.basename(entry)
      if (!name.endsWith('.md')) continue
      const id = name.slice(0, -3)
      if (selected.has(id) && !QUICK_EXCLUDED_AGENTS.has(id)) placedAgentIds.push(id)
    }
  }

  const seededMemoryAgents: string[] = []
  if (input.provider === 'claude') {
    for (const id of placedAgentIds) {
      mkdirp(path.join(input.workspace, '.claude', 'agent-memory', id))
      seededMemoryAgents.push(id)
      if (EXPLANATION_AUTHORS.has(id)) {
        mkdirp(path.join(input.workspace, '.claude', 'agent-memory', 'explanations'))
      }
    }
  } else if (input.provider === 'gemini') {
    for (const id of placedAgentIds) {
      mkdirp(path.join(input.workspace, '.gemini', 'agent-memory', id))
      seededMemoryAgents.push(id)
    }
  }

  // Project-named instruction file (codex AGENTS.md / gemini GEMINI.md). Reuse
  // the same sentinel-upsert helpers via the settings appliers, scoped so they
  // ONLY emit the instruction file (the settings file is already linked above).
  if (input.provider === 'codex') {
    seedInstructionFile(
      path.join(input.workspace, 'AGENTS.md'),
      renderInitialAgentsMd(input.codeRoot),
    )
  } else if (input.provider === 'gemini') {
    seedInstructionFile(
      path.join(input.workspace, 'GEMINI.md'),
      renderInitialGeminiMd(input.codeRoot),
    )
    // Gemini headless acks: hash the LINKED agent files (read through the
    // symlink) keyed on the real repo so `gemini -p` trusts them with no prompt.
    try {
      writeGeminiAgentAcknowledgments(input.codeRoot, placedAgentIds, input.workspace)
    } catch (err) {
      warn(`gemini agent pre-acknowledgment skipped: ${(err as Error).message}`)
    }
  }

  return seededMemoryAgents
}

/**
 * Per-file link the framework `agents/` into a REAL workspace `agents/` dir.
 * Keeps `custom-*.md` (and any other user-authored file that the framework does
 * NOT provide) byte-untouched — the reserved-paths contract — while pointing
 * every SELECTED framework-owned agent at the shared read-only copy.
 *
 * `selectedIds` is the per-project agent allow-list (already unioned with the
 * CORE trio by the caller). Only framework agents whose id is in it AND not in
 * `QUICK_EXCLUDED_AGENTS` are linked — the shared framework store is the full
 * superset, so this is where per-project filtering lands. `undefined` ⇒ link
 * every framework agent (used by the legacy callers / parity tests).
 *
 * Returns the dominant mechanism used across the linked files (`copy` if any
 * file fell back to copy — the normal case on Windows without Developer Mode).
 */
function linkAgentFiles(
  frameworkAgentsDir: string,
  workspaceAgentsDir: string,
  selectedIds?: Set<string>,
): 'symlink' | 'junction' | 'copy' {
  mkdirp(workspaceAgentsDir)
  // Names the framework currently PROVIDES (regardless of selection) — used to
  // distinguish a framework-owned file from a user `custom-*.md` during cleanup.
  const frameworkProvided = new Set<string>()
  // Names actually LINKED this pass (the selected subset).
  const linkedNames = new Set<string>()
  let mechanism: 'symlink' | 'junction' | 'copy' = 'symlink'
  for (const src of listDir(frameworkAgentsDir)) {
    const name = path.basename(src)
    if (!name.endsWith('.md')) continue
    frameworkProvided.add(name)
    const id = name.slice(0, -3)
    if (selectedIds && (!selectedIds.has(id) || QUICK_EXCLUDED_AGENTS.has(id))) continue
    linkedNames.add(name)
    const m = symlinkOrCopy(src, path.join(workspaceAgentsDir, name))
    if (m === 'copy') mechanism = 'copy'
    else if (m === 'junction' && mechanism !== 'copy') mechanism = 'junction'
  }
  // Drop STALE framework artifacts in the workspace agents dir — both prior-
  // version symlinks AND copy-fallback files (Windows) that are no longer linked
  // this pass (a dropped agent, or one deselected). NEVER remove a user file:
  // `custom-*.md` and agent-memory are reserved. The discriminator is "the
  // framework owns this name (it's currently provided OR it was a previous
  // framework link/copy that the framework no longer provides)" — we approximate
  // it as: remove any entry NOT in `linkedNames` that is either a symlink (old
  // framework link) OR a NON-custom framework-shaped file the framework once
  // provided. `custom-*.md` is always skipped.
  for (const existing of listDir(workspaceAgentsDir)) {
    const name = path.basename(existing)
    if (linkedNames.has(name)) continue
    if (name.startsWith('custom-')) continue // reserved user agent — never touch
    if (isSymlink(existing)) {
      // A prior framework symlink no longer selected/provided → stale, drop it.
      removePath(existing)
      continue
    }
    // A copy-fallback framework file (Windows): a non-symlink `.md` that the
    // framework provides (or provided) but is not a user custom agent. Remove it
    // so a version swap or a deselect cleans up the copied agent. Files the
    // framework never provided (genuine user agents) are left untouched.
    if (name.endsWith('.md') && (frameworkProvided.has(name) || isFrameworkAgentName(name))) {
      removePath(existing)
    }
  }
  return mechanism
}

/**
 * True when `name` (an `<id>.md`) matches a framework-owned agent id (`sr-*`).
 * Used to identify a stale COPY-fallback framework agent on Windows that the
 * current framework version no longer provides, so it can be cleaned up on a
 * version swap. `custom-*.md` (handled by the caller) and any non-`sr-` user
 * file are deliberately excluded.
 */
function isFrameworkAgentName(name: string): boolean {
  return /^sr-[a-z0-9-]+\.md$/.test(name)
}

/**
 * True when a framework subtree (`commands`/`skills`) contains any `team-*`
 * entry (a `team-*.md` file or a `team-*` skill dir), recursively. Gates the
 * per-file team-excluding link path: when no team entries exist the workspace
 * keeps the cheap whole-dir symlink. Recurses into real subdirs (e.g.
 * `.claude/commands/specrails/`).
 */
function subtreeHasTeamEntries(subtreeDir: string): boolean {
  for (const entry of listDir(subtreeDir)) {
    const name = path.basename(entry)
    if (/^team-/.test(name) || /^team-/.test(name.replace(/\.md$/, ''))) return true
    if (isDir(entry) && !isSymlink(entry) && subtreeHasTeamEntries(entry)) return true
  }
  return false
}

/**
 * Link a whole framework subtree (`commands`/`skills`) into the workspace
 * PER-FILE, EXCLUDING the Agent-Teams `team-*` entries. Used when `agentTeams`
 * is off and the shared framework store (always the superset) carries the team
 * commands the lean install must not surface. Recurses into subdirs (e.g.
 * `.claude/commands/specrails/`). Returns the dominant mechanism.
 */
function linkSubtreeExcludingTeams(
  frameworkSubtreeDir: string,
  workspaceSubtreeDir: string,
): 'symlink' | 'junction' | 'copy' {
  mkdirp(workspaceSubtreeDir)
  let mechanism: 'symlink' | 'junction' | 'copy' = 'symlink'
  const bump = (m: 'symlink' | 'junction' | 'copy') => {
    if (m === 'copy') mechanism = 'copy'
    else if (m === 'junction' && mechanism !== 'copy') mechanism = 'junction'
  }
  const linkedNames = new Set<string>()
  for (const src of listDir(frameworkSubtreeDir)) {
    const name = path.basename(src)
    // Exclude team commands/skills whether they ship as `team-*.md` files or
    // `team-*/` skill dirs.
    if (/^team-/.test(name) || /^team-/.test(name.replace(/\.md$/, ''))) continue
    linkedNames.add(name)
    const dest = path.join(workspaceSubtreeDir, name)
    if (isDir(src) && !isSymlink(src)) {
      // Recurse: a real framework subdir is mirrored as a real workspace subdir
      // so a future agentTeams=false re-link can prune team-* inside it too.
      bump(linkSubtreeExcludingTeams(src, dest))
    } else {
      bump(symlinkOrCopy(src, dest))
    }
  }
  // Drop stale framework entries (including team-* left from a prior agentTeams
  // run) that are no longer linked. Only symlinks/copied framework files — there
  // are no user files under commands/skills.
  for (const existing of listDir(workspaceSubtreeDir)) {
    const name = path.basename(existing)
    if (linkedNames.has(name)) continue
    removePath(existing)
  }
  return mechanism
}

/** Write or sentinel-upsert a project instruction file (AGENTS.md/GEMINI.md). */
function seedInstructionFile(filePath: string, content: string): void {
  if (!pathExists(filePath)) {
    writeFileLf(filePath, content)
    return
  }
  const existing = readTextFile(filePath)
  const next = upsertAgentsMdManagedBlock(existing, extractManagedBlock(content))
  if (next !== existing) writeFileLf(filePath, next)
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
      const destDir = path.join(input.artifactRoot, input.providerDir, 'skills', skillName)
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

  if (input.provider === 'gemini') {
    // Gemini: each bundled command becomes a TOML custom command under
    // .gemini/commands/specrails/<name>.toml.
    const destDir = path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails')
    let count = 0
    for (const entry of listDir(commandsSrc)) {
      const name = path.basename(entry)
      if (!name.endsWith('.md')) continue
      if (name === 'setup.md') continue
      if (!input.agentTeams && /^team-/.test(name)) continue
      writeGeminiCommandFromCommand({
        src: entry,
        dest: path.join(destDir, `${name.replace(/\.md$/, '')}.toml`),
      })
      count++
    }
    input.copiedIncrement(count)
    return
  }

  // Claude: all bundled commands land under <providerDir>/commands/specrails/.
  const destDir = path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails')
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

/**
 * Convert a claude slash-command markdown file into a gemini custom command TOML
 * (`.gemini/commands/specrails/<name>.toml`). Gemini commands carry ONLY
 * `prompt` + `description` (no per-command tool/model keys — that routing lives
 * in the subagent frontmatter). Keeps gemini's native `/specrails:<name>` slash
 * form (unlike codex's `$name`); only `.claude/` paths are rewritten.
 */
function writeGeminiCommandFromCommand(args: { src: string; dest: string; description?: string }): void {
  if (!pathExists(args.src)) return
  const { body, description: srcDescription } = stripFrontmatter(readTextFile(args.src))
  const name = path.basename(args.dest).replace(/\.toml$/, '')
  const description = args.description ?? srcDescription ?? `specrails ${name} command`
  const translatedBody = body.replace(/\.claude\//g, '.gemini/')
  // TOML literal multiline strings ('''…''') need no escaping — unless the body
  // itself contains ''', in which case fall back to a basic escaped string.
  let promptToml: string
  if (translatedBody.includes("'''")) {
    const escaped = translatedBody.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
    promptToml = `prompt = "${escaped}"\n`
  } else {
    promptToml = `prompt = '''\n${translatedBody}\n'''\n`
  }
  writeFileLf(args.dest, `description = ${JSON.stringify(description)}\n${promptToml}`)
}

/**
 * Emit a gemini subagent (`.gemini/agents/<id>.md`) from a claude persona
 * template. Re-emits gemini YAML frontmatter (name/description/model/tools),
 * dropping claude `color:`/`memory:`; the persona body is reused, `.claude/`
 * paths rewritten and `{{MEMORY_PATH}}` pointed at `.gemini/agent-memory/`.
 */
function writeGeminiAgentFromTemplate(args: {
  artifactRoot: string
  src: string
  agentId: string
  placeholders: Record<string, string>
  /** When false, skip the per-workspace agent-memory mkdir (framework path). */
  seedProjectDirs?: boolean
}): void {
  if (!pathExists(args.src)) return
  const { body, description } = stripFrontmatter(readTextFile(args.src))
  const model = GEMINI_MODEL_BY_AGENT[args.agentId] ?? GEMINI_DEFAULT_MODEL
  const frontmatter = [
    '---',
    `name: ${args.agentId}`,
    `description: ${JSON.stringify(description ?? args.agentId)}`,
    `model: ${model}`,
    `tools: [${GEMINI_AGENT_TOOLS.join(', ')}]`,
    '---',
    '',
  ].join('\n')
  const renderedBody = translateOpsxSkillCallsForGemini(
    renderPlaceholders(body, {
      ...args.placeholders,
      MEMORY_PATH: `.gemini/agent-memory/${args.agentId}/`,
    }).replace(/\.claude\//g, '.gemini/'),
  )
  writeFileLf(path.join(args.artifactRoot, '.gemini', 'agents', `${args.agentId}.md`), frontmatter + renderedBody)
  if (args.seedProjectDirs !== false) {
    mkdirp(path.join(args.artifactRoot, '.gemini', 'agent-memory', args.agentId))
  }
}

/**
 * Place the gemini subagents under `.gemini/agents/` from the staged persona
 * templates (both tiers). Honours the agent selection; defaults to CORE_AGENTS.
 */
function placeGeminiAgents(input: ScaffoldInput): SkillsPlacement {
  const result: SkillsPlacement = { placed: 0, skipped: 0, filesCopied: 0 }
  const agentsSrc = path.join(input.artifactRoot, '.specrails', 'setup-templates', 'agents')
  if (!isDir(agentsSrc)) return result
  mkdirp(path.join(input.artifactRoot, '.gemini', 'agents'))
  const selectedAgents = input.selectedAgents
    ? new Set([...input.selectedAgents, ...CORE_AGENTS])
    : new Set([...CORE_AGENTS])
  const placeholders = {
    PROJECT_NAME: path.basename(input.codeRoot),
    SECURITY_EXEMPTIONS_PATH: '.gemini/security-exemptions.yaml',
    PERSONA_DIR: '.gemini/agents/personas/',
  }
  const placedIds: string[] = []
  for (const src of listDir(agentsSrc)) {
    const name = path.basename(src)
    if (!name.endsWith('.md')) continue
    const agentId = name.slice(0, -3)
    // Superset materialization (installFramework) places EVERY agent; per-project
    // filtering happens at the workspace LINK step (linkAgentFiles).
    if (!input.materializeAllAgents && !selectedAgents.has(agentId)) continue
    if (!input.materializeAllAgents && QUICK_EXCLUDED_AGENTS.has(agentId)) {
      result.skipped++
      continue
    }
    writeGeminiAgentFromTemplate({
      artifactRoot: input.artifactRoot,
      src,
      agentId,
      placeholders,
      seedProjectDirs: input.seedProjectDirs,
    })
    placedIds.push(agentId)
    result.placed++
    result.filesCopied++
  }
  // The pre-acknowledgment is a PER-WORKSPACE seed (keyed on codeRoot, hashing the
  // workspace's linked agent files). It is skipped when materializing the shared
  // framework — `assembleProjectWorkspace` re-writes it against the LINKED files.
  if (input.seedProjectDirs !== false) {
    try {
      // Key the acknowledgment on the real repo (codeRoot) so gemini matches the
      // project, but hash the agent files from the relocated artifactRoot.
      writeGeminiAgentAcknowledgments(input.codeRoot, placedIds, input.artifactRoot)
    } catch (err) {
      warn(`gemini agent pre-acknowledgment skipped: ${(err as Error).message}`)
    }
  }
  return result
}

/**
 * Pre-acknowledge the generated gemini subagents so they load in HEADLESS
 * (`gemini -p`) runs. gemini 0.46+ DISCOVERS `.gemini/agents/*.md` but only
 * ENABLES a project's custom agents after the interactive "New Agents Discovered
 * → Acknowledge and Enable" prompt — which never fires headless, so
 * `invoke_agent sr-architect` returns "Subagent not found" and the implement
 * orchestrator silently falls back to a generic agent (the specialised personas
 * never run, the pipeline degrades). The acknowledgment is a user-global file
 * `~/.gemini/acknowledgments/agents.json` shaped
 * `{ [projectRoot]: { [agentName]: <sha256-hex of the agent .md file> } }`
 * (hash algorithm verified empirically against gemini 0.47 = sha256 of the full
 * file). Writing it at install time makes the freshly-generated agents trusted
 * with no prompt, for both `gemini` CLI and the desktop's headless spawns. The
 * file is MERGED — other projects' and other agents' entries are preserved.
 * Best-effort: any failure is swallowed by the caller (agents still work once
 * acknowledged interactively).
 */
export function writeGeminiAgentAcknowledgments(
  repoRoot: string,
  agentIds: string[],
  agentsBaseDir: string = repoRoot,
): void {
  if (agentIds.length === 0) return
  const ackPath = path.join(os.homedir(), '.gemini', 'acknowledgments', 'agents.json')
  let store: Record<string, Record<string, string>> = {}
  if (pathExists(ackPath)) {
    try {
      const parsed = JSON.parse(readTextFile(ackPath)) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        store = parsed as Record<string, Record<string, string>>
      }
    } catch {
      // Corrupt/unreadable file — start fresh rather than crash the install.
    }
  }
  // The store is KEYED on `agentsBaseDir` — the directory gemini ACTUALLY runs
  // in when it resolves the project's agents. Under relocation the linked agents
  // live in the WORKSPACE (rails spawn with cwd=workspace), so the ack must be
  // keyed on the workspace providerDir base, not the repo; otherwise headless
  // `gemini -p` looks up `store[<workspace>]`, finds nothing, and the specialised
  // personas never load. The agent FILES are hashed from `agentsBaseDir` too
  // (read through the workspace symlinks ⇒ framework file content). When
  // `agentsBaseDir` defaults to `repoRoot` (legacy in-repo layout, 2-arg call)
  // the key is byte-identical to before.
  const ackKey = agentsBaseDir
  const projectEntry: Record<string, string> = { ...(store[ackKey] ?? {}) }
  for (const agentId of agentIds) {
    const agentFile = path.join(agentsBaseDir, '.gemini', 'agents', `${agentId}.md`)
    if (!pathExists(agentFile)) continue
    projectEntry[agentId] = createHash('sha256').update(readTextFile(agentFile)).digest('hex')
  }
  store[ackKey] = projectEntry
  mkdirp(path.dirname(ackPath))
  writeFileLf(ackPath, `${JSON.stringify(store, null, 2)}\n`)
}

/** Recursive JSON object merge; source wins on scalars/arrays. */
function deepMergeJson(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target }
  for (const [k, v] of Object.entries(source)) {
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMergeJson(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Gemini provider settings: `.gemini/settings.json` (deep-merged so user keys
 * survive — adds `experimental.enableAgents`) and `GEMINI.md` (sentinel-block
 * upsert, identical mechanism to codex AGENTS.md). Returns files written.
 */
function applyGeminiSettings(input: ScaffoldInput): number {
  let written = 0
  const settingsSrc = path.join(input.scriptDir, 'templates', 'settings', 'gemini-settings.json')
  if (pathExists(settingsSrc)) {
    const dest = path.join(input.artifactRoot, input.providerDir, 'settings.json')
    const template = JSON.parse(readTextFile(settingsSrc)) as Record<string, unknown>
    if (pathExists(dest)) {
      try {
        const existing = JSON.parse(readTextFile(dest)) as Record<string, unknown>
        writeFileLf(dest, JSON.stringify(deepMergeJson(existing, template), null, 2) + '\n')
        written++
      } catch (err) {
        warn(`existing ${dest} is not valid JSON — leaving it untouched: ${(err as Error).message}`)
      }
    } else {
      writeFileLf(dest, JSON.stringify(template, null, 2) + '\n')
      written++
    }
  }

  const geminiMdPath = path.join(input.artifactRoot, 'GEMINI.md')
  // Project name in the rendered body derives from the real repo (codeRoot),
  // while the file itself lands under the relocated artifactRoot.
  const content = renderInitialGeminiMd(input.codeRoot)
  if (!pathExists(geminiMdPath)) {
    writeFileLf(geminiMdPath, content)
    written++
  } else {
    const existing = readTextFile(geminiMdPath)
    const next = upsertAgentsMdManagedBlock(existing, extractManagedBlock(content))
    if (next !== existing) {
      writeFileLf(geminiMdPath, next)
      written++
    }
  }
  return written
}

function renderInitialGeminiMd(repoRoot: string): string {
  const projectName = path.basename(repoRoot)
  return [
    AGENTS_MD_START,
    '',
    `# ${projectName} — agent instructions`,
    '',
    'This project uses the **specrails** agent workflow under `.gemini/`.',
    'See `.gemini/commands/specrails/` for the slash commands and `.gemini/agents/`',
    'for the `sr-*` subagents available to gemini sessions in this repository.',
    '',
    '## Conventions',
    '',
    '- Read specs from `.specrails/local-tickets.json` when implementing',
    '  numbered tickets (`#42`, `#71` etc.).',
    '- Prefer the `/specrails:*` commands (implement, batch-implement, …) over',
    '  ad-hoc edits when one covers the task.',
    '- Agent execution is enabled via `.gemini/settings.json`',
    '  (`experimental.enableAgents: true`).',
    '',
    AGENTS_MD_END,
    '',
  ].join('\n')
}

function pruneLegacyArtifacts(
  input: Pick<ScaffoldInput, 'artifactRoot' | 'codeRoot' | 'provider' | 'providerDir'>,
): void {
  const legacyPaths = [
    path.join(input.artifactRoot, '.specrails', 'bin', 'doctor.sh'),
    path.join(input.artifactRoot, '.specrails', 'setup-templates', '.provider-detection.json'),
    path.join(input.artifactRoot, '.specrails', 'setup-templates', 'settings', 'integration-contract.json'),
    path.join(input.artifactRoot, '.specrails-version'),
  ]

  if (input.provider === 'codex') {
    // Pre-§18 layout used `.agents/skills/` — prune any leftovers from a
    // legacy install before settling on the canonical `.codex/skills/`.
    legacyPaths.push(path.join(input.artifactRoot, '.agents'))
    legacyPaths.push(path.join(input.artifactRoot, input.providerDir, 'skills', 'setup'))
  } else if (input.provider === 'gemini') {
    // Prune a stale WIP skills/ tree + any setup command leftovers.
    legacyPaths.push(path.join(input.artifactRoot, input.providerDir, 'skills'))
    legacyPaths.push(path.join(input.artifactRoot, input.providerDir, 'commands', 'setup.toml'))
    legacyPaths.push(path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails', 'setup.toml'))
  } else {
    legacyPaths.push(path.join(input.artifactRoot, input.providerDir, 'commands', 'setup.md'))
    legacyPaths.push(path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails', 'setup.md'))
  }

  // Safety invariant: every prune target MUST live inside artifactRoot. Under
  // relocate-always artifactRoot is the $HOME workspace, so this guarantees the
  // installer never rmSync's anything inside the user's repo (codeRoot).
  const artifactRootResolved = path.resolve(input.artifactRoot)
  for (const target of legacyPaths) {
    const resolved = path.resolve(target)
    const rel = path.relative(artifactRootResolved, resolved)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      warn(`refusing to prune ${target} — outside artifactRoot ${input.artifactRoot}`)
      continue
    }
    try {
      rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
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
    const setupTemplates = path.join(input.artifactRoot, '.specrails', 'setup-templates')
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
        const dest = path.join(input.artifactRoot, input.providerDir, 'skills', skillName, 'SKILL.md')

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

  if (input.provider === 'gemini') {
    // Gemini: port the slash-command catalogue to .gemini/commands/specrails/
    // <name>.toml. Hand-authored orchestrator overrides (implement,
    // batch-implement) under templates/gemini-commands/ win verbatim. Agents
    // are placed by placeSkills → placeGeminiAgents (both tiers).
    const geminiSetupTemplates = path.join(input.artifactRoot, '.specrails', 'setup-templates')
    const commandsSrc = path.join(geminiSetupTemplates, 'commands', 'specrails')
    const overridesSrc = path.join(input.scriptDir, 'templates', 'gemini-commands')
    let commandsPlaced = 0
    if (isDir(commandsSrc)) {
      for (const src of listDir(commandsSrc)) {
        const name = path.basename(src)
        if (!name.endsWith('.md')) continue
        if (name === 'setup.md') continue
        if (!input.agentTeams && /^team-/.test(name)) continue
        const cmdName = name.slice(0, -3)
        const dest = path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails', `${cmdName}.toml`)
        const overrideToml = path.join(overridesSrc, `${cmdName}.toml`)
        if (pathExists(overrideToml)) {
          copyFile(overrideToml, dest)
        } else {
          writeGeminiCommandFromCommand({ src, dest })
        }
        commandsPlaced++
      }
    }
    return { agents: 0, commands: commandsPlaced, rules: 0, skippedAgents: 0 }
  }

  const setupTemplates = path.join(input.artifactRoot, '.specrails', 'setup-templates')
  // PROJECT_NAME is the real repo's basename, not the relocated workspace dir.
  const projectName = path.basename(input.codeRoot)
  const providerDirAbs = path.join(input.artifactRoot, input.providerDir)

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
      // Superset materialization (installFramework) places EVERY agent so any
      // project's selection can later link from the shared store; per-project
      // filtering happens at the workspace LINK step, not here.
      if (!input.materializeAllAgents && selectedAgents && !selectedAgents.has(agentId)) continue

      if (!input.materializeAllAgents && QUICK_EXCLUDED_AGENTS.has(agentId)) {
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

      // Per-agent memory directory. Created even when empty so the first run of
      // the agent doesn't error on ENOENT. Skipped when materializing the SHARED
      // framework (`seedProjectDirs === false`): agent-memory is per-workspace
      // mutable state seeded later by `seedProjectLayer`, NEVER part of the
      // read-only framework copy that workspaces symlink.
      if (input.seedProjectDirs !== false) {
        mkdirp(path.join(input.artifactRoot, '.claude', 'agent-memory', agentId))
        if (EXPLANATION_AUTHORS.has(agentId)) {
          mkdirp(path.join(input.artifactRoot, '.claude', 'agent-memory', 'explanations'))
        }
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
    const dest = path.join(input.artifactRoot, input.providerDir, 'config.toml')
    const rendered = readTextFile(configTomlSrc).replace(/\{\{MODEL_NAME\}\}/g, 'gpt-5.5-mini')
    writeFileLf(dest, rendered)
    written++
  }

  // AGENTS.md — top-level instructions file the codex CLI loads on startup.
  // Written with a sentinel block so update + enrich passes can refresh the
  // managed content while preserving anything the user added outside it.
  const agentsMdPath = path.join(input.artifactRoot, 'AGENTS.md')
  const agentsMdContent = renderInitialAgentsMd(input.codeRoot)
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
  const destBase = path.join(input.artifactRoot, input.providerDir, 'skills')
  const result: SkillsPlacement = { placed: 0, skipped: 0, filesCopied: 0 }

  // Top-level skills — Claude only, generated from the canonical command body.
  if (input.provider === 'claude') {
    const commandsSrc = path.join(input.artifactRoot, '.specrails', 'setup-templates', 'commands', 'specrails')
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

  // Gemini: place the `sr-*` subagents under .gemini/agents/ (both tiers).
  if (input.provider === 'gemini') {
    const g = placeGeminiAgents(input)
    result.placed += g.placed
    result.skipped += g.skipped
    result.filesCopied += g.filesCopied
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
