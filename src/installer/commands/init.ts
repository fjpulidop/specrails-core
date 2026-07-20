import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { InstallerError } from '../util/errors.js'
import { runCommand } from '../util/exec.js'
import { info, ok, step } from '../util/logger.js'
import {
  isDir,
  listDir,
  pathExists,
  readTextFile,
  removePath,
  writeFileLf,
} from '../util/fs.js'

import {
  type Provider,
  type Tier,
  loadInstallConfig,
  resolveConfigPath,
} from '../phases/install-config.js'
import { checkPrerequisites } from '../phases/prereqs.js'
import { derivedPaths } from '../phases/provider-detect.js'
import { materializeFrameworkVersion } from '../phases/framework-lifecycle.js'
import {
  assembleProjectWorkspace,
  installFramework,
} from '../phases/scaffold.js'
import { frameworkRoot, resolveArtifacts } from '../util/registry.js'

/**
 * `npx specrails-core init` entry point.
 *
 * Flags consumed (must remain in sync with ALLOWED_FLAGS in
 * bin/specrails-core.cjs until Phase 5):
 *   --root-dir <path>     Target repo (default: cwd)
 *   --yes / -y            Non-interactive; auto-init git + accept defaults
 *   --provider <name>     Force provider (claude, codex, gemini, or kimi)
 *   --from-config [<p>]   Read provider + tier from install-config.yaml
 *   --quick               Quick tier (direct template placement, skip enrich)
 *   --relocate            Relocate artifacts to the $HOME workspace (symlinked
 *                         from the bundled framework) instead of installing them
 *                         IN-REPO. Default is in-repo so a standalone user's
 *                         `claude`/`codex`/`gemini`/`kimi` finds its artifacts in
 *                         their own repo. specrails-desktop pre-creates a registry
 *                         entry (so it always relocates regardless of this flag);
 *                         standalone users opt in with `--relocate` or
 *                         `SPECRAILS_RELOCATE=1`.
 */

export interface InitFlags {
  'root-dir'?: string | boolean
  yes?: boolean
  y?: boolean
  provider?: string | boolean
  'from-config'?: string | boolean
  quick?: boolean
  relocate?: boolean
  'hub-json'?: boolean
}

export interface InitResult {
  repoRoot: string
  provider: Provider
  tier: Tier
}

/**
 * Entry called by cli.ts. Returns a {@link InitResult} on success;
 * throws a typed error (translated to an exit code by the outer CLI)
 * on failure.
 */
