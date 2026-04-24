import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { InstallerError } from '../util/errors.js'
import { info, ok, step } from '../util/logger.js'
import { readTextFile, pathExists } from '../util/fs.js'

import {
  type Provider,
  type Tier,
  loadInstallConfig,
  resolveConfigPath,
} from '../phases/install-config.js'
import { buildManifest, writeManifestFiles } from '../phases/manifest.js'
import { checkPrerequisites } from '../phases/prereqs.js'
import { derivedPaths } from '../phases/provider-detect.js'
import { scaffoldInstallation } from '../phases/scaffold.js'

/**
 * `npx specrails-core init` entry point.
 *
 * Flags consumed (must remain in sync with ALLOWED_FLAGS in
 * bin/specrails-core.cjs until Phase 5):
 *   --root-dir <path>     Target repo (default: cwd)
 *   --yes / -y            Non-interactive; auto-init git + accept defaults
 *   --provider <claude>   Force provider (only `claude` accepted in v1)
 *   --from-config [<p>]   Read provider + tier from install-config.yaml
 *   --quick               Quick tier (direct template placement, skip enrich)
 *   --agent-teams         Enable Agent Teams commands (team-review, team-debug)
 */

export interface InitFlags {
  'root-dir'?: string | boolean
  yes?: boolean
  provider?: string | boolean
  'from-config'?: string | boolean
  quick?: boolean
  'agent-teams'?: boolean
  'hub-json'?: boolean
}

export interface InitResult {
  repoRoot: string
  provider: Provider
  tier: Tier
  agentTeams: boolean
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

  // --from-config: read provider + tier + agent_teams from yaml.
  const fromConfigFlag = flags['from-config']
  let providerHint: Provider | undefined
  let tierHint: Tier | undefined
  let agentTeamsHint = flags['agent-teams'] === true

  if (fromConfigFlag !== undefined) {
    const explicitPath = typeof fromConfigFlag === 'string' ? fromConfigFlag : undefined
    const resolved = resolveConfigPath(repoRoot, explicitPath)
    const config = loadInstallConfig(resolved)
    if (config) {
      providerHint = config.provider
      tierHint = config.tier
      if (config.agent_teams) agentTeamsHint = true
      info(`Loaded install config from ${resolved}`)
    } else {
      info(`install-config.yaml not found at ${resolved} — falling back to auto-detection`)
    }
  } else if (typeof flags.provider === 'string') {
    if (flags.provider === 'codex') {
      throw new InstallerError(
        'Codex (OpenAI) support is coming soon — currently being tested in our lab. ' +
          'Use --provider claude for now.',
        40,
      )
    }
    if (flags.provider !== 'claude') {
      throw new InstallerError(`--provider value must be 'claude', got: ${flags.provider}`, 40)
    }
    providerHint = 'claude'
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

  // ─── Phase 2 + 3 ──────────────────────────────────────────────────────
  step('Phase 2 & 3: Installing specrails artifacts')
  const { providerDir } = derivedPaths(prereqs.provider)
  scaffoldInstallation({
    scriptDir,
    repoRoot,
    provider: prereqs.provider,
    providerDir,
    agentTeams: agentTeamsHint,
    tier: tierHint ?? 'full',
  })

  // ─── Phase 3b — manifest ──────────────────────────────────────────────
  step('Phase 3b: Writing manifest')
  const manifest = buildManifest({ scriptDir, repoRoot, version })
  const { manifestPath, versionPath } = writeManifestFiles(repoRoot, manifest)
  ok(`Wrote ${path.relative(repoRoot, manifestPath)}`)
  ok(`Wrote ${path.relative(repoRoot, versionPath)}`)

  const tier: Tier = tierHint ?? 'full'
  if (tier === 'full') {
    step('Next steps')
    info('Run `/specrails:enrich` inside Claude Code to complete your setup.')
  } else {
    step('Installation complete')
    info('Quick tier: agents + rules were placed directly; enrich not required.')
  }
  // Terminal sentinel for programmatic consumers (specrails-hub's setup
  // wizard matches this exact line via regex to mark the "init complete"
  // checkpoint). Keep the spelling stable.
  ok('init complete')

  return {
    repoRoot,
    provider: prereqs.provider,
    tier,
    agentTeams: agentTeamsHint,
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
  const p = path.join(scriptDir, 'VERSION')
  if (!pathExists(p)) return 'unknown'
  try {
    return readTextFile(p).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}
