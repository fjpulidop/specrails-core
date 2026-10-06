import { createHash, randomUUID } from 'node:crypto'
import { constants, cpSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
      'sr:implement — Full OpenSpec lifecycle with specialized agents: architect designs, developer implements, reviewer validates. Use for implementing frozen specs or feature descriptions.',
  },
}

/**
 * Phase 2 + Phase 3 of init:
 *   - Detect prior installation state (.claude/.codex/openspec already present).
 *   - Create the directory skeleton.
 *   - Copy templates into `.specrails/setup-templates/` (the internal
 *     staging dir that placement copies from and `update` diffs against).
 *   - Ensure `.gitignore` excludes the runtime artefacts.
 *
 * Placement (`placeArtefacts`) then renders the staged command templates
 * directly into the user's live provider dir (`.claude/commands/specrails/`,
 * `.codex/skills/`, …) so the installer finishes in one pass — no follow-up
 * wizard required. Roles are never placed: the programmatic runtime defines
 * them (`src/agent-runtime/prompts.ts`).
 */

interface ScaffoldInput {
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
}

interface ScaffoldResult {
  existingSetup: boolean
  createdDirs: string[]
  copiedFiles: number
}

/**
 * Provider-static subtrees inside a providerDir that are SHARED via symlink from
 * the framework copy into each workspace. `agents/` is deliberately absent — Core
 * ships no role files, and `<provider>/agents/custom-*.md` is a reserved
 * user/Desktop region the installer never creates or links.
 *
 * The root instruction file (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`) and the codex
 * `config.toml` / gemini `settings.json` carry the project name / a deep-merge
 * with the user's file, so they are SEEDED per-workspace (not linked) by
 * `assembleProjectWorkspace`.
 */
const LINKED_PROVIDER_SUBTREES: Record<Provider, string[]> = {
  claude: ['commands', 'skills'],
  codex: ['skills'],
  gemini: ['commands'],
  // Kimi skills are linked one directory at a time so direct-child OpenSpec
  // skills and user-owned custom-* roles can coexist. The self-contained
  // headless runner and its vendored parser are Core-owned and linked as a
  // separate static subtree.
  kimi: ['specrails'],
}

const KIMI_RUNNER_RELATIVE_FILES = [
  'run-skill.mjs',
  path.join('vendor', 'js-yaml', 'js-yaml.mjs'),
  path.join('vendor', 'js-yaml', 'LICENSE'),
  path.join('vendor', 'js-yaml', 'NOTICE.md'),
] as const

/**
 * Returns true iff any of the provider directories already contains
 * content.
 */