export async function runInit(flags: InitFlags): Promise<InitResult> {
  const scriptDir = resolveScriptDir()
  const version = readVersion(scriptDir)

  const repoRoot = path.resolve(
    typeof flags['root-dir'] === 'string' ? flags['root-dir'] : process.cwd(),
  )
  const autoYes = flags.yes === true || flags.y === true
  const skipPrereqs = process.env.SPECRAILS_SKIP_PREREQS === '1'

  // Validate an explicit provider before consulting --from-config. The TUI
  // intentionally re-enters init with BOTH flags; accepting that flow is safe
  // only when the generated config agrees with the original explicit choice.
  let explicitProvider: Provider | undefined
  if (flags.provider !== undefined) {
    if (
      typeof flags.provider !== 'string' ||
      (flags.provider !== 'claude' &&
        flags.provider !== 'codex' &&
        flags.provider !== 'gemini' &&
        flags.provider !== 'kimi')
    ) {
      throw new InstallerError(
        `--provider value must be 'claude', 'codex', 'gemini', or 'kimi', got: ${String(flags.provider)}`,
        40,
      )
    }
    explicitProvider = flags.provider
  }

  // --from-config: read provider + tier from yaml.
  const fromConfigFlag = flags['from-config']
  let providerHint: Provider | undefined = explicitProvider
  let tierHint: Tier | undefined
  let selectedAgentsHint: string[] | undefined

  if (fromConfigFlag !== undefined) {
    const explicitPath = typeof fromConfigFlag === 'string' ? fromConfigFlag : undefined
    const resolved = resolveConfigPath(repoRoot, explicitPath)
    const config = loadInstallConfig(resolved)
    if (config) {
      if (explicitProvider && explicitProvider !== config.provider) {
        throw new InstallerError(
          `--provider '${explicitProvider}' conflicts with provider '${config.provider}' in ${resolved}`,
          40,
        )
      }
      providerHint = config.provider
      tierHint = config.tier
      selectedAgentsHint = config.agents.selected
      info(`Loaded install config from ${resolved}`)
    } else {
      info(
        `install-config.yaml not found at ${resolved} — falling back to ${
          explicitProvider ? `explicit provider '${explicitProvider}'` : 'auto-detection'
        }`,
      )
    }
  }

  if (flags.quick === true) {
    tierHint = 'quick'
  }

  // ─── Phase 1 ──────────────────────────────────────────────────────────
  step('Phase 1: Checking prerequisites')
  const prereqs = await checkPrerequisites({
    repoRoot,
    autoYes,
    explicitProvider: providerHint,
    skipPrereqs,
  })

  // ─── Resolve where artifacts live: in-repo (default) vs relocated ─────
  // Standalone `init` installs IN-REPO by default so a user's CLI finds the
  // agents/commands in their own repo. Relocation (the $HOME workspace, with the
  // framework symlinked in) is opt-in via `--relocate` / `SPECRAILS_RELOCATE=1`,
  // and is what specrails-desktop drives (it pre-creates the registry entry, so
  // `allocate:false` still resolves an EXISTING relocated entry → relocated).
  //
  // `allocate:false` + no existing entry ⇒ legacy in-repo layout where
  // `artifactRoot === codeRoot === repoRoot`. `allocate:true` (relocate) allocates
  // a $HOME workspace entry. EVERY Specrails artifact lands under `artifactRoot`;
  // the ONLY in-repo writes are `openspec/**` (below) and git/worktree ops.
  const relocate = flags.relocate === true || process.env.SPECRAILS_RELOCATE === '1'
  const { artifactRoot, codeRoot } = resolveArtifacts(repoRoot, {
    allocate: relocate,
    allocator: 'core-standalone',
    home: process.env.SPECRAILS_REGISTRY_HOME,
    providers: [prereqs.provider],
    coreVersion: version,
  })
  // An existing Core-owned relocated entry is also the durable provider
  // inventory. Merge this install's provider without reallocating legacy
  // in-repo installs; Desktop-owned entries remain read-only in the resolver.
  if (artifactRoot !== codeRoot) {
    resolveArtifacts(repoRoot, {
      allocate: true,
      allocator: 'core-standalone',
      home: process.env.SPECRAILS_REGISTRY_HOME,
      providers: [prereqs.provider],
      coreVersion: version,
    })
  }
  // In-repo when the resolution did NOT relocate the artifacts out of the repo.
  const inRepo = artifactRoot === codeRoot

  // ─── Phase 2 + 3 ──────────────────────────────────────────────────────
  // Bundled-framework flow: materialize the provider-INVARIANT framework ONCE
  // under `<home>/.specrails/framework/<version>/<providerDir>/`, point `current`
  // at it, then SYMLINK that copy into the workspace and seed the project layer
  // (agent-memory, manifest, instruction files, gemini acks). The framework
  // source for standalone npx is the package's templates/+commands/ (scriptDir).
  step('Phase 2 & 3: Installing specrails artifacts')
  const { providerDir } = derivedPaths(prereqs.provider)
  const fwDir = frameworkRoot(process.env.SPECRAILS_REGISTRY_HOME)

  ensureFramework({
    scriptDir,
    frameworkDir: fwDir,
    provider: prereqs.provider,
    providerDir,
    version,
    selectedAgents: selectedAgentsHint,
  })

  assembleProjectWorkspace({
    workspace: artifactRoot,
    frameworkDir: fwDir,
    provider: prereqs.provider,
    providerDir,
    version,
    codeRoot,
    scriptDir,
    selectedAgents: selectedAgentsHint,
    // In-repo: COPY the framework statics as real, committable files. Relocated:
    // symlink from the framework store (O(1) update on a version swap).
    copyStatics: inRepo,
  })
  if (inRepo) {
    ok(`Copied ${providerDir}/ from framework ${version} into the repo + seeded project layer`)
  } else {
    ok(`Linked ${providerDir}/ from framework ${version} + seeded project layer`)
  }

  // openspec STAYS in the repo (codeRoot) — unchanged behaviour.
  await installOpenSpecProject(codeRoot, prereqs.provider, artifactRoot)

  const tier: Tier = tierHint ?? 'full'
  if (tier === 'full') {
    step('Next steps')
    const enrichCommand =
      prereqs.provider === 'kimi' ? '/skill:specrails-enrich' : '/specrails:enrich'
    info(`Run \`${enrichCommand}\` inside your selected provider to complete your setup.`)
  } else {
    step('Installation complete')
    info('Quick tier: agents + rules were placed directly; enrich not required.')
  }
  // Terminal sentinel for programmatic consumers (specrails-desktop's setup
  // wizard matches this exact line via regex to mark the "init complete"
  // checkpoint). The sentinel line below is FROZEN — the downstream setup
  // wizard regex-matches it byte-for-byte; never change its spelling.
  ok('init complete')

  return {
    repoRoot,
    provider: prereqs.provider,
    tier,
  }
}

