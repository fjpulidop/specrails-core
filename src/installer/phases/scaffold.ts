import { createHash } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
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
  readBytes,
  readTextFile,
  removePath,
  symlinkOrCopy,
  writeFileLf,
} from '../util/fs.js'
import { info, ok, warn } from '../util/logger.js'

import { buildManifest, writeManifestFiles } from './manifest.js'
import type { Provider } from './provider-detect.js'

/**
 * The three baseline agents — the COMPLETE set of agents the installer
 * ships. The implement pipeline depends on all three. Any additional agent
 * comes from a user-authored profile (`custom-*`), never the installer.
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

/** OpenSpec's published Kimi skill ids. The mapping is intentionally explicit. */
const OPSX_TO_KIMI_SKILL: Record<string, string> = {
  propose: 'openspec-propose',
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
 * Port shared Claude-authored prose to Kimi's directory-skill contract.
 *
 * Kimi's TUI/ACP clients intercept `/skill:*`, but a materialized workflow is
 * already running inside a Session and must activate nested workflows through
 * Kimi's built-in `Skill` tool (`{ skill, args }`). Emitting slash text here
 * would silently become ordinary model text under `kimi -p`. Interactive slash
 * examples therefore belong only in AGENTS/docs, never generated skill bodies.
 * This is render-only; canonical Claude/Codex/Gemini templates stay unchanged.
 */
export function translateClaudeTextForKimi(body: string): string {
  let translated = body.replace(
    /Skill\("opsx:([a-z-]+)"(?:\s*,\s*("[^"]*"|'[^']*'|[^)]*))?\)/g,
    (_match, id: string, input: string | undefined) => {
      const skill = OPSX_TO_KIMI_SKILL[id]
      if (!skill) return `Unresolved Kimi Skill tool mapping for "opsx:${id}"`
      const args = input?.replace(/^["']|["']$/g, '') ?? ''
      return `Skill(skill="${skill}", args=${JSON.stringify(args)})`
    },
  )
  translated = translated
    .replace(/\.claude\/agents\/personas\//g, '.kimi-code/personas/')
    .replace(/\.claude\/agents\//g, '.kimi-code/skills/')
    .replace(
      /(\.kimi-code\/skills\/[^\s`"'()]+)\.md/g,
      '$1/SKILL.md',
    )
    .replace(/\.claude\//g, '.kimi-code/')
    .replace(/\.claude\b/g, '.kimi-code')
    .replace(/\bCLAUDE\.md\b/g, '.kimi-code/AGENTS.md')
    .replace(
      /\/(?:specrails|sr):([a-z0-9-]+)/g,
      'Skill(skill="specrails-$1", args=<arguments following this command>)',
    )
    .replace(
      /\/(?:specrails|sr):/g,
      'Skill(skill="specrails-<command>", args=<arguments following this command>)',
    )
    .replace(/\bsubagent_type\b/g, 'role_skill')
    .replace(/\bClaude Code\b/g, 'Kimi Code')
    .replace(/\bClaude CLI\b/g, 'Kimi CLI')
    .replace(/\bAgent tool\b/g, 'external Kimi role process')
  return translated
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
}

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
 *   - Copy templates into `.specrails/setup-templates/` (the internal
 *     staging dir that placement copies from and `update` diffs against).
 *   - Ensure `.gitignore` excludes the runtime artefacts.
 *
 * Placement (`placeArtefacts`) then copies the staged templates directly into
 * the user's live `.claude/agents/` and `.claude/commands/specrails/` dirs so
 * the installer finishes in one pass — no follow-up wizard required.
 */

export interface ScaffoldInput {
  /** Absolute path to the specrails-core package (installed via npx). */
  scriptDir: string
  /**
   * Absolute path to the relocated artifact root — where every Specrails-managed
   * artifact (.specrails/.claude/.codex/.gemini/.kimi-code and instruction/settings files)
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
  /** Optional explicit allow-list used by config-driven installs. */
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
   * `selectedAgents`. Used by `installFramework` so
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
  // Kimi skills are linked one directory at a time so direct-child OpenSpec
  // skills and user-owned custom-* roles can coexist. The self-contained
  // headless runner and its vendored parser are Core-owned and linked as a
  // separate static subtree.
  kimi: ['rules', 'specrails'],
}

const KIMI_RUNNER_RELATIVE_FILES = [
  'run-skill.mjs',
  path.join('vendor', 'js-yaml', 'js-yaml.mjs'),
  path.join('vendor', 'js-yaml', 'LICENSE'),
  path.join('vendor', 'js-yaml', 'NOTICE.md'),
] as const

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
    mk(path.join(input.artifactRoot, input.providerDir, 'skills', 'doctor'))
    mk(path.join(input.artifactRoot, input.providerDir, 'skills', 'rails'))
  } else if (input.provider === 'gemini') {
    // Gemini: TOML commands under .gemini/commands/specrails/ + native
    // subagents under .gemini/agents/. No skills/ tree.
    mk(path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails'))
    mk(path.join(input.artifactRoot, input.providerDir, 'agents'))
  } else if (input.provider === 'kimi') {
    mk(path.join(input.artifactRoot, input.providerDir, 'skills'))
    mk(path.join(input.artifactRoot, input.providerDir, 'specrails'))
    mk(path.join(input.artifactRoot, input.providerDir, 'rules'))
  } else {
    mk(path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails'))
    mk(path.join(input.artifactRoot, input.providerDir, 'skills'))
  }
  const setupTemplates = path.join(input.artifactRoot, '.specrails', 'setup-templates')
  mk(path.join(setupTemplates, 'agents'))
  mk(path.join(setupTemplates, 'commands'))
  mk(path.join(setupTemplates, 'skills'))
  mk(path.join(setupTemplates, 'rules'))
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
    if (input.provider === 'kimi') {
      gitignoreEntries.push(
        '.kimi-code/agent-memory/',
        '.kimi-code/pipeline-state/',
        '.kimi-code/.dry-run/',
        '.kimi-code/telemetry/',
      )
    }
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

  // --- Write bundled commands (doctor.md) ---
  copyBundledCommands({ ...input, copiedIncrement: (n) => (copiedFiles += n) })
  pruneLegacyArtifacts(input)
  if (input.provider === 'kimi') {
    copiedFiles += placeKimiSkillRunner(input)
  }

  // --- Direct placement (the only path) ---
  {
    const placed = placeArtefacts({ ...input })
    copiedFiles += placed.agents + placed.commands + placed.rules
    info(
      `Placed ${placed.agents} agent(s) + ${placed.commands} command(s) + ` +
        `${placed.rules} rule file(s) directly into ${input.providerDir}/`,
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
    const skillsLabel = input.provider === 'gemini' ? 'agent' : 'skill'
    const skillsSubdir = input.provider === 'gemini' ? 'agents' : 'skills'
    info(
      `Placed ${skills.placed} ${skillsLabel}(s) into ${input.providerDir}/${skillsSubdir}/`,
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
  } else if (input.provider === 'kimi') {
    const written = applyKimiSettings(input)
    copiedFiles += written
    if (written > 0) {
      info(`Kimi provider: wrote ${written} setting file(s) (.kimi-code/AGENTS.md, mcp.json)`)
    }
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
  /** Derived provider dir (`.claude`/`.codex`/`.gemini`/`.kimi-code`). */
  providerDir: string
  /** Framework version (the `<version>/` segment). */
  version: string
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
export function frameworkStampPath(versionDir: string, providerDir: string): string {
  // Store the stamp OUTSIDE the providerDir so it never leaks into the linked
  // subtree. `.stamp-<providerDir>.json` is provider-keyed.
  return path.join(versionDir, `.framework-stamp${providerDir}.json`)
}

interface FrameworkStamp {
  schema: 1
  version: string
  provider: Provider
  source_hash: string
  content_hash: string
}

/**
 * Stable Merkle-like digest over regular files. Relative POSIX paths and raw
 * bytes are both framed into the hash, so renames, missing files, additions and
 * byte corruption are detected. Directory mtimes and traversal order never
 * affect the result.
 */
function hashFrameworkTrees(
  roots: Array<{ label: string; dir: string }>,
  options: { ignorePackageNoise?: boolean } = {},
): string {
  const hash = createHash('sha256')

  const walk = (root: string, current: string, label: string): void => {
    const entries = listDir(current).sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b)),
    )
    for (const entry of entries) {
      const name = path.basename(entry)
      if (
        options.ignorePackageNoise === true &&
        (name === 'node_modules' || name === 'package-lock.json')
      ) {
        continue
      }
      const rel = path.relative(root, entry).split(path.sep).join('/')
      if (isDir(entry)) {
        walk(root, entry, label)
        continue
      }
      if (!pathExists(entry)) continue
      const framedPath = `${label}/${rel}`
      const bytes = readBytes(entry)
      hash.update(`file\0${Buffer.byteLength(framedPath)}\0${framedPath}\0`)
      hash.update(`${bytes.byteLength}\0`)
      hash.update(bytes)
    }
  }

  for (const root of [...roots].sort((a, b) => a.label.localeCompare(b.label))) {
    hash.update(`root\0${root.label}\0`)
    if (isDir(root.dir)) {
      walk(root.dir, root.dir, root.label)
    } else {
      hash.update('missing\0')
    }
  }
  return `sha256:${hash.digest('hex')}`
}

/** Hash of every package input that can influence provider materialization. */
function frameworkSourceHash(scriptDir: string, provider: Provider): string {
  const treeHash = hashFrameworkTrees(
    [
      { label: 'templates', dir: path.join(scriptDir, 'templates') },
      { label: 'commands', dir: path.join(scriptDir, 'commands') },
    ],
    { ignorePackageNoise: true },
  )
  return `sha256:${createHash('sha256')
    .update(treeHash)
    .update('\0provider\0')
    .update(provider)
    .digest('hex')}`
}

/** Hash of the provider-static tree workspace links consume. */
function frameworkContentHash(providerFrameworkDir: string): string {
  return hashFrameworkTrees([
    { label: 'provider', dir: providerFrameworkDir },
  ])
}

function readFrameworkStamp(stampPath: string): FrameworkStamp | null {
  if (!pathExists(stampPath)) return null
  try {
    const parsed = JSON.parse(readTextFile(stampPath)) as Partial<FrameworkStamp>
    if (
      parsed.schema !== 1 ||
      typeof parsed.version !== 'string' ||
      typeof parsed.provider !== 'string' ||
      typeof parsed.source_hash !== 'string' ||
      typeof parsed.content_hash !== 'string'
    ) {
      return null
    }
    return parsed as FrameworkStamp
  } catch {
    return null
  }
}

/**
 * Validate one provider in a materialized version without needing the source
 * package. Used by the final swap gate: the stamp identity and current output
 * hash must still agree immediately before `current` moves.
 */
export function frameworkMaterializationProblem(
  versionDir: string,
  version: string,
  provider: Provider,
  providerDir: string,
): string | null {
  const providerFrameworkDir = path.join(versionDir, providerDir)
  const stampPath = frameworkStampPath(versionDir, providerDir)
  if (!isDir(providerFrameworkDir)) return `missing ${providerDir}/`
  const stamp = readFrameworkStamp(stampPath)
  if (!stamp) return `missing or invalid ${path.basename(stampPath)}`
  if (stamp.version !== version || stamp.provider !== provider) {
    return `invalid stamp (expected version=${version}, provider=${provider})`
  }
  if (stamp.content_hash !== frameworkContentHash(providerFrameworkDir)) {
    return 'managed content does not match stamp'
  }
  return null
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
  const sourceHash = frameworkSourceHash(input.scriptDir, input.provider)
  const stamp = readFrameworkStamp(stampPath)

  // Same-version reuse is allowed only when BOTH provenance and every managed
  // output byte still match the deterministic stamp. A legacy/timestamp-only
  // stamp, a changed package source, or any missing/corrupt/extra managed file
  // falls through to a clean provider-tree repair.
  if (
    isDir(providerFrameworkDir) &&
    stamp?.version === input.version &&
    stamp.provider === input.provider &&
    stamp.source_hash === sourceHash &&
    stamp.content_hash === frameworkContentHash(providerFrameworkDir)
  ) {
    return { providerFrameworkDir, versionDir, materialized: false }
  }

  // Framework provider trees are entirely Core-owned. Rebuilding from a clean
  // destination removes stale files as well as repairing corrupt/missing ones,
  // without touching sibling providers already materialized in this version.
  removePath(providerFrameworkDir)
  removePath(stampPath)

  // Reuse scaffoldInstallation's static-placement helpers by pointing
  // `artifactRoot` at the version dir. `seedProjectDirs: false` keeps the copy
  // free of per-workspace mutable state. The `codeRoot` is irrelevant to the
  // STATIC subtree (the project-named instruction files are skipped below), so
  // we hand it the framework dir to satisfy the contract — and we DELETE any
  // project-named instruction file the settings helpers wrote.
  // The SHARED framework store is always the FULL SUPERSET — EVERY agent — so a
  // SECOND project with a DIFFERENT agent selection links its specialists from
  // the same materialized copy instead of inheriting the first project's
  // narrower set. Per-project filtering moves to the workspace LINK step
  // (`linkAgentFiles` via `assembleProjectWorkspace`). `selectedAgents` on the
  // input is intentionally IGNORED here.
  const staticInput: ScaffoldInput = {
    scriptDir: input.scriptDir,
    artifactRoot: versionDir,
    codeRoot: versionDir,
    provider: input.provider,
    providerDir: input.providerDir,
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
  // Kimi's instruction and MCP files are provider-local rather than root-local,
  // but both are project-specific and must be real files in each workspace.
  // In particular, linking mcp.json would let Desktop mutate the shared
  // framework and leak one project's MCP registry into every other project.
  if (input.provider === 'kimi') {
    rmSync(path.join(providerFrameworkDir, 'AGENTS.md'), { force: true })
    rmSync(path.join(providerFrameworkDir, 'mcp.json'), { force: true })
  }

  const frameworkStamp: FrameworkStamp = {
    schema: 1,
    version: input.version,
    provider: input.provider,
    source_hash: sourceHash,
    content_hash: frameworkContentHash(providerFrameworkDir),
  }
  writeFileLf(stampPath, `${JSON.stringify(frameworkStamp, null, 2)}\n`)
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
  /** Derived provider dir (`.claude`/`.codex`/`.gemini`/`.kimi-code`). */
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
   * When true, the static provider subtrees (`agents`/`commands`/`skills`/`rules`)
   * and the settings file are COPIED as real files from the framework store into
   * the workspace instead of SYMLINKED. Used by the in-repo standalone install
   * (`init`/`update` with `artifactRoot === codeRoot`) so the repo gets real,
   * committable files — a symlink into `$HOME/.specrails/framework` would be
   * invisible to a standalone user's `claude`/`codex`/`gemini`/`kimi` running in the
   * repo. The PROJECT layer (agent-memory, manifest, instruction files) is real
   * either way. Defaults to false (relocated workspaces symlink — the desktop /
   * `--relocate` path).
   */
  copyStatics?: boolean
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

  // In-repo standalone install COPIES the static subtrees as real files; the
  // relocated (desktop / --relocate) path symlinks them. Defaults to symlink.
  const preferCopy = input.copyStatics === true

  const links: Record<string, 'symlink' | 'junction' | 'copy'> = {}
  for (const sub of LINKED_PROVIDER_SUBTREES[input.provider]) {
    const target = path.join(currentProviderDir, sub)
    if (!pathExists(target)) continue
    const dest = path.join(workspaceProviderDir, sub)
    if (sub === 'agents') {
      // `agents/` is linked PER-FILE so the workspace can carry user/desktop
      // `custom-*.md` agents alongside the framework agents.
      links[sub] = linkAgentFiles(target, dest, selectedAgentSet, preferCopy)
    } else {
      // Every other subtree holds no user files → whole-dir symlink (single inode).
      links[sub] = symlinkOrCopy(target, dest, preferCopy)
    }
  }
  if (input.provider === 'kimi') {
    const kimiSkillsTarget = path.join(currentProviderDir, 'skills')
    const kimiSkillsDest = path.join(workspaceProviderDir, 'skills')
    migrateLegacyKimiRoleLayout(kimiSkillsDest)
    if (pathExists(kimiSkillsTarget)) {
      links.skills = linkKimiSkillDirectories(
        kimiSkillsTarget,
        kimiSkillsDest,
        selectedAgentSet,
        preferCopy,
      )
    }
  }

  // Link only provider-invariant settings (codex config.toml / gemini
  // settings.json). Kimi mcp.json is a mutable per-project registry and is
  // seeded below as a real workspace file.
  const settingsFile =
    input.provider === 'codex'
      ? 'config.toml'
      : input.provider === 'gemini'
        ? 'settings.json'
        : null
  if (settingsFile) {
    const settingsTarget = path.join(currentProviderDir, settingsFile)
    const settingsLink = path.join(workspaceProviderDir, settingsFile)
    if (pathExists(settingsTarget) && !pathExists(settingsLink)) {
      links[settingsFile] = symlinkOrCopy(settingsTarget, settingsLink, preferCopy)
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
    providers: [input.provider],
    primaryProvider: input.provider,
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
      if (selected.has(id)) placedAgentIds.push(id)
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
  } else if (input.provider === 'kimi') {
    const skillsDir = path.join(currentProviderDir, 'skills')
    if (isDir(skillsDir)) {
      for (const roleDir of listDir(skillsDir)) {
        if (!isDir(roleDir)) continue
        const id = path.basename(roleDir)
        if (
          /^sr-[a-z0-9-]+$/.test(id) &&
          selected.has(id) &&
          pathExists(path.join(roleDir, 'SKILL.md'))
        ) {
          placedAgentIds.push(id)
        }
      }
    }
    for (const id of placedAgentIds) {
      mkdirp(path.join(input.workspace, '.kimi-code', 'agent-memory', id))
      seededMemoryAgents.push(id)
      if (EXPLANATION_AUTHORS.has(id)) {
        mkdirp(path.join(input.workspace, '.kimi-code', 'agent-memory', 'explanations'))
      }
    }
    seedInstructionFile(
      path.join(input.workspace, '.kimi-code', 'AGENTS.md'),
      renderInitialKimiAgentsMd(input.codeRoot),
    )
    seedKimiMcpFile(path.join(input.workspace, '.kimi-code', 'mcp.json'))
    if (input.workspace === input.codeRoot) {
      ensureGitignore(input.codeRoot, [
        '.kimi-code/agent-memory/',
        '.kimi-code/pipeline-state/',
        '.kimi-code/.dry-run/',
        '.kimi-code/telemetry/',
        '.specrails/',
      ])
    }
  }

  return seededMemoryAgents
}

/**
 * Ensure Kimi's per-project MCP registry is a real writable file. Older Core
 * builds could create a framework symlink here; migrate a readable link by
 * copying its bytes locally, or seed an empty registry when the link is stale.
 */
function seedKimiMcpFile(mcpPath: string): void {
  if (isSymlink(mcpPath)) {
    let existing = '{\n  "mcpServers": {}\n}\n'
    try {
      existing = readTextFile(mcpPath)
    } catch {
      // A version swap can leave the obsolete shared-framework link dangling.
    }
    removePath(mcpPath)
    writeFileLf(mcpPath, existing)
    return
  }
  if (!pathExists(mcpPath)) {
    writeFileLf(mcpPath, '{\n  "mcpServers": {}\n}\n')
  }
}

/**
 * Per-file link the framework `agents/` into a REAL workspace `agents/` dir.
 * Keeps `custom-*.md` (and any other user-authored file that the framework does
 * NOT provide) byte-untouched — the reserved-paths contract — while pointing
 * every SELECTED framework-owned agent at the shared read-only copy.
 *
 * `selectedIds` is the per-project agent allow-list (already unioned with the
 * CORE trio by the caller). Only framework agents whose id is in it are linked —
 * the shared framework store is the full superset, so this is where per-project
 * filtering lands. `undefined` ⇒ link every framework agent (used by the legacy
 * callers / parity tests).
 *
 * When `preferCopy` is true each agent is COPIED as a real file rather than
 * symlinked (the in-repo standalone install — so a standalone user's CLI finds
 * real agent files in the repo, not links into `$HOME`).
 *
 * Returns the dominant mechanism used across the linked files (`copy` if any
 * file fell back to copy — the normal case on Windows without Developer Mode, or
 * always when `preferCopy` is set).
 */
function linkAgentFiles(
  frameworkAgentsDir: string,
  workspaceAgentsDir: string,
  selectedIds?: Set<string>,
  preferCopy = false,
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
    if (selectedIds && !selectedIds.has(id)) continue
    linkedNames.add(name)
    const m = symlinkOrCopy(src, path.join(workspaceAgentsDir, name), preferCopy)
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
 * Assemble Kimi skills without turning the whole directory into a symlink.
 * Kimi's loader inspects only immediate children of `.kimi-code/skills`, so
 * workflows (`specrails-*`), OpenSpec skills (`openspec-*`), managed roles
 * (`sr-*`), and user roles (`custom-*`) all share this flat directory.
 * OpenSpec and custom/unknown skills must survive every update.
 */
function linkKimiSkillDirectories(
  frameworkSkillsDir: string,
  workspaceSkillsDir: string,
  selectedRoleIds: Set<string>,
  preferCopy: boolean,
): 'symlink' | 'junction' | 'copy' {
  mkdirp(workspaceSkillsDir)
  const linkedFrameworkNames = new Set<string>()
  let mechanism: 'symlink' | 'junction' | 'copy' = 'symlink'

  for (const source of listDir(frameworkSkillsDir)) {
    if (!isDir(source)) continue
    const name = path.basename(source)
    if (name === 'rails') {
      // A same-version framework materialized by the experimental build may
      // still contain this container. `installFramework` normally rematerializes
      // it, but never expose nested roles if a caller supplies one directly.
      continue
    }
    if (/^sr-[a-z0-9-]+$/.test(name) && !selectedRoleIds.has(name)) {
      continue
    }
    linkedFrameworkNames.add(name)
    const used = symlinkOrCopy(source, path.join(workspaceSkillsDir, name), preferCopy)
    if (used === 'copy') mechanism = 'copy'
    else if (used === 'junction' && mechanism !== 'copy') mechanism = 'junction'
  }

  // `specrails-*` workflows and `sr-*` roles are framework-owned. OpenSpec,
  // custom-* and unknown/user skill directories remain outside this boundary.
  for (const existing of listDir(workspaceSkillsDir)) {
    const name = path.basename(existing)
    if (linkedFrameworkNames.has(name)) continue
    if (name.startsWith('specrails-') || /^sr-[a-z0-9-]+$/.test(name)) {
      removePath(existing)
    }
  }
  return mechanism
}

/**
 * Migrate the pre-release `skills/rails/<role>` layout without risking user
 * data. Framework-owned `sr-*` directories are dropped (the caller recreates
 * them at the discoverable flat path). Reserved `custom-*` roles are atomically
 * moved to `skills/custom-*` when that target is free. A collision or unknown
 * child remains byte-untouched under `rails/` and doctor reports it, requiring
 * explicit user resolution rather than destructive guessing.
 */
function migrateLegacyKimiRoleLayout(skillsDir: string): void {
  const legacyRolesDir = path.join(skillsDir, 'rails')
  if (!isDir(legacyRolesDir)) return

  for (const source of listDir(legacyRolesDir)) {
    if (!isDir(source)) continue
    const id = path.basename(source)
    if (/^sr-[a-z0-9-]+$/.test(id)) {
      removePath(source)
      continue
    }
    if (!id.startsWith('custom-')) continue

    const destination = path.join(skillsDir, id)
    if (pathExists(destination)) {
      warn(
        `Kimi role migration kept ${path.relative(skillsDir, source)} because ` +
          `${id}/ already exists; resolve the duplicate manually`,
      )
      continue
    }
    try {
      renameSync(source, destination)
      info(`Migrated Kimi role skills/rails/${id} → skills/${id}`)
    } catch (err) {
      warn(`failed to migrate Kimi role ${id}: ${(err as Error).message}`)
    }
  }

  if (listDir(legacyRolesDir).length === 0) removePath(legacyRolesDir)
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
 * Install Core's self-contained Kimi headless skill runner and the vendored
 * js-yaml parser used by upstream Kimi 0.27. These files are provider-static
 * and managed: updates replace them through the same framework copy/link
 * lifecycle as rules. They intentionally live outside `skills/` so Kimi never
 * attempts to discover executable support files as skills.
 */
function placeKimiSkillRunner(input: ScaffoldInput): number {
  for (const relative of KIMI_RUNNER_RELATIVE_FILES) {
    copyFile(
      path.join(
        input.scriptDir,
        'templates',
        'kimi',
        'specrails',
        relative,
      ),
      path.join(
        input.artifactRoot,
        input.providerDir,
        'specrails',
        relative,
      ),
    )
  }
  return KIMI_RUNNER_RELATIVE_FILES.length
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

  // Kimi's complete workflow catalog is rendered from the canonical
  // templates/commands/specrails sources in placeKimiSkills. Do not let this
  // generic bundled-command pass fall through to Claude's file layout.
  if (input.provider === 'kimi') return

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
      const skillName = name.replace(/\.md$/, '')
      const destDir = path.join(input.artifactRoot, input.providerDir, 'skills', skillName)
      // A codex-native override (written for spawn_agent semantics + the
      // correct `.codex/skills/rails/` layout) wins over the claude port.
      // This is the ONLY codex command-placement pass, so without the override
      // check codex users get the claude body with no codex-native semantics.
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

const KIMI_ROLE_EXECUTION_CONTRACT = [
  '## Kimi role execution contract',
  '',
  'These rules override later Claude-specific `role_skill`, `isolation`, and',
  '`run_in_background` notation. When this workflow asks for one role or a',
  'parallel group, submit exactly one foreground role wave. The managed helper',
  'starts one external Kimi CLI per role, runs the wave concurrently, attributes',
  'every output event, and waits for every required role. Never emulate a role',
  'in the orchestrator and never start concurrent helper commands.',
  '',
  'First use the structured WriteFile tool (never Shell, a heredoc, `printf`,',
  'or `echo`) to write `.specrails/kimi-role-wave.json`. Choose one lowercase',
  'letters/digits/hyphens run id (1–64 characters) and reuse it for the whole',
  'workflow. The file must have exactly this shape (1–32 roles):',
  '',
  '```json',
  '{',
  '  "run": "<stable-run-id>",',
  '  "roles": [',
  '    {',
  '      "key": "<unique-role-call-id>",',
  '      "skill": "<role-skill>",',
  '      "model": "<exact profile model or k3>",',
  '      "profile": "inherit",',
  '      "args": "<complete role context>",',
  '      "workspace": "current"',
  '    }',
  '  ]',
  '}',
  '```',
  '',
  'Every `key`, profile stem, and worktree id uses the same 1–64 character grammar as `run`.',
  'Use `"current"` for roles that target the orchestrator repository. The',
  'helper gives each such role a private execution directory while setting its',
  '`SPECRAILS_REPO_DIR` to that repository, so nested calls and run-state do not',
  'collide. Where later instructions request `isolation: worktree`, use',
  '`"worktree:<feature-id>"`; reuse that exact value for the developer, test,',
  'documentation, and other sequential roles belonging to the same feature.',
  'Never put two roles for the same worktree in one wave.',
  '',
  'Resolve each role model in the orchestrator and encode all context as JSON;',
  'set `profile` to `inherit`, or to a validated profile filename stem for a',
  'per-rail override under `.specrails/profiles/<stem>.json`. The helper passes',
  'that absolute profile path only to that child process.',
  'do not place any model or context text in a shell command. Then run this',
  'exact static command in the foreground:',
  '',
  '```sh',
  'node .kimi-code/specrails/run-skill.mjs \\',
  '  --role-wave-file .specrails/kimi-role-wave.json \\',
  '  --add-dir "${SPECRAILS_REPO_DIR:-.}"',
  '```',
  '',
  'The helper accepts only that fixed, regular, non-symlink one-shot file,',
  'bounds it to 1 MiB, validates the exact schema and every identifier, and',
  'deletes it before creating a worktree or process. For an isolated role it',
  'creates or reuses a detached git worktree from a synthetic baseline commit',
  'that snapshots the starting tracked and non-ignored untracked workspace,',
  'exposes the',
  'managed `.kimi-code`, and sets the child repository root to that worktree.',
  'It persists the base commit and key/path mapping under',
  '`.specrails/kimi-role-worktrees/<run>.json` and emits',
  '`specrails.role.workspace` frames. Replace every later',
  '`<worktree-path>` placeholder with that emitted `repoDir`; compare against',
  'the manifest `baseCommit`, not a hard-coded `main` ref.',
  '',
  'The helper frames child stdout/stderr with its role key, emits one completion',
  'frame per role, and exits nonzero after the whole wave if any role failed.',
  'A termination signal is forwarded to every live child. Partial failures',
  'leave completed worktrees and the manifest available for retry; newly',
  'created partial worktrees are removed only when setup itself fails. Apply',
  'the workflow cleanup step after merge using the exact static command',
  '`node .kimi-code/specrails/run-skill.mjs --role-wave-cleanup <run>`.',
  'Cleanup removes registered worktrees, execution state, the manifest, and',
  'the private synthetic-baseline ref; never clean up a failed run before retry.',
  'The helper normalizes only the three',
  'official short model ids (`k3` launches as `kimi-code/k3`); safe custom',
  'aliases pass through unchanged.',
  'There is no SpecRails-owned Kimi server or bundled Kimi binary.',
  '',
].join('\n')

const KIMI_NESTED_SKILL_CONTRACT = [
  '## Kimi nested skill activation',
  '',
  'When these instructions show `Skill(skill="<id>", args="<raw args>")`, call',
  'Kimi\'s built-in `Skill` tool with those `skill` and `args` fields. Do not',
  'print the notation as prose and do not send an interactive slash command as',
  'model text. This native tool path preserves Kimi\'s nested-skill behavior and',
  'skill activation telemetry.',
  '',
].join('\n')

const KIMI_RUNTIME_CONTEXT_CONTRACT = [
  '## Kimi runtime context contract',
  '',
  'SpecRails deliberately resolves project-specific context at activation time;',
  'the Kimi enrich workflow does not rewrite framework-owned role or workflow',
  'SKILL.md files. Resolve every `KIMI_RUNTIME_*`, `KIMI_BACKLOG_*`, and',
  '`KIMI_PR_CREATE` marker below before acting. These are semantic markers,',
  'never executable command names; do not pass them to Shell.',
  '',
  'Use `${SPECRAILS_REPO_DIR}` when set as the code repository, otherwise the',
  'current repository. Read `.kimi-code/project-context.md` for stack, layers,',
  'CI commands, conventions, warnings, architecture, and important paths; when',
  'a field is absent, inspect package/build/CI files and report the inferred',
  'value explicitly. Scan `.kimi-code/personas/*.md` at runtime and read only',
  'regular non-symlink files; derive persona names, roles, score columns, and',
  'VPC sections from that live inventory. An empty inventory means “no personas',
  'configured”, never fabricated rows or scores.',
  '',
  'For every `KIMI_BACKLOG_*` marker, first read and validate',
  '`.specrails/backlog-config.json`. Route `local` through structured reads and',
  'atomic writes of `.specrails/local-tickets.json`; route `github` through the',
  'approved `gh issue` operation; route `jira` only through the configured',
  'project/base URL and credentials. Honour read-only mode and never perform a',
  'write operation when configuration is missing, invalid, or read-only.',
  'Arguments shown after a marker describe the operation; they are not shell',
  'argv. Resolve `KIMI_PR_CREATE` with the repository’s configured PR workflow',
  'and ask before publishing when the active workflow requires confirmation.',
  '',
].join('\n')

const KIMI_RUNTIME_PLACEHOLDERS: Record<string, string> = {
  ARCHITECTURE_DIAGRAM: 'KIMI_RUNTIME_ARCHITECTURE_DIAGRAM',
  AREA_TABLE: 'KIMI_RUNTIME_AREA_TABLE',
  BACKEND_ARCHITECTURE_DIAGRAM: 'KIMI_RUNTIME_BACKEND_ARCHITECTURE_DIAGRAM',
  BACKEND_CRITICAL_RULES: 'KIMI_RUNTIME_BACKEND_CRITICAL_RULES',
  BACKEND_EXPERTISE: 'KIMI_RUNTIME_BACKEND_EXPERTISE',
  BACKEND_LAYER_CONVENTIONS: 'KIMI_RUNTIME_BACKEND_LAYER_CONVENTIONS',
  BACKEND_STACK: 'KIMI_RUNTIME_BACKEND_STACK',
  BACKEND_TECH_LIST: 'KIMI_RUNTIME_BACKEND_TECH_LIST',
  BACKLOG_COMMENT_CMD: 'KIMI_BACKLOG_COMMENT',
  BACKLOG_CREATE_CMD: 'KIMI_BACKLOG_CREATE',
  BACKLOG_DELETE_CMD: 'KIMI_BACKLOG_DELETE',
  BACKLOG_FETCH_ALL_CMD: 'KIMI_BACKLOG_FETCH_ALL',
  BACKLOG_FETCH_CLOSED_CMD: 'KIMI_BACKLOG_FETCH_CLOSED',
  BACKLOG_FETCH_CMD: 'KIMI_BACKLOG_FETCH',
  BACKLOG_INIT_LABELS_CMD: 'KIMI_BACKLOG_INIT_LABELS',
  BACKLOG_PARTIAL_COMMENT_CMD: 'KIMI_BACKLOG_PARTIAL_COMMENT',
  BACKLOG_PREFLIGHT: 'KIMI_BACKLOG_PREFLIGHT',
  BACKLOG_PROVIDER_NAME: 'KIMI_RUNTIME_BACKLOG_PROVIDER_NAME',
  BACKLOG_UPDATE_CMD: 'KIMI_BACKLOG_UPDATE',
  BACKLOG_VIEW_CMD: 'KIMI_BACKLOG_VIEW',
  CI_CHECK_TABLE_ROWS: 'KIMI_RUNTIME_CI_CHECK_TABLE_ROWS',
  CI_COMMANDS: 'KIMI_RUNTIME_CI_COMMANDS',
  CI_COMMANDS_BACKEND: 'KIMI_RUNTIME_CI_COMMANDS_BACKEND',
  CI_COMMANDS_FRONTEND: 'KIMI_RUNTIME_CI_COMMANDS_FRONTEND',
  CI_COMMANDS_FULL: 'KIMI_RUNTIME_CI_COMMANDS_FULL',
  CI_COMMON_PITFALLS: 'KIMI_RUNTIME_CI_COMMON_PITFALLS',
  CI_CRITICAL_WARNINGS: 'KIMI_RUNTIME_CI_CRITICAL_WARNINGS',
  CI_KNOWN_GAPS: 'KIMI_RUNTIME_CI_KNOWN_GAPS',
  CODE_QUALITY_CHECKLIST: 'KIMI_RUNTIME_CODE_QUALITY_CHECKLIST',
  CODE_QUALITY_STANDARDS: 'KIMI_RUNTIME_CODE_QUALITY_STANDARDS',
  COMPETITIVE_LANDSCAPE: 'KIMI_RUNTIME_COMPETITIVE_LANDSCAPE',
  DEPENDENCY_CHECK_COMMANDS: 'KIMI_RUNTIME_DEPENDENCY_CHECK_COMMANDS',
  DOMAIN_EXPERTISE: 'KIMI_RUNTIME_DOMAIN_EXPERTISE',
  DOMAIN_KNOWLEDGE: 'KIMI_RUNTIME_DOMAIN_KNOWLEDGE',
  FRONTEND_ARCHITECTURE_DIAGRAM: 'KIMI_RUNTIME_FRONTEND_ARCHITECTURE_DIAGRAM',
  FRONTEND_CRITICAL_RULES: 'KIMI_RUNTIME_FRONTEND_CRITICAL_RULES',
  FRONTEND_EXPERTISE: 'KIMI_RUNTIME_FRONTEND_EXPERTISE',
  FRONTEND_LAYER_CONVENTIONS: 'KIMI_RUNTIME_FRONTEND_LAYER_CONVENTIONS',
  FRONTEND_STACK: 'KIMI_RUNTIME_FRONTEND_STACK',
  FRONTEND_TECH_LIST: 'KIMI_RUNTIME_FRONTEND_TECH_LIST',
  GIT_ACCESS: 'KIMI_RUNTIME_GIT_ACCESS',
  JIRA_BASE_URL: 'KIMI_RUNTIME_JIRA_BASE_URL',
  JIRA_PROJECT_KEY: 'KIMI_RUNTIME_JIRA_PROJECT_KEY',
  KEY_FILE_PATHS: 'KIMI_RUNTIME_KEY_FILE_PATHS',
  LAYER_CLAUDE_MD_PATHS: 'KIMI_RUNTIME_LAYER_CONTEXT_PATHS',
  LAYER_CONVENTIONS: 'KIMI_RUNTIME_LAYER_CONVENTIONS',
  LAYER_LIST: 'KIMI_RUNTIME_LAYER_LIST',
  LAYER_NAME: 'KIMI_RUNTIME_LAYER_NAME',
  LAYER_PATH: 'KIMI_RUNTIME_LAYER_PATH',
  LAYER_TAGS: 'KIMI_RUNTIME_LAYER_TAGS',
  MAINTAINER_PERSONA_LINE: 'KIMI_RUNTIME_MAINTAINER_PERSONA_LINE',
  MAX_SCORE: 'KIMI_RUNTIME_PERSONA_MAX_SCORE',
  PERSONA_COUNT: 'KIMI_RUNTIME_PERSONA_COUNT',
  PERSONA_FILES: 'KIMI_RUNTIME_PERSONA_FILES',
  PERSONA_FILE_LIST: 'KIMI_RUNTIME_PERSONA_FILE_LIST',
  PERSONA_FILE_READ_LIST: 'KIMI_RUNTIME_PERSONA_FILE_READ_LIST',
  PERSONA_FIT_FORMAT: 'KIMI_RUNTIME_PERSONA_FIT_FORMAT',
  PERSONA_NAMES: 'KIMI_RUNTIME_PERSONA_NAMES',
  PERSONA_NAMES_WITH_ROLES: 'KIMI_RUNTIME_PERSONA_NAMES_WITH_ROLES',
  PERSONA_SCORE_FORMAT: 'KIMI_RUNTIME_PERSONA_SCORE_FORMAT',
  PERSONA_SCORE_HEADERS: 'KIMI_RUNTIME_PERSONA_SCORE_HEADERS',
  PERSONA_SCORE_SEPARATORS: 'KIMI_RUNTIME_PERSONA_SCORE_SEPARATORS',
  PERSONA_VPC_SECTIONS: 'KIMI_RUNTIME_PERSONA_VPC_SECTIONS',
  PR_CREATE_CMD: 'KIMI_PR_CREATE',
  PROJECT_CONTEXT: 'KIMI_RUNTIME_PROJECT_CONTEXT',
  TECH_EXPERTISE: 'KIMI_RUNTIME_TECH_EXPERTISE',
  TEST_QUALITY_CHECKLIST: 'KIMI_RUNTIME_TEST_QUALITY_CHECKLIST',
  TEST_RUNNER_CHECK: 'KIMI_RUNTIME_TEST_RUNNER_CHECK',
  WARNINGS: 'KIMI_RUNTIME_WARNINGS',
}

function writeKimiWorkflowSkill(args: {
  src: string
  dest: string
  commandName: string
  placeholders: Record<string, string>
}): void {
  if (!pathExists(args.src)) return
  const { body, description } = stripFrontmatter(readTextFile(args.src))
  const skillName = `specrails-${args.commandName}`
  const providerNeutral = renderPlaceholders(body, {
    ...KIMI_RUNTIME_PLACEHOLDERS,
    ...args.placeholders,
    MEMORY_PATH: '.kimi-code/agent-memory/',
  }).replaceAll(
    '.specrails/profiles/project-default.json',
    '.specrails/profiles/kimi-default.json',
  )
  const rendered = translateClaudeTextForKimi(
    adaptKimiWorkflowBody(args.commandName, providerNeutral),
  )
  const frontmatter = [
    '---',
    `name: ${skillName}`,
    `description: ${JSON.stringify(
      translateClaudeTextForKimi(
        renderPlaceholders(
          description ?? `SpecRails ${args.commandName} workflow for Kimi Code.`,
          {
            ...KIMI_RUNTIME_PLACEHOLDERS,
            ...args.placeholders,
          },
        ),
      ),
    )}`,
    'type: prompt',
    '---',
    '',
  ].join('\n')
  writeFileLf(
    args.dest,
    frontmatter +
      KIMI_NESTED_SKILL_CONTRACT +
      KIMI_ROLE_EXECUTION_CONTRACT +
      KIMI_RUNTIME_CONTEXT_CONTRACT +
      rendered,
  )
}

function adaptKimiWorkflowBody(commandName: string, body: string): string {
  if (commandName === 'batch-implement') {
    return adaptKimiBatchImplement(body)
  }
  if (commandName === 'auto-propose-backlog-specs') {
    return adaptKimiAutoPropose(body)
  }
  if (commandName === 'enrich') {
    return renderKimiEnrichWorkflow()
  }
  if (commandName === 'reconfig') {
    return renderKimiReconfigWorkflow()
  }
  if (commandName === 'telemetry') {
    return renderKimiTelemetryWorkflow()
  }
  if (commandName === 'retry') {
    return adaptKimiRetry(body)
  }
  if (commandName !== 'implement') return body
  let adapted = replaceMarkdownSection(
    body,
    '##### Apply per-agent model overrides (only when a profile declares them)',
    '##### Agent roles',
    [
      '##### Resolve per-role model overrides (profile mode only)',
      '',
      'Keep each `AGENT_MODEL[id]` value exactly as declared in the profile.',
      'Do **not** rewrite role `SKILL.md` frontmatter: Kimi directory skills do',
      'not carry per-role model configuration. In the orchestrator, resolve the',
      'role id against the parsed `AGENT_MODEL` map, then write the exact result',
      'into that role wave entry\'s JSON `model` field using WriteFile. Use',
      'the provider default `k3` when absent; never depend on a shell array from',
      'a previous tool call. Only the official short ids `k3`,',
      '`kimi-for-coding`, and `kimi-for-coding-highspeed` gain the',
      '`kimi-code/` prefix at the CLI boundary. Never map Claude aliases.',
      '',
    ].join('\n'),
  )
  adapted = replaceMarkdownSection(
    adapted,
    '#### Merge Algorithm',
    '**Step 4: Record outcomes**',
    [
      '#### Kimi role-wave merge algorithm',
      '',
      'The role-wave contract above overrides the generic runtime-supplied',
      'worktree assumptions. Use the stable run id chosen for this workflow.',
      'First run this command (the run id grammar is validated before git):',
      '',
      '```sh',
      'node .kimi-code/specrails/run-skill.mjs --role-wave-status <stable-run-id>',
      '```',
      '',
      'The single `specrails.merge.inventory` frame supplies `baseCommit`,',
      '`manifestPath`, and each safe worktree id, `repoDir`, and complete',
      '`changes` list. Every change is `{status:"A"|"M"|"D",path}`. This',
      'inventory compares against the synthetic baseline snapshot, includes',
      'committed/staged/unstaged and non-ignored untracked role output, and',
      'excludes `.kimi-code` plus SpecRails run-state. Never discover changed',
      'files with a shell loop, newline splitting, or a hard-coded `main` ref.',
      '',
      'Classify paths across all worktrees before applying anything:',
      '- `exclusive_files`: appears in one worktree only.',
      '- `shared_files`: appears in two or more worktrees.',
      '- Preserve each A/M/D status; a D path has no source file to copy.',
      '',
      '**Exclusive A/M/D actions**',
      '',
      'For each feature in `MERGE_ORDER`, use structured WriteFile (never shell',
      'interpolation) to write `.specrails/kimi-role-merge.json`:',
      '',
      '```json',
      '{',
      '  "run": "<stable-run-id>",',
      '  "actions": [',
      '    {"worktree":"<safe-id>","path":"<exact-git-path>","operation":"copy"},',
      '    {"worktree":"<safe-id>","path":"<deleted-path>","operation":"delete"}',
      '  ]',
      '}',
      '```',
      '',
      'Use `copy` for A/M and `delete` for D, then run exactly:',
      '',
      '```sh',
      'node .kimi-code/specrails/run-skill.mjs \\',
      '  --role-merge-file .specrails/kimi-role-merge.json',
      '```',
      '',
      'The helper validates the one-shot file, manifest, registered worktree,',
      'and path containment, then copies bytes/symlinks or deletes the target',
      'without a shell. Filenames may contain spaces, Unicode, quotes, `$()`,',
      'or leading dashes; never place them in a Bash command. It rejects',
      'provider/run-state paths, traversal, duplicate targets, directories,',
      'and symlinked target parents.',
      '',
      '**Shared paths**',
      '',
      'Process shared paths in `MERGE_ORDER`:',
      '1. D in every contributor: submit one validated `delete` action.',
      '2. D versus A/M: record a delete/modify conflict; do not silently copy',
      '   or delete it.',
      '3. A/M text: use structured ReadFile on each emitted `repoDir` + exact',
      '   path and on the current merge target. Apply the existing Markdown',
      '   section-aware strategy for `.md`; for other text perform a three-way',
      '   semantic merge against the current target, writing through WriteFile.',
      '4. Binary/type conflicts: record them for `sr-merge-resolver`; never',
      '   decode or round-trip binary data through model text.',
      '5. A resolved whole-file winner may be applied with one validated copy',
      '   action. Any unresolved region receives the existing conflict markers',
      '   and `MERGE_REPORT` entry.',
      '',
      'When `DRY_RUN=true`, do not invoke the repository merge-action helper.',
      'Write resolved A/M outputs under `CACHE_DIR` with structured WriteFile',
      'and record D paths as deletion operations in `.cache-manifest.json`.',
      'Keep worktrees for inspection as the surrounding dry-run rule requires.',
      '',
    ].join('\n'),
  )
  adapted = adapted
    .replace(
      '  "implemented_files": [],',
      [
        '  "implemented_files": [],',
        '  "kimi_role_wave": {',
        '    "run": "<stable-run-id>",',
        '    "manifest_path": ".specrails/kimi-role-worktrees/<stable-run-id>.json",',
        '    "base_commit": null,',
        '    "workspaces": {}',
        '  },',
      ].join('\n'),
    )
    .replace(
      'If the write succeeds: set `PIPELINE_STATE_AVAILABLE=true`.',
      [
        'If the write succeeds: set `PIPELINE_STATE_AVAILABLE=true`.',
        '',
        '**Kimi retry state:** after every `specrails.role.workspace` frame,',
        'atomically refresh `kimi_role_wave.manifest_path`, `base_commit`, and',
        '`workspaces[<feature-id>]` from the helper output. Never synthesize',
        'these values. Keep the same `run` and `worktree:<feature-id>` for that',
        'feature through developer, test, docs, and review. On any failure keep',
        'the manifest and worktrees. After every required change has been merged',
        'successfully, run the static cleanup command from the Kimi role',
        'contract and set `kimi_role_wave` to `null` in pipeline state.',
      ].join('\n'),
    )
    .replaceAll(
      'git -C <worktree-path> diff main --name-only',
      'git -C <worktree-path> diff <base-commit> --name-only',
    )
    .replaceAll(
      'git -C <worktree-path> diff main -- <file>',
      'git -C <worktree-path> diff <base-commit> -- <file>',
    )
    .replace(
      '(`<worktree-path>` is an absolute git-worktree path supplied by the runtime; `git -C <worktree-path>` already targets it directly.)',
      '(`<worktree-path>` is the `repoDir` emitted by the role-wave helper, and `<base-commit>` is read from its persisted manifest; `git -C <worktree-path>` already targets it directly.)',
    )
  return adapted
}

function adaptKimiBatchImplement(body: string): string {
  return replaceMarkdownSection(
    body,
    '### Wave invocation',
    '### Failure isolation',
    [
      '### Kimi wave invocation',
      '',
      'Nested `specrails-implement` executions are independent foreground Kimi',
      'processes. Do not call multiple built-in `Skill` tools in one Kimi',
      'session and do not share one checkout concurrently.',
      '',
      'Choose one safe `BATCH_RUN` id. For dependency wave `W`, derive the',
      'deterministic safe run id `<BATCH_RUN>-w<W>`. Process waves sequentially:',
      '',
      '1. For a normal repository launch, partition each dependency wave into',
      '   foreground batches of at most `min(CONCURRENCY,32)` entries. Each entry uses',
      '   `skill:"specrails-implement"`, `workspace:"worktree:<feature-id>"`,',
      '   the complete `<ref> [--dry-run]` arguments, the selected profile stem',
      '   (or `"inherit"`), and that profile\'s exact `orchestrator.model` (or',
      '   `k3`). Feature ids and keys must be collision-free safe ids.',
      '2. Wait for all completion frames. A failed entry fails only that ticket;',
      '   preserve its manifest/worktree for diagnosis and record the failure.',
      '3. Before a downstream dependency wave, call `--role-wave-status` for',
      '   the completed wave. Merge each successful worktree\'s A/M/D inventory',
      '   into the batch repository with the same structured merge-file and',
      '   shared-path rules defined by `specrails-implement`. Never interpolate',
      '   a filename into Shell. If merge succeeds, run',
      '   `node .kimi-code/specrails/run-skill.mjs --role-wave-cleanup <run>`.',
      '   This makes predecessor output part of the next wave\'s newly captured',
      '   synthetic baseline. Do not cleanup failed or unmerged worktrees.',
      '4. Record `{ref,wave,status,profile,error_summary,run,manifest_path,',
      '   workspace}` in `WAVE_RESULTS` before starting another batch.',
      '',
      'Inside a specrails-desktop isolated rail worktree, effective concurrency',
      'is exactly 1. Submit a one-entry foreground role wave per ticket with',
      '`workspace:"current"` and a deterministic unique run id; wait before the',
      'next ticket. No sibling worktree, status merge, or cleanup is needed',
      'because every nested implementation writes directly into the desktop',
      'rail\'s current repository.',
      '',
      'Per-ticket profiles remain isolated: `profile` is either `inherit` or the',
      'validated filename stem from `PROFILE_MAP`; `model` is resolved from the',
      'same profile before writing JSON. Never export a profile globally.',
      '',
    ].join('\n'),
  )
}

function adaptKimiAutoPropose(body: string): string {
  return body
    .replace(
      'Launch a **single** explorer subagent (`subagent_type: Explore`, `run_in_background: true`) for product discovery.',
      [
        'Launch one **sr-product-analyst** role in a foreground Kimi role wave.',
        'Use `skill:"sr-product-analyst"`, `workspace:"current"`,',
        '`profile:"inherit"`, and pass the complete discovery prompt below as',
        '`args`. Before writing the wave, enumerate regular non-symlink',
        '`.kimi-code/personas/*.md` files and include their exact paths plus',
        'contents in that context; stop with guidance to run',
        '`Skill(skill="specrails-enrich", args="")` when none exist. Wait for its attributed',
        'completion/output frames. Kimi has no Claude Explore subagent type;',
        'never select a non-existent Explore role.',
      ].join(' '),
    )
    .replaceAll('The Explore agent receives this prompt:', 'The sr-product-analyst role receives this prompt:')
    .replaceAll('After the Explore agent completes:', 'After the sr-product-analyst role completes:')
}

function adaptKimiRetry(body: string): string {
  return body
    .replace(
      '- `PHASE_STATUSES` ← `phases` map (`architect`, `developer`, `test-writer`, `doc-sync`, `reviewer`, `ship`, `ci` → `"done"`, `"failed"`, `"skipped"`, or `"pending"`)',
      [
        '- `PHASE_STATUSES` ← `phases` map (`architect`, `developer`, `test-writer`, `doc-sync`, `reviewer`, `ship`, `ci` → `"done"`, `"failed"`, `"skipped"`, or `"pending"`)',
        '- `KIMI_ROLE_WAVE` ← `kimi_role_wave` (required when an isolated Kimi',
        '  phase has already started): persisted `run`, `manifest_path`,',
        '  `base_commit`, and feature→workspace mapping.',
      ].join('\n'),
    )
    .replace(
      '**Validation:**',
      [
        '**Kimi workspace validation (before any phase):**',
        '',
        'If `KIMI_ROLE_WAVE` is non-null, validate its safe run id by invoking',
        '`node .kimi-code/specrails/run-skill.mjs --role-wave-status <run>`.',
        'The returned manifest path, base commit, and workspace ids must exactly',
        'match pipeline state. Any mismatch/missing/unregistered worktree is a',
        'hard stop: report recovery instructions and do not create a replacement',
        'worktree. A retry must use the same run and exact',
        '`worktree:<feature-id>` mapping so successful developer changes survive',
        'a later test/docs/reviewer failure. Refresh state from emitted frames',
        'after each resumed role. Never choose a new run while valid state',
        'exists; never cleanup before every required phase and merge succeeds.',
        '',
        '**Validation:**',
      ].join('\n'),
    )
    .replace(
      'Include PR URL if ship ran successfully.',
      [
        'Include PR URL if ship ran successfully.',
        '',
        'After all required isolated outputs have been safely merged, invoke the',
        'static `--role-wave-cleanup <run>` helper. Only after its cleanup frame',
        'succeeds set `kimi_role_wave` to `null`. A failed retry retains state.',
      ].join('\n'),
    )
}

function renderKimiEnrichWorkflow(): string {
  return [
    '# Enrich SpecRails for Kimi Code',
    '',
    'Refresh the Kimi-native SpecRails installation, analyze this repository,',
    'and maintain project context/personas without generating Claude artifacts.',
    'Kimi skills are managed provider artifacts; never rewrite their SKILL.md',
    'frontmatter or create Claude-style command/agent trees.',
    '',
    '## Mode selection',
    '',
    'Parse `$ARGUMENTS`: `--update`, `--quick`, and `--from-config` are mutually',
    'exclusive. With no flag run interactive full mode.',
    '',
    '1. Resolve the repository as `${SPECRAILS_REPO_DIR:-.}` and verify',
    '   `.kimi-code/specrails/run-skill.mjs` plus',
    '   `.specrails/install-config.yaml` exist.',
    '2. Read install config and require provider `kimi` (or an explicitly',
    '   provider-neutral legacy config). Refuse a different provider.',
    '3. Refresh managed provider artifacts with the installed Core CLI:',
    '   `npx specrails-core update --provider kimi --root-dir "${SPECRAILS_REPO_DIR:-.}"`.',
    '   Use the process result as a hard gate. This provider-aware materializer',
    '   regenerates direct-child workflows/roles, rules, runner, OpenSpec skills,',
    '   settings, manifest, and framework links. Do not reproduce its templates',
    '   with model-authored file copying.',
    '4. Validate `.specrails/profiles/kimi-default.json`: schemaVersion 1,',
    '   provider `kimi`, required architect/developer/reviewer, unique role ids,',
    '   safe model ids, and valid routing. Preserve exact model identifiers.',
    '',
    '## Quick mode',
    '',
    'Inspect package/build metadata and the top-level source tree. Atomically',
    'write `.kimi-code/project-context.md` with stack, architecture, test/lint/',
    'build commands, repository conventions, and the UTC refresh time. Preserve',
    'existing `.kimi-code/personas/`. Report that full mode can add VPC personas.',
    '',
    '## From-config mode',
    '',
    'Do not ask questions. Apply the tier, selected agents, backlog, git, and',
    'model choices already present in install config/profile; the Core update is',
    'the only artifact-generation authority. For quick tier run Quick mode. For',
    'full tier perform the same repository analysis as Full mode, retain existing',
    'personas when present, and generate conservative personas only when the',
    'config enables product roles and the persona directory is empty.',
    '',
    '## Update mode',
    '',
    'Run the provider-aware refresh, re-analyze commands/conventions, and',
    'atomically refresh only `.kimi-code/project-context.md`. Keep user personas,',
    'custom-* skills, agent memory, profiles, MCP configuration, and security',
    'exemptions byte-for-byte. Report stale/missing persona references but do not',
    'invent replacements.',
    '',
    '## Full mode',
    '',
    'Analyze the complete codebase and present findings. Ask concise questions',
    'about target users, pains, gains, product goals, and repository shipping',
    'policy. Research externally only with user-approved network tooling.',
    'Generate 2–4 Value Proposition Canvas personas as real Markdown files under',
    '`.kimi-code/personas/<safe-kebab-id>.md`; include jobs, pains, gains,',
    'behavior, success criteria, and evidence/assumptions. On OSS projects also',
    'materialize the bundled maintainer persona from setup templates. Never',
    'overwrite an existing persona without showing the proposed change.',
    '',
    'Refresh `.kimi-code/project-context.md` and ensure every selected product',
    'role has an agent-memory directory. Workflows discover persona files at',
    'runtime, so do not fork or mutate framework-owned skills to embed a static',
    'persona list.',
    '',
    '## Verification and report',
    '',
    'Run `npx specrails-core doctor --provider kimi --root-dir',
    '"${SPECRAILS_REPO_DIR:-.}"`. Verify every immediate skill directory has one',
    'valid SKILL.md, no role is nested under `skills/rails`, no unresolved',
    'template token remains, the Kimi profile validates, and no Claude model',
    'alias/path was generated. Report mode, provider version, context/persona',
    'files, selected roles, exact models, and doctor result.',
    '',
  ].join('\n')
}

function renderKimiReconfigWorkflow(): string {
  return [
    '# Reconfig: apply Kimi models to a provider profile',
    '',
    'Kimi role skills do not carry per-role model frontmatter. Reconfiguration',
    'updates a provider-bound profile; workflows read that profile and put each',
    'exact model id in the structured role wave.',
    '',
    '1. Parse `$ARGUMENTS` as optional `--profile <safe-name>`; default to the',
    '   active `SPECRAILS_PROFILE_PATH`, then',
    '   `.specrails/profiles/kimi-default.json`.',
    '2. Require a regular non-symlink JSON file inside `.specrails/profiles/`.',
    '   Validate it against profile schema v1, require `provider:"kimi"`, unique',
    '   agents, the baseline trio, valid routing references, and Kimi-safe model',
    '   ids (`^[A-Za-z0-9][A-Za-z0-9._/:-]*$`, maximum 128 characters).',
    '3. Read `.specrails/agents.yaml` only as an optional legacy input. Ask for',
    '   confirmation before migrating its defaults/per-agent model values. Claude',
    '   aliases `opus`, `sonnet`, and `haiku` are not Kimi models and must never',
    '   be translated silently; require an explicit Kimi replacement.',
    '4. Present the orchestrator and per-role old→new model table. Apply approved',
    '   edits to a complete in-memory profile object, validate again, then use',
    '   structured WriteFile for one atomic logical replacement. Preserve name,',
    '   description, required flags, agent order, and routing.',
    '5. Re-read and validate the result. Report changed/unchanged/skipped roles.',
    '',
    'Never edit any role SKILL.md under `.kimi-code/skills/`, never create Claude agent files,',
    'and never put a model id in a shell command.',
    '',
  ].join('\n')
}

function renderKimiTelemetryWorkflow(): string {
  return [
    '# Kimi agent telemetry',
    '',
    'Analyze real Kimi Code session usage for this repository. Accepted flags:',
    '`--period today|week|all` (default `week`), `--agent <id>`,',
    '`--format markdown|json`, and `--save`. Cost is not derivable from Kimi logs and must remain',
    '`null`/`unavailable`; never apply a Claude or invented rate card.',
    '',
    '## Discover and validate sessions',
    '',
    'Read `~/.kimi-code/session_index.jsonl` line by line. Ignore only a final',
    'truncated JSON line; warn on any other malformed line. Fold records by',
    '`sessionId`, keeping the latest valid entry and honoring an explicit latest',
    'deletion/tombstone record. A live entry provides `sessionId`, `sessionDir`,',
    'and `workDir`. Require safe scalar strings, match canonical `workDir` to',
    '`${SPECRAILS_REPO_DIR:-.}`, and require canonical `sessionDir` to remain',
    'inside `~/.kimi-code/sessions/`. Reject symlinks/path traversal and ignore',
    'missing or deleted session directories.',
    '',
    'For each accepted session, read its regular non-symlink `state.json` and',
    'validate its `workDir`, timestamps, and title. Then scan only regular',
    '`agents/*/wire.jsonl` files within that same session directory. Tolerate a',
    'truncated final line; count and warn on other malformed records.',
    '',
    '## Usage schema and attribution',
    '',
    'Consume only records with `type:"usage.record"` and a safe `model` plus',
    '`usage:{inputOther,output,inputCacheRead,inputCacheCreation}`. Treat absent',
    'numeric counters as zero; reject negative/non-finite values. Preserve',
    '`usageScope` and aggregate input-other, output, cache-read, cache-creation,',
    'and total tokens per model/session.',
    '',
    'Attribute an external role session by canonical workDir: first use its',
    '`.specrails-role-workspace.json` marker; otherwise match `repoDir` in valid',
    '`.specrails/kimi-role-worktrees/*.json` manifests. Attribute the top-level',
    'session to `orchestrator`; use `unknown` only when no verified mapping',
    'exists. Apply period and agent filters after attribution. Deduplicate by',
    'session id + agent wire path + record position.',
    '',
    'Duration comes only from validated state timestamps. The wire schema does',
    'not provide a trustworthy role success/failure outcome, so expose that',
    'metric as unavailable rather than inferring it from the last event.',
    '',
    '## Output',
    '',
    'Show session/run count, duration, exact models, and all four token counters',
    'per role plus totals and cache ratio. In JSON use',
    '`cost_usd:null`, `avg_cost_per_run_usd:null`, and',
    '`success_rate:null` with `unavailable_reason`. In Markdown print',
    '`Cost: unavailable (Kimi logs contain usage, not billing rates)`.',
    'Recommendations may discuss token/cache/runtime outliers only.',
    '',
    'With `--save`, write the same JSON object under',
    '`.kimi-code/telemetry/<UTC-date>-<period>.json` using structured WriteFile;',
    'never include prompt text, credentials, raw wire records, or paths outside',
    'the repository/session identifiers.',
    '',
  ].join('\n')
}

function replaceMarkdownSection(
  body: string,
  startHeading: string,
  endHeading: string,
  replacement: string,
): string {
  const start = body.indexOf(startHeading)
  if (start < 0) return body
  const end = body.indexOf(endHeading, start + startHeading.length)
  if (end < 0) return body
  return body.slice(0, start) + replacement + body.slice(end)
}

function writeKimiRoleSkill(args: {
  src: string
  dest: string
  roleId: string
  placeholders: Record<string, string>
}): void {
  if (!pathExists(args.src)) return
  const { body, description } = stripFrontmatter(readTextFile(args.src))
  const rendered = translateClaudeTextForKimi(
    renderPlaceholders(body, {
      ...KIMI_RUNTIME_PLACEHOLDERS,
      ...args.placeholders,
      MEMORY_PATH: `.kimi-code/agent-memory/${args.roleId}/`,
    }),
  )
  const frontmatter = [
    '---',
    `name: ${args.roleId}`,
    `description: ${JSON.stringify(
      translateClaudeTextForKimi(
        renderPlaceholders(
          description ?? `SpecRails ${args.roleId} role for Kimi Code.`,
          {
            ...KIMI_RUNTIME_PLACEHOLDERS,
            ...args.placeholders,
          },
        ),
      ),
    )}`,
    'type: prompt',
    '---',
    '',
  ].join('\n')
  writeFileLf(
    args.dest,
    frontmatter +
      KIMI_NESTED_SKILL_CONTRACT +
      KIMI_RUNTIME_CONTEXT_CONTRACT +
      rendered,
  )
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
  }
  const placedIds: string[] = []
  for (const src of listDir(agentsSrc)) {
    const name = path.basename(src)
    if (!name.endsWith('.md')) continue
    const agentId = name.slice(0, -3)
    // Superset materialization (installFramework) places EVERY agent; per-project
    // filtering happens at the workspace LINK step (linkAgentFiles).
    if (!input.materializeAllAgents && !selectedAgents.has(agentId)) continue
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

/**
 * Kimi keeps both its project instructions and MCP configuration under
 * `.kimi-code`. Existing user MCP configuration is never rewritten.
 */
function applyKimiSettings(input: ScaffoldInput): number {
  let written = 0
  const providerRoot = path.join(input.artifactRoot, input.providerDir)
  const agentsMdPath = path.join(providerRoot, 'AGENTS.md')
  const content = renderInitialKimiAgentsMd(input.codeRoot)
  if (!pathExists(agentsMdPath)) {
    writeFileLf(agentsMdPath, content)
    written++
  } else {
    const existing = readTextFile(agentsMdPath)
    const next = upsertAgentsMdManagedBlock(existing, extractManagedBlock(content))
    if (next !== existing) {
      writeFileLf(agentsMdPath, next)
      written++
    }
  }

  const mcpPath = path.join(providerRoot, 'mcp.json')
  if (!pathExists(mcpPath)) {
    writeFileLf(mcpPath, '{\n  "mcpServers": {}\n}\n')
    written++
  }
  return written
}

function renderInitialKimiAgentsMd(repoRoot: string): string {
  const projectName = path.basename(repoRoot)
  return [
    AGENTS_MD_START,
    '',
    `# ${projectName} — Kimi Code instructions`,
    '',
    'This project uses SpecRails skills under `.kimi-code/skills/`.',
    'Kimi discovers only direct child skill directories. Interactive TUI sessions',
    'invoke workflows as `/skill:specrails-<command>`. Headless prompt mode does',
    'not dispatch slash skills, so automation must invoke',
    '`.kimi-code/specrails/run-skill.mjs`. Role skills live at',
    '`.kimi-code/skills/<sr-*|custom-*>/SKILL.md` and are launched by workflows in',
    'separate helper-managed `kimi -p --output-format stream-json` processes.',
    '',
    '## Conventions',
    '',
    '- Read project source, `.git`, and `openspec/**` from',
    '  `${SPECRAILS_REPO_DIR:-.}`.',
    '- Read provider rules from `.kimi-code/rules/` and runtime memory from',
    '  `.kimi-code/agent-memory/`.',
    '- Preserve model ids from provider-aware profiles exactly. The Kimi CLI',
    '  accepts configured aliases; official short ids use the `kimi-code/`',
    '  prefix at launch (for example `kimi-code/k3`).',
    '- OpenSpec workflows are invoked as `/skill:openspec-*`.',
    '- Kimi is CLI-only: do not start a server, register a service, or copy',
    '  credentials into this project.',
    '',
    AGENTS_MD_END,
    '',
  ].join('\n')
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
  } else if (input.provider === 'kimi') {
    // Early experimental builds used a Claude-shaped commands/agents layout
    // inside `.kimi-code`. They also nested role skills one level too deep at
    // `skills/rails/*`, which Kimi never discovers. Migrate reserved custom
    // roles and prune only framework-owned nested roles before rendering the
    // canonical flat layout. MCP config, AGENTS.md and unknown user files stay
    // untouched.
    migrateLegacyKimiRoleLayout(
      path.join(input.artifactRoot, input.providerDir, 'skills'),
    )
    legacyPaths.push(path.join(input.artifactRoot, input.providerDir, 'commands'))
    legacyPaths.push(path.join(input.artifactRoot, input.providerDir, 'agents'))
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
 * Direct placement: copy agents / commands / rules from the
 * .specrails/setup-templates/ staging directory into the live
 * provider directory, substituting template placeholders. This is the
 * only placement path — there are no install tiers.
 *
 * Source is setup-templates/ (not scriptDir/templates/) so the pipeline
 * is: scriptDir/templates/ → setup-templates/ (earlier scaffold step)
 * → <providerDir>/ (this function). The intermediate hop lets downstream
 * consumers (specrails-desktop's deployTemplates, update flow) read from a
 * single canonical staging dir.
 */
function placeArtefacts(input: ScaffoldInput): QuickPlacement {
  // Codex projects: the `agents/` + `rules/` placement is
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

  if (input.provider === 'kimi') {
    const setupTemplates = path.join(input.artifactRoot, '.specrails', 'setup-templates')
    const rulesSrc = path.join(setupTemplates, 'rules')
    const rulesDest = path.join(input.artifactRoot, input.providerDir, 'rules')
    let rulesPlaced = 0
    if (isDir(rulesSrc)) {
      mkdirp(rulesDest)
      for (const src of listDir(rulesSrc)) {
        const name = path.basename(src)
        if (!name.endsWith('.md')) continue
        const rendered = translateClaudeTextForKimi(
          renderPlaceholders(readTextFile(src), {
            ...KIMI_RUNTIME_PLACEHOLDERS,
            PROJECT_NAME: path.basename(input.codeRoot),
            SECURITY_EXEMPTIONS_PATH: '.kimi-code/security-exemptions.yaml',
            PERSONA_DIR: '.kimi-code/personas/',
          }),
        )
        writeFileLf(path.join(rulesDest, name), rendered)
        rulesPlaced++
      }
    }
    return { agents: 0, commands: 0, rules: rulesPlaced, skippedAgents: 0 }
  }

  const setupTemplates = path.join(input.artifactRoot, '.specrails', 'setup-templates')
  // PROJECT_NAME is the real repo's basename, not the relocated workspace dir.
  const projectName = path.basename(input.codeRoot)
  const providerDirAbs = path.join(input.artifactRoot, input.providerDir)

  const placeholders = {
    PROJECT_NAME: projectName,
    SECURITY_EXEMPTIONS_PATH: `${input.providerDir}/security-exemptions.yaml`,
  }

  // --- Agents ---
  const agentsSrc = path.join(setupTemplates, 'agents')
  const agentsDest = path.join(providerDirAbs, 'agents')
  let agentsPlaced = 0
  const agentsSkipped = 0
  // The only shipped agents are the three core agents. A profile-driven
  // install may pass a selection; anything outside CORE_AGENTS has no template
  // to place, so the intersection is always the core trio (extension happens
  // via user-owned custom-*.md agents, never through the installer).
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

      const dest = path.join(agentsDest, name)
      const rendered = renderPlaceholders(readTextFile(src), {
        ...placeholders,
        MEMORY_PATH: `.claude/agent-memory/${agentId}/`,
      })
      writeFileLf(dest, rendered)
      agentsPlaced++

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
  const commandsSrc = path.join(setupTemplates, 'commands', 'specrails')
  const commandsDest = path.join(providerDirAbs, 'commands', 'specrails')
  let commandsPlaced = 0
  if (isDir(commandsSrc)) {
    mkdirp(commandsDest)
    for (const src of listDir(commandsSrc)) {
      const name = path.basename(src)
      if (!name.endsWith('.md')) continue

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
  // Written with a sentinel block so update passes can refresh the
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
// never drift from it.
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
  // Only the three CORE_AGENTS ship, so only their rail skills exist to place.
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

  if (input.provider === 'kimi') {
    const setupRoot = path.join(input.artifactRoot, '.specrails', 'setup-templates')
    const commandsSrc = path.join(setupRoot, 'commands', 'specrails')
    const agentsSrc = path.join(setupRoot, 'agents')
    const selectedAgents = input.selectedAgents
      ? new Set([...input.selectedAgents, ...CORE_AGENTS])
      : new Set([...CORE_AGENTS])
    const placedRoleIds = new Set<string>()
    const placeholders = {
      PROJECT_NAME: path.basename(input.codeRoot),
      SECURITY_EXEMPTIONS_PATH: '.kimi-code/security-exemptions.yaml',
      PERSONA_DIR: '.kimi-code/personas/',
    }

    if (isDir(agentsSrc)) {
      for (const src of listDir(agentsSrc)) {
        const name = path.basename(src)
        if (!name.endsWith('.md')) continue
        const roleId = name.slice(0, -3)
        if (!input.materializeAllAgents && !selectedAgents.has(roleId)) continue
        writeKimiRoleSkill({
          src,
          dest: path.join(destBase, roleId, 'SKILL.md'),
          roleId,
          placeholders,
        })
        placedRoleIds.add(roleId)
        result.placed++
        result.filesCopied++
        if (input.seedProjectDirs !== false) {
          mkdirp(path.join(input.artifactRoot, input.providerDir, 'agent-memory', roleId))
        }
      }
    }

    // v5 ships only the core trio; every bundled command's role dependencies
    // are always satisfied, so no command exclusion set is needed.
    const excludedCommands = new Set<string>()
    if (isDir(commandsSrc)) {
      for (const src of listDir(commandsSrc)) {
        const name = path.basename(src)
        if (!name.endsWith('.md') || name === 'setup.md') continue
        const commandName = name.slice(0, -3)
        if (excludedCommands.has(commandName)) continue
        writeKimiWorkflowSkill({
          src,
          dest: path.join(destBase, `specrails-${commandName}`, 'SKILL.md'),
          commandName,
          placeholders,
        })
        result.placed++
        result.filesCopied++
      }
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