export function detectExistingSetup(input: Pick<ScaffoldInput, 'artifactRoot' | 'codeRoot' | 'providerDir'>): boolean {
  const roots = [
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
  assertPipelineRuntimeSource(input.scriptDir)
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
    mk(path.join(input.artifactRoot, input.providerDir, 'skills'))
  } else if (input.provider === 'gemini') {
    // Gemini: TOML commands under .gemini/commands/specrails/ + OpenSpec
    // skills in the execution workspace.
    mk(path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails'))
    mk(path.join(input.artifactRoot, input.providerDir, 'skills'))
  } else if (input.provider === 'kimi') {
    mk(path.join(input.artifactRoot, input.providerDir, 'skills'))
    mk(path.join(input.artifactRoot, input.providerDir, 'specrails'))
  } else {
    mk(path.join(input.artifactRoot, input.providerDir, 'commands', 'specrails'))
    mk(path.join(input.artifactRoot, input.providerDir, 'skills'))
  }
  const setupTemplates = path.join(input.artifactRoot, '.specrails', 'setup-templates')
  mk(path.join(setupTemplates, 'commands'))
  mk(path.join(setupTemplates, 'skills'))
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
      gitignoreEntries.push('.kimi-code/agent-memory/')
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

  pruneLegacyArtifacts(input)
  copiedFiles += placePipelineRuntime(input)
  if (input.provider === 'kimi') {
    copiedFiles += placeKimiSkillRunner(input)
  }

  // --- Direct placement (the only path) ---
  {
    const placed = placeArtefacts({ ...input })
    copiedFiles += placed.commands
    info(`Placed ${placed.commands} command(s) directly into ${input.providerDir}/`)
  }

  // --- Skills placement ---
  // Claude: top-level `sr-*` skills are generated from their canonical
  // command bodies (single source of truth). Codex and Gemini: no extra
  // skills (they use the command ports). Kimi: workflow skills.
  // See placeSkills for the full per-provider contract.
  {
    const skills = placeSkills(input)
    copiedFiles += skills.filesCopied
    if (skills.placed > 0) info(`Placed ${skills.placed} skill(s) into ${input.providerDir}/skills/`)
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
// it; the per-workspace PROJECT layer (manifest, settings/instructions files)
// is seeded as real writable files.
// ───────────────────────────────────────────────────────────────────────────

interface InstallFrameworkInput {
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
}

interface InstallFrameworkResult {
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
      { label: 'pipeline-runtime', dir: path.join(scriptDir, 'dist', 'pipeline') },
      { label: 'installer-renderers', dir: path.join(scriptDir, 'dist', 'installer', 'phases') },
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
    { label: 'pipeline-runtime', dir: path.join(path.dirname(providerFrameworkDir), '.specrails', 'runtime') },
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
 * per-workspace state (no project-named instruction files) — those are seeded
 * by `assembleProjectWorkspace`.
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

  mkdirp(input.frameworkDir)
  const stageRoot = mkdtempSync(path.join(input.frameworkDir, '.materialize-'))
  const stagedVersionDir = path.join(stageRoot, input.version)
  const stagedProviderDir = path.join(stagedVersionDir, input.providerDir)
  const stagedStampPath = frameworkStampPath(stagedVersionDir, input.providerDir)
  try {
    // Preserve all sibling providers while rebuilding the requested provider.
    // The stage is new: JS traversal keeps these copies away from Node 22's
    // native Unicode directory-copy defect on Windows (nodejs/node#61878).
    //
    // INVARIANT: the framework store holds real files only. `cpSync` with
    // `verbatimSymlinks` does not copy a link, it RECREATES it via
    // `symlinkSync` without a type — a privileged operation on Windows that
    // throws EPERM on an ordinary account (this is what broke `init` in 5.1.0;
    // see `withInstallRollback`). If the store ever gains a link, this call has
    // to move to `snapshotTree`/`restoreTree` in `util/fs.ts`.
    if (isDir(versionDir)) cpSync(versionDir, stagedVersionDir, { recursive: true, dereference: false, verbatimSymlinks: true, filter: () => true, mode: constants.COPYFILE_FICLONE })
    else mkdirp(stagedVersionDir)
  // Framework provider trees are entirely Core-owned. Rebuilding from a clean
  // destination removes stale files as well as repairing corrupt/missing ones,
  // without touching sibling providers already materialized in this version.
  removePath(stagedProviderDir)
  removePath(stagedStampPath)

  // Reuse scaffoldInstallation's static-placement helpers by pointing
  // `artifactRoot` at the version dir. The `codeRoot` is irrelevant to the
  // STATIC subtree (the project-named instruction files are skipped below), so
  // we hand it the framework dir to satisfy the contract — and we DELETE any
  // project-named instruction file the settings helpers wrote.
  const staticInput: ScaffoldInput = {
    scriptDir: input.scriptDir,
    artifactRoot: stagedVersionDir,
    codeRoot: versionDir,
    provider: input.provider,
    providerDir: input.providerDir,
  }
  scaffoldInstallation(staticInput)

  // The settings helpers also emit a project-named root instruction file
  // (AGENTS.md/GEMINI.md/CLAUDE.md) + (for codex) config.toml / (gemini)
  // settings.json. The instruction file is per-project → strip it from the
  // shared copy; the settings file IS provider-invariant and stays as a
  // link target inside the providerDir.
  for (const f of ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md']) {
    rmSync(path.join(stagedVersionDir, f), { force: true })
  }
  // Kimi's instruction and MCP files are provider-local rather than root-local,
  // but both are project-specific and must be real files in each workspace.
  // In particular, linking mcp.json would let Desktop mutate the shared
  // framework and leak one project's MCP registry into every other project.
  if (input.provider === 'kimi') {
    rmSync(path.join(stagedProviderDir, 'AGENTS.md'), { force: true })
    rmSync(path.join(stagedProviderDir, 'mcp.json'), { force: true })
  }

  const frameworkStamp: FrameworkStamp = {
    schema: 1,
    version: input.version,
    provider: input.provider,
    source_hash: sourceHash,
    content_hash: frameworkContentHash(stagedProviderDir),
  }
  writeFileLf(stagedStampPath, `${JSON.stringify(frameworkStamp, null, 2)}\n`)
  // Keep the previous complete version outside the disposable staging root.
  // It remains available for manual recovery even after successful publication.
  const previous = path.join(input.frameworkDir, `.previous-${input.version}-${randomUUID()}`)
  const hadPrevious = pathExists(versionDir)
  if (hadPrevious) renameSync(versionDir, previous)
  try { renameSync(stagedVersionDir, versionDir) }
  catch (error) {
    if (hadPrevious) renameSync(previous, versionDir)
    throw error
  }
  return { providerFrameworkDir, versionDir, materialized: true }
  } finally {
    // This contains only newly generated candidate files, never the prior version.
    rmSync(stageRoot, { recursive: true, force: true })
  }
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

interface AssembleProjectWorkspaceInput {
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
  /** The user's real repo (drives PROJECT_NAME). */
  codeRoot: string
  /** specrails-core package dir (for the manifest hash sources). */
  scriptDir: string
  /**
   * When true, the static provider subtrees (`commands`/`skills`/`specrails`)
   * and the settings file are COPIED as real files from the framework store into
   * the workspace instead of SYMLINKED. Used by the in-repo standalone install
   * (`init`/`update` with `artifactRoot === codeRoot`) so the repo gets real,
   * committable files — a symlink into `$HOME/.specrails/framework` would be
   * invisible to a standalone user's `claude`/`codex`/`gemini`/`kimi` running in the
   * repo. The PROJECT layer (manifest, instruction files) is real either way. Defaults to false (relocated workspaces symlink — the desktop /
   * `--relocate` path).
   */
  copyStatics?: boolean
}

interface AssembleProjectWorkspaceResult {
  /** Per-linked-subtree mechanism, for diagnostics (copy-fallback loses O(1) swap). */
  links: Record<string, 'symlink' | 'junction' | 'copy'>
}

/**
 * Assemble a project workspace with NO network and NO re-materialization: (a)
 * prune the framework-owned `sr-*` role artifacts an older Core linked or
 * copied into the workspace, (b) SYMLINK the static providerDir subtrees from
 * `<frameworkDir>/current/<providerDir>/` into `<workspace>/<providerDir>/`,
 * then (c) seed the PROJECT layer as real writable files (the manifest,
 * project-named instruction/settings files). Reserved `custom-*` files are
 * never touched.
 */
export function assembleProjectWorkspace(
  input: AssembleProjectWorkspaceInput,
): AssembleProjectWorkspaceResult {
  const currentProviderDir = path.join(input.frameworkDir, 'current', input.providerDir)
  const workspaceProviderDir = path.join(input.workspace, input.providerDir)
  mkdirp(workspaceProviderDir)

  // (a) Drop the role artifacts an older Core placed. Runs for EVERY provider,
  // whether or not the framework still has the subtree, so an upgraded
  // workspace loses its stale `sr-*` links/copies while `custom-*` stays put.
  pruneStaleRoleArtifacts(workspaceProviderDir, input.provider)

  // (b) Link the static subtrees that exist in the framework copy. Every linked
  // subtree (`commands/`, `skills/`, `specrails/`) holds no user files and is
  // linked as a whole directory (cheapest, single inode). `agents/` is never
  // linked: Core ships no roles and the dir is a reserved user region.
  //
  // In-repo standalone install COPIES the static subtrees as real files; the
  // relocated (desktop / --relocate) path symlinks them. Defaults to symlink.
  const preferCopy = input.copyStatics === true

  const links: Record<string, 'symlink' | 'junction' | 'copy'> = {}
  for (const sub of LINKED_PROVIDER_SUBTREES[input.provider]) {
    const target = path.join(currentProviderDir, sub)
    if (!pathExists(target)) continue
    links[sub] = symlinkOrCopy(target, path.join(workspaceProviderDir, sub), preferCopy)
  }
  // Core no longer ships `rules/`; drop the dangling link an older version left.
  const retiredRules = path.join(workspaceProviderDir, 'rules')
  if (isSymlink(retiredRules) && !pathExists(path.join(currentProviderDir, 'rules'))) removePath(retiredRules)
  if (input.provider === 'kimi') {
    const kimiSkillsTarget = path.join(currentProviderDir, 'skills')
    const kimiSkillsDest = path.join(workspaceProviderDir, 'skills')
    migrateLegacyKimiRoleLayout(kimiSkillsDest)
    if (pathExists(kimiSkillsTarget)) {
      links.skills = linkKimiSkillDirectories(kimiSkillsTarget, kimiSkillsDest, preferCopy)
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

  const runtimeTarget = path.join(input.frameworkDir, 'current', '.specrails', 'runtime')
  if (pathExists(runtimeTarget)) {
    links.pipelineRuntime = symlinkOrCopy(runtimeTarget, path.join(input.workspace, '.specrails', 'runtime'), preferCopy)
  }

  // (c) Seed the PROJECT layer (real writable files).
  seedProjectLayer(input)

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

  return { links }
}

/**
 * Seed the per-workspace PROJECT layer: the project-named instruction file and,
 * for Kimi, the per-project MCP registry.
 */
function seedProjectLayer(input: AssembleProjectWorkspaceInput): void {
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
  } else if (input.provider === 'kimi') {
    seedInstructionFile(
      path.join(input.workspace, '.kimi-code', 'AGENTS.md'),
      renderInitialKimiAgentsMd(input.codeRoot),
    )
    seedKimiMcpFile(path.join(input.workspace, '.kimi-code', 'mcp.json'))
    if (input.workspace === input.codeRoot) {
      ensureGitignore(input.codeRoot, ['.kimi-code/agent-memory/', '.specrails/'])
    }
  }
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

/** Framework-owned role ids (`sr-<name>`); `custom-*` and anything else is user-owned. */
const FRAMEWORK_ROLE_ID = /^sr-[a-z0-9-]+$/

/**
 * Remove the role artifacts an older Core linked or copied into a workspace:
 *   - claude, gemini: `agents/sr-*.md` (symlink or copy-fallback regular file)
 *   - codex:          `skills/rails/sr-*` and the `rails/` container once empty
 *   - kimi:           `skills/sr-*`
 *
 * Keyed strictly by NAME, never by content: `custom-*` (the reserved
 * user/Desktop region) and any unknown name are left byte-untouched. A
 * subtree that is itself a symlink into the shared framework store is skipped —
 * the store is Core-owned and rebuilt by `installFramework`, so pruning through
 * the link would only reach into another version's files.
 */
export function pruneStaleRoleArtifacts(workspaceProviderDir: string, provider: Provider): void {
  const prune = (dir: string, isStale: (entry: string) => boolean): void => {
    if (!isDir(dir) || isSymlink(dir)) return
    for (const entry of listDir(dir)) {
      if (isStale(entry)) removePath(entry)
    }
  }
  if (provider === 'claude' || provider === 'gemini') {
    prune(path.join(workspaceProviderDir, 'agents'), (entry) => {
      const name = path.basename(entry)
      return name.endsWith('.md') && FRAMEWORK_ROLE_ID.test(name.slice(0, -3)) && !isDir(entry)
    })
    return
  }
  if (provider === 'codex') {
    const skills = path.join(workspaceProviderDir, 'skills')
    if (isSymlink(skills)) return
    const rails = path.join(skills, 'rails')
    prune(rails, (entry) => FRAMEWORK_ROLE_ID.test(path.basename(entry)))
    if (isDir(rails) && !isSymlink(rails) && listDir(rails).length === 0) removePath(rails)
    return
  }
  prune(path.join(workspaceProviderDir, 'skills'), (entry) => FRAMEWORK_ROLE_ID.test(path.basename(entry)))
}

/**
 * Assemble Kimi skills without turning the whole directory into a symlink.
 * Kimi's loader inspects only immediate children of `.kimi-code/skills`, so
 * workflows (`specrails-*`), OpenSpec skills (`openspec-*`) and user roles
 * (`custom-*`) all share this flat directory. Every framework skill is linked;
 * OpenSpec and custom/unknown skills must survive every update.
 */
function linkKimiSkillDirectories(
  frameworkSkillsDir: string,
  workspaceSkillsDir: string,
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
    linkedFrameworkNames.add(name)
    const used = symlinkOrCopy(source, path.join(workspaceSkillsDir, name), preferCopy)
    if (used === 'copy') mechanism = 'copy'
    else if (used === 'junction' && mechanism !== 'copy') mechanism = 'junction'
  }

  // `specrails-*` workflows are framework-owned, and `sr-*` roles were until
  // Core 6.3 — both are strays when not linked this pass. OpenSpec, custom-*
  // and unknown/user skill directories remain outside this boundary.
  for (const existing of listDir(workspaceSkillsDir)) {
    const name = path.basename(existing)
    if (linkedFrameworkNames.has(name)) continue
    if (name.startsWith('specrails-') || FRAMEWORK_ROLE_ID.test(name)) {
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
    if (FRAMEWORK_ROLE_ID.test(id)) {
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

function writeKimiWorkflowSkill(args: { src: string; dest: string; commandName: string; projectName: string }): void {
  if (!pathExists(args.src)) return
  const { body, description } = stripFrontmatter(readTextFile(args.src))
  const values = { PROJECT_NAME: args.projectName }
  const frontmatter = [
    '---',
    `name: specrails-${args.commandName}`,
    `description: ${JSON.stringify(translateClaudeTextForKimi(renderPlaceholders(description ?? `SpecRails ${args.commandName} workflow for Kimi Code.`, values)))}`,
    'type: prompt',
    '---',
    '',
  ].join('\n')
  writeFileLf(args.dest, frontmatter + translateClaudeTextForKimi(renderPlaceholders(body, values)))
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
 * `prompt` + `description` (no per-command tool/model keys). Keeps gemini's
 * native `/specrails:<name>` slash
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
    'invoke workflows as `/skill:specrails-<command>`; headless automation uses',
    '`.kimi-code/specrails/run-skill.mjs --skill <id>`. Inside a programmatic',
    'runtime role, follow the supplied OpenSpec tools and frozen scope instead;',
    'never start a nested implementation workflow.',
    '',
    '## Conventions',
    '',
    '- Read project source, `.git`, and `openspec/**` from',
    '  `${SPECRAILS_REPO_DIR:-.}`.',
    '- Preserve configured model ids exactly. The Kimi CLI',
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
  return renderInitialAgentsMd(repoRoot).replace(AGENTS_MD_END, 'Read provider rules from `.gemini/`.\n\n' + AGENTS_MD_END)
}

function assertPipelineRuntimeSource(scriptDir: string): void {
  const contractFile = path.join(scriptDir, 'integration-contract.json')
  if (!pathExists(contractFile)) return
  const contract = JSON.parse(readTextFile(contractFile)) as { execution?: { runtime?: string } }
  if (contract.execution?.runtime && !pathExists(path.join(scriptDir, 'dist', 'pipeline', 'pipeline-state.js'))) {
    throw new Error('Core declares a pipeline runtime but its compiled module is missing; rebuild or reinstall this Core package before refreshing providers')
  }
}

function placePipelineRuntime(input: Pick<ScaffoldInput, 'scriptDir' | 'artifactRoot' | 'provider'>): number {
  const source = path.join(input.scriptDir, 'dist', 'pipeline', 'pipeline-state.js')
  // Source-only fixture installations may not include a compiled runtime.
  if (!pathExists(source)) return 0
  const dest = path.join(input.artifactRoot, '.specrails', 'runtime')
  copyFile(source, path.join(dest, 'pipeline-state.mjs'))
  writeFileLf(path.join(dest, 'pipeline.mjs'),
    "import { runPipelineCli } from './pipeline-state.mjs'\n" +
    "process.exitCode = await runPipelineCli(process.argv.slice(2))\n")
  const runtime = path.join(input.scriptDir, 'dist', 'agent-runtime', 'cli.js')
  if (pathExists(runtime)) {
    writeFileLf(path.join(dest, 'agent-runtime.mjs'),
      `import { runRuntimeCommand } from ${JSON.stringify(pathToFileURL(runtime).href)}\n` +
      `import { parseArgs } from ${JSON.stringify(pathToFileURL(path.join(input.scriptDir, 'dist', 'shared', 'args.js')).href)}\n` +
      "const { subcommand, flags, positionals } = parseArgs(process.argv.slice(2))\n" +
      "try { process.exitCode = await runRuntimeCommand(flags, [subcommand, ...positionals].filter(Boolean)) } catch (error) { console.error(error.message); process.exitCode = 1 }\n")
    const configPath = path.join(input.artifactRoot, '.specrails', 'agent-runtime.json')
    if (!pathExists(configPath)) {
      const provider = input.provider
      writeFileLf(configPath, JSON.stringify({ schemaVersion: 1, enabled: true,
        providers: [{ id: provider, kind: 'cli', cli: provider }],
        agents: Object.fromEntries(['architect', 'developer', 'reviewer'].map(role => [role, { provider, maxTurns: 100 }])), verification: [],
      }, null, 2) + '\n')
    }
    return 3
  }
  return 2
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
    // OpenSpec and user skills survive updates; only retired setup commands are managed.
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
  commands: number
}

/**
 * Direct placement of the staged templates (`.specrails/setup-templates/`)
 * into the live provider directory. Claude receives slash commands; Codex
 * receives each command as a skill; Gemini receives TOML commands. Kimi
 * workflows are rendered as skills by `placeSkills`.
 */
function placeArtefacts(input: ScaffoldInput): QuickPlacement {
  const setupTemplates = path.join(input.artifactRoot, '.specrails', 'setup-templates')
  const commandsSrc = path.join(setupTemplates, 'commands', 'specrails')
  const providerDirAbs = path.join(input.artifactRoot, input.providerDir)
  const commandSources = isDir(commandsSrc) ? listDir(commandsSrc).filter((src) => src.endsWith('.md')) : []
  const commandName = (src: string): string => path.basename(src).slice(0, -3)

  if (input.provider === 'kimi') return { commands: 0 }

  if (input.provider === 'codex') {
    for (const src of commandSources) {
      writeCodexSkillFromCommand({ src, dest: path.join(providerDirAbs, 'skills', commandName(src), 'SKILL.md'), name: commandName(src) })
    }
    return { commands: commandSources.length }
  }

  if (input.provider === 'gemini') {
    for (const src of commandSources) {
      writeGeminiCommandFromCommand({ src, dest: path.join(providerDirAbs, 'commands', 'specrails', `${commandName(src)}.toml`) })
    }
    return { commands: commandSources.length }
  }

  // PROJECT_NAME is the real repo's basename, not the relocated workspace dir.
  const placeholders = { PROJECT_NAME: path.basename(input.codeRoot) }
  const commandsDest = path.join(providerDirAbs, 'commands', 'specrails')
  mkdirp(commandsDest)
  for (const src of commandSources) {
    writeFileLf(path.join(commandsDest, path.basename(src)), renderPlaceholders(readTextFile(src), placeholders))
  }
  return { commands: commandSources.length }
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
    'Implementation is coordinated by the Specrails programmatic agent runtime.',
    'Use the frozen scope and official OpenSpec workflow supplied for your role.',
    'Do not start another implement workflow inside a role.',
    '',
    '## Repository context',
    '',
    '- Read project README, CONTRIBUTING and relevant nested instructions.',
    '- Use package manifests and checked-in build wrappers for actual commands.',
    '- Read API contracts before changing consumers or generated code.',
    '- Keep edits within the admitted repositories; report permission blockers',
    '  with the affected repository and path instead of repeating the attempt.',
    '- Report incomplete tasks and their concrete reasons in the role result.',
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
// `subagent_type` calls have no codex equivalent).
//
// GEMINI: nothing beyond the TOML commands placed by `placeArtefacts`.
//
// KIMI: every workflow command is rendered as a `specrails-<command>` skill.
//
// No provider receives role files: roles are runtime-defined.
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

  if (input.provider === 'kimi') {
    const setupRoot = path.join(input.artifactRoot, '.specrails', 'setup-templates')
    const commandsSrc = path.join(setupRoot, 'commands', 'specrails')
    const projectName = path.basename(input.codeRoot)
    for (const src of isDir(commandsSrc) ? listDir(commandsSrc) : []) {
      const name = path.basename(src)
      if (!name.endsWith('.md')) continue
      const commandName = name.slice(0, -3)
      writeKimiWorkflowSkill({ src, dest: path.join(destBase, `specrails-${commandName}`, 'SKILL.md'), commandName, projectName })
      result.placed++
      result.filesCopied++
    }
  }

  return result
}

/**
 * Substitutes `{{KEY}}` tokens in the input text with the provided
 * values, then strips any remaining `{{UNKNOWN}}` tokens (replacing
 * them with the empty string).
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