export interface EnsureFrameworkInput {
  scriptDir: string
  frameworkDir: string
  provider: Provider
  providerDir: string
  version: string
  selectedAgents?: string[]
  /**
   * Additional providers that must remain available through the global
   * `framework/current` pointer after this version transition.
   */
  requiredProviders?: Provider[]
  /** Registry home override used while computing the global provider union. */
  registryHome?: string
  /**
   * When false, MATERIALIZE the provider subtree but do NOT swap
   * `<frameworkDir>/current` to point at `<version>`. The caller is responsible
   * for the single `ensureCurrentSymlink(frameworkDir, version)` swap AFTER all
   * providers have been materialized. This prevents a multi-provider install
   * from leaving `current` pointed at a version dir that is missing a provider
   * whose materialization later failed. Defaults to true (swap — the standalone
   * single-provider `init` path is byte-identical to before).
   */
  swapCurrent?: boolean
}

/**
 * Materialize the framework for `(version, provider)` if absent and (by default)
 * point `<frameworkDir>/current` at that version. Idempotent — `installFramework`
 * skips re-materialization when the providerDir already exists with a matching
 * stamp, so a second project (or a repeat init) reuses the SAME framework copy.
 * Shared by `runInit` and `runUpdate`.
 *
 * Pass `swapCurrent: false` to materialize WITHOUT swapping `current` — the
 * multi-provider "materialize-all-then-swap-once" pattern desktop consumes:
 *   for (const p of providers) ensureFramework({ ..., provider: p, swapCurrent: false })
 *   ensureCurrentSymlink(frameworkDir, version) // single atomic swap at the end
 */
export function ensureFramework(input: EnsureFrameworkInput): void {
  if (input.swapCurrent === false) {
    installFramework({
      scriptDir: input.scriptDir,
      frameworkDir: input.frameworkDir,
      provider: input.provider,
      providerDir: input.providerDir,
      version: input.version,
      selectedAgents: input.selectedAgents,
    })
    return
  }

  // `current` is global, not scoped to this project/provider. Carry forward the
  // requested provider, every globally registered provider, and every provider
  // represented by the old current version; materialize all without swapping,
  // validate the complete destination, then move the pointer exactly once.
  materializeFrameworkVersion({
    scriptDir: input.scriptDir,
    frameworkDir: input.frameworkDir,
    version: input.version,
    requested: [input.provider, ...(input.requiredProviders ?? [])],
    registryHome: input.registryHome,
  })
}

