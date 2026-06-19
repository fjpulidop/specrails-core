import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { InstallerError } from '../util/errors.js'
import { ok, step } from '../util/logger.js'
import { pathExists, readTextFile } from '../util/fs.js'

import { type Provider } from '../phases/provider-detect.js'
import { derivedPaths } from '../phases/provider-detect.js'
import { assembleProjectWorkspace, ensureCurrentSymlink } from '../phases/scaffold.js'
import { ensureFramework } from './init.js'

/**
 * Offline framework subcommands consumed by specrails-desktop's bundled-core
 * path. They expose the already-built `ensureFramework` (installFramework +
 * ensureCurrentSymlink) and `assembleProjectWorkspace` as thin CLI handlers so
 * the desktop app can materialize + assemble WITHOUT npx or any network.
 *
 *   specrails-core install-framework --framework-dir <dir> --provider <p> --version <v>
 *   specrails-core assemble --workspace <ws> --framework-dir <dir> --provider <p> --version <v> --code-root <repo>
 *
 * Both are idempotent and perform NO network I/O and NO openspec init.
 */

export interface InstallFrameworkFlags {
  'framework-dir'?: string | boolean
  provider?: string | boolean
  version?: string | boolean
  /**
   * Materialize the provider subtree but do NOT swap `current`. The caller
   * materializes EVERY provider first (each with `--no-swap`), then issues ONE
   * `swap-current` so a later provider's failure never leaves `current` pointed
   * at a version dir missing that provider.
   */
  'no-swap'?: boolean
}

export interface SwapCurrentFlags {
  'framework-dir'?: string | boolean
  version?: string | boolean
}

export interface AssembleFlags {
  workspace?: string | boolean
  'framework-dir'?: string | boolean
  provider?: string | boolean
  version?: string | boolean
  'code-root'?: string | boolean
  /** Comma-separated per-project agent allow-list (links a subset of the superset). */
  'selected-agents'?: string | boolean
}

export interface InstallFrameworkOutcome {
  frameworkDir: string
  provider: Provider
  version: string
  providerDir: string
  /** True when `current` was swapped to `<version>` this call. */
  swapped: boolean
}

export interface SwapCurrentOutcome {
  frameworkDir: string
  version: string
}

export interface AssembleOutcome {
  workspace: string
  frameworkDir: string
  provider: Provider
  version: string
  codeRoot: string
  providerDir: string
}

function requireString(value: string | boolean | undefined, flagName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InstallerError(`--${flagName} is required`, 40)
  }
  return value
}

function parseProvider(value: string | boolean | undefined): Provider {
  const v = requireString(value, 'provider')
  if (v !== 'claude' && v !== 'codex' && v !== 'gemini') {
    throw new InstallerError(`--provider value must be 'claude', 'codex', or 'gemini', got: ${v}`, 40)
  }
  return v
}

/**
 * Resolves the specrails-core package root (where templates/ + commands/ live).
 *   - Published: `<pkg>/dist/installer/commands/framework.js`
 *   - Source:   `<repo>/src/installer/commands/framework.ts`
 * Both are three levels deep (commands → installer → src|dist → root). The
 * SPECRAILS_CORE_SCRIPT_DIR env var overrides for tests / desktop bundling.
 */
function resolveScriptDir(): string {
  const override = process.env.SPECRAILS_CORE_SCRIPT_DIR
  if (override && override.length > 0) return path.resolve(override)
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..')
}

/**
 * `specrails-core install-framework` — materialize the provider-invariant
 * framework subtree ONCE under `<framework-dir>/<version>/<providerDir>/` and
 * point `<framework-dir>/current` at it. Idempotent + offline.
 */
export async function runInstallFramework(
  flags: InstallFrameworkFlags,
): Promise<InstallFrameworkOutcome> {
  const scriptDir = resolveScriptDir()
  const frameworkDir = path.resolve(requireString(flags['framework-dir'], 'framework-dir'))
  const provider = parseProvider(flags.provider)
  const version = requireString(flags.version, 'version')
  const { providerDir } = derivedPaths(provider)

  const swapCurrent = flags['no-swap'] !== true
  step(`Materializing framework ${version} (${provider}) → ${frameworkDir}`)
  ensureFramework({
    scriptDir,
    frameworkDir,
    provider,
    providerDir,
    version,
    swapCurrent,
  })
  if (swapCurrent) {
    ok(`Framework ${version} ready (${providerDir}) + current → ${version}`)
  } else {
    ok(`Framework ${version} ready (${providerDir}) — current NOT swapped (--no-swap)`)
  }

  return { frameworkDir, provider, version, providerDir, swapped: swapCurrent }
}

/**
 * `specrails-core swap-current` — atomically point `<framework-dir>/current` at
 * `<version>`. The multi-provider "materialize-all-then-swap-once" finaliser:
 * after EVERY provider was materialized with `--no-swap`, this single call makes
 * the version visible. Idempotent + offline.
 */
export async function runSwapCurrent(flags: SwapCurrentFlags): Promise<SwapCurrentOutcome> {
  const frameworkDir = path.resolve(requireString(flags['framework-dir'], 'framework-dir'))
  const version = requireString(flags.version, 'version')
  step(`Swapping framework current → ${version} (${frameworkDir})`)
  ensureCurrentSymlink(frameworkDir, version)
  ok(`current → ${version}`)
  return { frameworkDir, version }
}

/**
 * `specrails-core assemble` — SYMLINK the materialized framework subtrees into a
 * project workspace and seed the per-project layer (agent-memory, manifest,
 * instruction/settings files, gemini acks). NO network, NO openspec init.
 */
export async function runAssemble(flags: AssembleFlags): Promise<AssembleOutcome> {
  const scriptDir = resolveScriptDir()
  const workspace = path.resolve(requireString(flags.workspace, 'workspace'))
  const frameworkDir = path.resolve(requireString(flags['framework-dir'], 'framework-dir'))
  const provider = parseProvider(flags.provider)
  const version = requireString(flags.version, 'version')
  const codeRoot = path.resolve(requireString(flags['code-root'], 'code-root'))
  const { providerDir } = derivedPaths(provider)

  // Defence-in-depth: the framework must be materialized + `current` pointed at
  // `<version>` BEFORE assemble can link from it. The desktop FrameworkManager
  // always calls install-framework first; this guard surfaces a clear error if
  // a caller skips it.
  const currentProviderDir = path.join(frameworkDir, 'current', providerDir)
  if (!pathExists(currentProviderDir)) {
    throw new InstallerError(
      `framework not materialized: ${currentProviderDir} is missing — run install-framework first`,
      41,
    )
  }

  const selectedAgentsFlag = flags['selected-agents']
  const selectedAgents =
    typeof selectedAgentsFlag === 'string' && selectedAgentsFlag.length > 0
      ? selectedAgentsFlag.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined

  step(`Assembling workspace ${workspace} ← framework ${version} (${provider})`)
  assembleProjectWorkspace({
    workspace,
    frameworkDir,
    provider,
    providerDir,
    version,
    codeRoot,
    scriptDir,
    selectedAgents,
  })
  ok(`Linked ${providerDir}/ from framework ${version} + seeded project layer`)

  return { workspace, frameworkDir, provider, version, codeRoot, providerDir }
}

/** Read the package version (the version the desktop should materialize). */
export function readPackageVersion(scriptDir?: string): string {
  const dir = scriptDir ?? resolveScriptDir()
  const p = path.join(dir, 'package.json')
  if (!pathExists(p)) return 'unknown'
  try {
    const pkg = JSON.parse(readTextFile(p)) as { version?: string }
    return pkg.version?.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}
