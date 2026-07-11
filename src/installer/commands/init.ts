import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { InstallerError } from '../util/errors.js'
import { runCommand } from '../util/exec.js'
import { info, ok, step, warn } from '../util/logger.js'
import { readTextFile, pathExists } from '../util/fs.js'

import {
  type Provider,
  loadInstallConfig,
  resolveConfigPath,
} from '../phases/install-config.js'
import { checkPrerequisites } from '../phases/prereqs.js'
import { derivedPaths } from '../phases/provider-detect.js'
import {
  CORE_AGENTS,
  assembleProjectWorkspace,
  ensureCurrentSymlink,
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
 *   --provider <claude>   Force provider (only `claude` accepted in v1)
 *   --from-config [<p>]   Read provider + agents from install-config.yaml
 *   --relocate            Relocate artifacts to the $HOME workspace (symlinked
 *                         from the bundled framework) instead of installing them
 *                         IN-REPO. Default is in-repo so a standalone user's
 *                         `claude`/`codex`/`gemini` finds the agents/commands in
 *                         their own repo. specrails-desktop pre-creates a registry
 *                         entry (so it always relocates regardless of this flag);
 *                         standalone users opt in with `--relocate` or
 *                         `SPECRAILS_RELOCATE=1`.
 */

export interface InitFlags {
  'root-dir'?: string | boolean
  yes?: boolean
  provider?: string | boolean
  'from-config'?: string | boolean
  relocate?: boolean
  'hub-json'?: boolean
}

export interface InitResult {
  repoRoot: string
  provider: Provider
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
  const autoYes = flags.yes === true
  const skipPrereqs = process.env.SPECRAILS_SKIP_PREREQS === '1'

  // --from-config: read provider + agents from yaml.
  const fromConfigFlag = flags['from-config']
  let providerHint: Provider | undefined
  let selectedAgentsHint: string[] | undefined

  if (fromConfigFlag !== undefined) {
    const explicitPath = typeof fromConfigFlag === 'string' ? fromConfigFlag : undefined
    const resolved = resolveConfigPath(repoRoot, explicitPath)
    const config = loadInstallConfig(resolved)
    if (config) {
      providerHint = config.provider
      selectedAgentsHint = config.agents.selected
      info(`Loaded install config from ${resolved}`)
      warnUnknownSelectedAgents(selectedAgentsHint)
    } else {
      info(`install-config.yaml not found at ${resolved} — falling back to auto-detection`)
    }
  } else if (typeof flags.provider === 'string') {
    if (flags.provider !== 'claude' && flags.provider !== 'codex' && flags.provider !== 'gemini') {
      throw new InstallerError(
        `--provider value must be 'claude', 'codex', or 'gemini', got: ${flags.provider}`,
        40,
      )
    }
    providerHint = flags.provider as Provider
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
  await installOpenSpecProject(codeRoot, prereqs.provider)

  step('Installation complete')
  info('Agents, commands, and rules were placed directly — no follow-up step required.')
  info('Extend the core trio (sr-architect, sr-developer, sr-reviewer) via profiles + custom-*.md agents.')
  // Terminal sentinel for programmatic consumers (specrails-desktop's setup
  // wizard matches this exact line via regex to mark the "init complete"
  // checkpoint). The sentinel line below is FROZEN — the downstream setup
  // wizard regex-matches it byte-for-byte; never change its spelling.
  ok('init complete')

  return {
    repoRoot,
    provider: prereqs.provider,
  }
}

/**
 * Warn (once per id) about `agents.selected` entries that have no shipped
 * template — typically a pre-v5 install-config.yaml still listing removed
 * agents. They are skipped at placement; the warning tells the user why and
 * points at the v5 extension path.
 */
export function warnUnknownSelectedAgents(selected: string[] | undefined): void {
  if (!selected) return
  for (const id of selected) {
    if (!CORE_AGENTS.has(id)) {
      warn(
        `install-config.yaml selects agent '${id}', which specrails-core no longer ships — ` +
          `skipping (removed in v5; use a .claude/agents/custom-*.md agent declared in a profile).`,
      )
    }
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
  installFramework({
    scriptDir: input.scriptDir,
    frameworkDir: input.frameworkDir,
    provider: input.provider,
    providerDir: input.providerDir,
    version: input.version,
    selectedAgents: input.selectedAgents,
  })
  if (input.swapCurrent !== false) {
    ensureCurrentSymlink(input.frameworkDir, input.version)
  }
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
  const initArgs = ['init', '--tools', provider, repoRoot]

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

async function installOpenSpecProject(repoRoot: string, provider: Provider): Promise<void> {
  if (process.env.SPECRAILS_SKIP_OPENSPEC_INIT === '1') {
    info('Skipping OpenSpec project init (SPECRAILS_SKIP_OPENSPEC_INIT=1)')
    return
  }

  const { bin, args } = buildOpenSpecInvocation(repoRoot, provider)

  step('Phase 3c: Installing OpenSpec')
  try {
    await runCommand(bin, args, {
      cwd: repoRoot,
      timeoutMs: 180000,
    })
    ok(`OpenSpec project files installed (${provider})`)
  } catch (err) {
    throw new InstallerError(
      `OpenSpec init failed: ${(err as Error).message}`,
      50,
    )
  }
}