/**
 * Resolves the package root (where VERSION, templates/, commands/ live).
 *   - Published: `<pkg>/dist/installer/commands/init.js`
 *   - Source:   `<repo>/src/installer/commands/init.ts`
 * Both cases are three levels deep (commands → installer → src|dist → root).
 *
 * The SPECRAILS_CORE_SCRIPT_DIR env var is an override for tests that
 * need to inject a fake package directory.
 */
function resolveScriptDir(): string {
  const override = process.env.SPECRAILS_CORE_SCRIPT_DIR
  if (override && override.length > 0) return path.resolve(override)
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..')
}

function readVersion(scriptDir: string): string {
  // Single source of truth: package.json `version` (bumped by
  // release-please). scriptDir is the specrails-core package root.
  const p = path.join(scriptDir, 'package.json')
  if (!pathExists(p)) return 'unknown'
  try {
    const pkg = JSON.parse(readTextFile(p)) as { version?: string }
    return pkg.version?.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function readPinnedVersion(scriptDir: string, key: string, fallback: string): string {
  const p = path.join(scriptDir, 'pinned-versions.json')
  if (!pathExists(p)) return fallback
  try {
    const parsed = JSON.parse(readTextFile(p)) as Record<string, unknown>
    const value = parsed[key]
    return typeof value === 'string' && value.length > 0 ? value : fallback
  } catch {
    return fallback
  }
}

/**
 * Resolve the `{bin, args}` to invoke `openspec init` for a project, honouring
 * two optional env overrides (both default unset → `npx @fission-ai/openspec`):
 *
 *  - `SPECRAILS_OPENSPEC_BIN`  — path to the openspec CLI entry (a `.js` node
 *    script when bundled by the desktop app, OR a real executable in tests).
 *  - `SPECRAILS_OPENSPEC_NODE` — path to a node executable. Set ONLY by the
 *    desktop bundled-offline path: Tauri strips exec bits from bundled
 *    resources and the bundled openspec is a node CLI (not a runnable binary),
 *    so it must be invoked as `node <cli> init …` rather than executed directly.
 *
 * Three invocation forms:
 *  1. NODE + BIN set → `runCommand(node, [cli, 'init', '--tools', provider, repoRoot])`
 *     (bundled offline — Tauri-stripped node CLI).
 *  2. BIN set only   → `runCommand(cli, ['init', '--tools', provider, repoRoot])`
 *     (a real executable: legacy override / test fake binary on PATH).
 *  3. neither set    → `runCommand('npx', ['--yes', '-p', '@fission-ai/openspec@<pinned>', '--', 'openspec', 'init', …])`
 *     (default online path — users never need a global install).
 */
export function buildOpenSpecInvocation(
  repoRoot: string,
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
  pinnedVersion: string = readPinnedVersion(resolveScriptDir(), 'openspec', '1.4.1'),
): { bin: string; args: string[] } {
  const bin = env.SPECRAILS_OPENSPEC_BIN
  const node = env.SPECRAILS_OPENSPEC_NODE
  const initArgs =
    provider === 'kimi'
      ? ['init', '--tools', provider, '--profile', 'custom', repoRoot]
      : ['init', '--tools', provider, repoRoot]

  if (bin && node) {
    // Form 1: bundled offline — run the node CLI through the given node exe.
    return { bin: node, args: [bin, ...initArgs] }
  }
  if (bin) {
    // Form 2: a real executable (legacy override / test fixture).
    return { bin, args: initArgs }
  }
  // Form 3: default — npx so users never need a global install.
  return {
    bin: 'npx',
    args: [
      '--yes',
      '-p',
      `@fission-ai/openspec@${pinnedVersion}`,
      '--',
      'openspec',
      ...initArgs,
    ],
  }
}

export const KIMI_REQUIRED_OPENSPEC_SKILLS = [
  'openspec-propose',
  'openspec-explore',
  'openspec-new-change',
  'openspec-continue-change',
  'openspec-apply-change',
  'openspec-ff-change',
  'openspec-sync-specs',
  'openspec-archive-change',
  'openspec-bulk-archive-change',
  'openspec-verify-change',
  'openspec-onboard',
] as const

const OPENSPEC_ALL_WORKFLOWS = [
  'propose',
  'explore',
  'new',
  'continue',
  'apply',
  'ff',
  'sync',
  'archive',
  'bulk-archive',
  'verify',
  'onboard',
]

/**
 * Move only OpenSpec-owned Kimi workflow directories from either upstream
 * location into the artifact workspace. Every destination is copied to a
 * sibling temporary directory and renamed, so readers never observe a partial
 * skill. A distinct newly generated source refreshes the managed destination;
 * an in-place corrected destination is retained as-is.
 */
export function normalizeKimiOpenSpecSkills(repoRoot: string, artifactRoot: string): string[] {
  const canonicalRepoRoot = realpathSync(repoRoot)
  const canonicalArtifactRoot = ensureRealDirectoryPath(artifactRoot)
  const destinationRoot = ensureRealDirectoryPath(
    path.join(canonicalArtifactRoot, '.kimi-code', 'skills'),
  )
  const correctedSourceRoot = path.join(canonicalRepoRoot, '.kimi-code', 'skills')
  const legacySourceRoot = path.join(canonicalRepoRoot, '.kimi', 'skills')
  const correctedIsDestination =
    path.resolve(correctedSourceRoot) === path.resolve(destinationRoot)
  const installed: string[] = []
  const sources = new Map<string, string | null>()

  // Validate the full inventory before mutating either tree.
  for (const skillName of KIMI_REQUIRED_OPENSPEC_SKILLS) {
    const destination = path.join(destinationRoot, skillName)
    const correctedSource = path.join(correctedSourceRoot, skillName)
    const legacySource = path.join(legacySourceRoot, skillName)
    const sourceCandidate =
      !correctedIsDestination && pathExists(path.join(correctedSource, 'SKILL.md'))
        ? correctedSource
        : pathExists(path.join(legacySource, 'SKILL.md'))
          ? legacySource
          : null
    const source =
      sourceCandidate === null
        ? null
        : validateSafeSkillTree(sourceCandidate, skillName)
    sources.set(skillName, source)
    if (source) {
      validateReplaceableDestination(destination, skillName)
      continue
    }
    if (lstatExists(destination)) {
      validateSafeSkillTree(destination, skillName)
      continue
    }
    if (pathExists(destination)) {
      throw new InstallerError(
        `Kimi OpenSpec skill ${skillName} exists without SKILL.md; refusing to overwrite it`,
        50,
      )
    }
    throw new InstallerError(
      `OpenSpec did not generate required Kimi skill ${skillName}; ` +
        'retry `npx specrails-core update --provider kimi`',
      50,
    )
  }

  for (const skillName of KIMI_REQUIRED_OPENSPEC_SKILLS) {
    const destination = path.join(destinationRoot, skillName)
    const source = sources.get(skillName) ?? null

    if (source) {
      const temporary = mkdtempSync(
        path.join(destinationRoot, `.${skillName}.specrails-tmp-`),
      )
      const backupContainer = mkdtempSync(
        path.join(destinationRoot, `.${skillName}.specrails-backup-`),
      )
      const backup = path.join(backupContainer, 'previous')
      copyValidatedSkillTree(source, temporary)
      try {
        validateSafeSkillTree(temporary, skillName)
      } catch (error) {
        removePath(temporary)
        removePath(backupContainer)
        throw error
      }
      const hadDestination = lstatExists(destination)
      try {
        if (hadDestination) renameSync(destination, backup)
        renameSync(temporary, destination)
        removePath(backupContainer)
      } catch (err) {
        removePath(temporary)
        if (!lstatExists(destination) && lstatExists(backup)) {
          renameSync(backup, destination)
        }
        removePath(backupContainer)
        throw err
      }
    }
    installed.push(skillName)
  }

  // Remove only the generated, known workflow directories after every
  // destination has been validated. Unknown/user content keeps both trees.
  for (const skillName of KIMI_REQUIRED_OPENSPEC_SKILLS) {
    const legacy = path.join(legacySourceRoot, skillName)
    if (path.resolve(legacy) !== path.resolve(path.join(destinationRoot, skillName))) {
      removePath(legacy)
    }
    if (path.resolve(correctedSourceRoot) !== path.resolve(destinationRoot)) {
      removePath(path.join(correctedSourceRoot, skillName))
    }
  }
  removeDirectoryIfEmpty(legacySourceRoot)
  removeDirectoryIfEmpty(path.dirname(legacySourceRoot))
  if (path.resolve(correctedSourceRoot) !== path.resolve(destinationRoot)) {
    removeDirectoryIfEmpty(correctedSourceRoot)
    removeDirectoryIfEmpty(path.dirname(correctedSourceRoot))
  }
  return installed
}

function lstatExists(target: string): boolean {
  try {
    lstatSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * Create a directory tree without ever traversing a caller-controlled symlink.
 * Existing ancestor aliases (for example macOS `/var` → `/private/var`) are
 * canonicalized once; every newly appended component must then be a real dir.
 */
function ensureRealDirectoryPath(directory: string): string {
  const absolute = path.resolve(directory)
  const missing: string[] = []
  let anchor = absolute
  while (!lstatExists(anchor)) {
    const parent = path.dirname(anchor)
    if (parent === anchor) {
      throw new InstallerError(`cannot resolve directory root for ${absolute}`, 50)
    }
    missing.unshift(path.basename(anchor))
    anchor = parent
  }
  const anchorMetadata = lstatSync(anchor)
  if (
    !anchorMetadata.isDirectory() ||
    anchorMetadata.isSymbolicLink()
  ) {
    throw new InstallerError(
      `Kimi OpenSpec destination must be a real directory: ${absolute}`,
      50,
    )
  }
  let cursor = realpathSync(anchor)
  for (const component of missing) {
    cursor = path.join(cursor, component)
    if (!lstatExists(cursor)) mkdirSync(cursor, { mode: 0o700 })
    const metadata = lstatSync(cursor)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new InstallerError(
        `Kimi OpenSpec destination parent must not be a symlink: ${cursor}`,
        50,
      )
    }
  }
  return cursor
}

function validateReplaceableDestination(
  destination: string,
  skillName: string,
): void {
  if (!lstatExists(destination)) return
  const metadata = lstatSync(destination)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new InstallerError(
      `Kimi OpenSpec destination ${skillName} must be a real directory`,
      50,
    )
  }
}

function validateSafeSkillTree(source: string, skillName: string): string {
  let canonicalRoot: string
  try {
    const rootMetadata = lstatSync(source)
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error('skill root is not a real directory')
    }
    canonicalRoot = realpathSync(source)
  } catch (error) {
    throw new InstallerError(
      `unsafe Kimi OpenSpec skill ${skillName}: ${(error as Error).message}`,
      50,
    )
  }

  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const entry = path.join(directory, name)
      const metadata = lstatSync(entry)
      if (metadata.isSymbolicLink()) {
        throw new InstallerError(
          `unsafe Kimi OpenSpec skill ${skillName}: symlink ${entry}`,
          50,
        )
      }
      const relative = path.relative(canonicalRoot, realpathSync(entry))
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new InstallerError(
          `unsafe Kimi OpenSpec skill ${skillName}: path escapes source`,
          50,
        )
      }
      if (metadata.isDirectory()) {
        walk(entry)
      } else if (!metadata.isFile()) {
        throw new InstallerError(
          `unsafe Kimi OpenSpec skill ${skillName}: unsupported file type ${entry}`,
          50,
        )
      }
    }
  }
  walk(canonicalRoot)
  const skillFile = path.join(canonicalRoot, 'SKILL.md')
  if (!lstatExists(skillFile)) {
    throw new InstallerError(
      `generated Kimi skill ${skillName} is missing SKILL.md`,
      50,
    )
  }
  const skillMetadata = lstatSync(skillFile)
  if (!skillMetadata.isFile() || skillMetadata.isSymbolicLink()) {
    throw new InstallerError(
      `generated Kimi skill ${skillName} has unsafe SKILL.md`,
      50,
    )
  }
  return canonicalRoot
}

function copyValidatedSkillTree(source: string, destination: string): void {
  for (const name of readdirSync(source)) {
    const from = path.join(source, name)
    const to = path.join(destination, name)
    const metadata = lstatSync(from)
    if (metadata.isSymbolicLink()) {
      throw new InstallerError(`refusing to copy Kimi OpenSpec symlink ${from}`, 50)
    }
    if (metadata.isDirectory()) {
      mkdirSync(to, { mode: 0o700 })
      copyValidatedSkillTree(from, to)
    } else if (metadata.isFile()) {
      copyFileSync(from, to)
    } else {
      throw new InstallerError(
        `refusing to copy unsupported Kimi OpenSpec file ${from}`,
        50,
      )
    }
  }
}

function removeDirectoryIfEmpty(dir: string): void {
  if (isDir(dir) && listDir(dir).length === 0) removePath(dir)
}

export async function installOpenSpecProject(
  repoRoot: string,
  provider: Provider,
  artifactRoot: string = repoRoot,
): Promise<void> {
  if (process.env.SPECRAILS_SKIP_OPENSPEC_INIT === '1') {
    if (provider === 'kimi') {
      const generatedRoots = [
        path.join(repoRoot, '.kimi', 'skills'),
        path.join(repoRoot, '.kimi-code', 'skills'),
      ]
      const hasGeneratedOutput = generatedRoots.some((root) =>
        listDir(root).some(
          (entry) => isDir(entry) && path.basename(entry).startsWith('openspec-'),
        ),
      )
      if (hasGeneratedOutput) normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)
    }
    info('Skipping OpenSpec project init (SPECRAILS_SKIP_OPENSPEC_INIT=1)')
    return
  }

  const { bin, args } = buildOpenSpecInvocation(repoRoot, provider)
  let temporaryConfigHome: string | null = null
  let commandEnv: NodeJS.ProcessEnv | undefined
  if (provider === 'kimi') {
    temporaryConfigHome = mkdtempSync(path.join(os.tmpdir(), 'specrails-openspec-kimi-'))
    writeFileLf(
      path.join(temporaryConfigHome, 'openspec', 'config.json'),
      `${JSON.stringify(
        {
          profile: 'custom',
          delivery: 'skills',
          workflows: OPENSPEC_ALL_WORKFLOWS,
          featureFlags: {},
        },
        null,
        2,
      )}\n`,
    )
    commandEnv = { ...process.env, XDG_CONFIG_HOME: temporaryConfigHome }
  }

  step('Phase 3c: Installing OpenSpec')
  try {
    await runCommand(bin, args, {
      cwd: repoRoot,
      timeoutMs: 180000,
      env: commandEnv,
    })
    if (provider === 'kimi') {
      normalizeKimiOpenSpecSkills(repoRoot, artifactRoot)
    }
    ok(`OpenSpec project files installed (${provider})`)
  } catch (err) {
    throw new InstallerError(
      `OpenSpec init failed: ${(err as Error).message}`,
      50,
    )
  } finally {
    if (temporaryConfigHome) {
      rmSync(temporaryConfigHome, { recursive: true, force: true })
    }
  }
}
