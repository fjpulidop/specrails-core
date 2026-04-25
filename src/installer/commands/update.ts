import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { InstallerError, PrerequisiteError } from '../util/errors.js'
import { info, ok, step, warn } from '../util/logger.js'
import { copyDir, isDir, pathExists, readTextFile } from '../util/fs.js'

import { loadInstallConfig, resolveConfigPath, type Tier } from '../phases/install-config.js'
import { buildManifest, writeManifestFiles, type SpecrailsManifest } from '../phases/manifest.js'
import { derivedPaths, detectAvailability, resolveProvider, type Provider } from '../phases/provider-detect.js'
import { scaffoldInstallation } from '../phases/scaffold.js'

/**
 * Components recognised by the `--only <component>` flag. Mirrors the
 * retired bash installer's accepted values plus an explicit map of
 * what each one actually does in the Node port.
 */
export type OnlyComponent = 'all' | 'core' | 'rules' | 'agents' | 'web-manager'

const VALID_ONLY: ReadonlySet<string> = new Set([
  'all',
  'core',
  'rules',
  'agents',
  'web-manager',
])

/**
 * `npx specrails-core update` entry point.
 *
 * Re-runs the scaffolding layer so fresh templates overwrite the
 * bundled commands and .specrails/setup-templates/ content. Reserved
 * paths are respected by the shared isReservedPath gate inside
 * fs utilities and scaffolding; the update never touches the user's
 * profile JSON or custom-* agents.
 *
 * The retired update.sh computed a template-diff against the manifest
 * and regenerated only changed files. We ship a simpler, stricter
 * contract: always re-scaffold every specrails-managed artefact, then
 * rewrite the manifest. The outcome is identical for the common case
 * (upgrade bumps the core version → nearly every template changes)
 * and is far easier to reason about than a bespoke diff algorithm.
 */

export interface UpdateFlags {
  'root-dir'?: string | boolean
  only?: string | boolean
  'dry-run'?: boolean
  yes?: boolean
  'agent-teams'?: boolean
}

export interface UpdateResult {
  repoRoot: string
  previousVersion: string | null
  currentVersion: string
  provider: Provider
  dryRun: boolean
  /** Resolved scope of the update — what was actually re-applied. */
  scope: OnlyComponent
  /** Tier honored during this update (read from install-config.yaml when present). */
  tier: Tier
  /** Whether Agent Teams commands are kept on this update. */
  agentTeams: boolean
}

export async function runUpdate(flags: UpdateFlags): Promise<UpdateResult> {
  const scriptDir = resolveScriptDir()
  const currentVersion = readVersion(scriptDir)

  const repoRoot = path.resolve(
    typeof flags['root-dir'] === 'string' ? flags['root-dir'] : process.cwd(),
  )
  const dryRun = flags['dry-run'] === true

  // Read install-config.yaml so the user's original choices (tier,
  // agent_teams) survive the update. Flag overrides win when present;
  // missing config falls back to defaults (tier=full, agent_teams=false).
  const config = loadInstallConfig(resolveConfigPath(repoRoot))
  const tier: Tier = config?.tier ?? 'full'
  const agentTeams = flags['agent-teams'] === true || config?.agent_teams === true
  const selectedAgents = config?.agents.selected

  const marker = path.join(repoRoot, '.specrails', 'specrails-version')
  if (!pathExists(marker)) {
    throw new PrerequisiteError(
      `No existing specrails install detected at ${repoRoot}. Run \`npx specrails-core init\` first.`,
    )
  }
  const previousVersion = readExistingVersion(repoRoot)

  step('Update: resolving provider from existing install')
  const provider = await resolveExistingProvider(repoRoot)
  const { providerDir } = derivedPaths(provider)
  ok(`Detected provider: ${provider} (${providerDir})`)

  // ─── Resolve --only scope ────────────────────────────────────────
  const scope = resolveScope(flags.only)
  if (scope === 'web-manager') {
    warn(
      '--only=web-manager is deprecated. The standalone web-manager has been retired; ' +
        'specrails-hub is the supported dashboard. Skipping with no changes.',
    )
    return { repoRoot, previousVersion, currentVersion, provider, dryRun, scope, tier, agentTeams }
  }

  if (config) {
    info(`Honouring install-config.yaml: tier=${tier}, agent_teams=${agentTeams}`)
  }

  if (dryRun) {
    info(
      `Dry run: would update [${scope}, tier=${tier}, agent_teams=${agentTeams}] ` +
        `for ${previousVersion ?? '(unknown)'} → ${currentVersion}.`,
    )
    return { repoRoot, previousVersion, currentVersion, provider, dryRun, scope, tier, agentTeams }
  }

  step(`Update: refreshing scaffold [scope=${scope}] (${previousVersion ?? '?'} → ${currentVersion})`)

  if (scope === 'all' || scope === 'core') {
    scaffoldInstallation({
      scriptDir,
      repoRoot,
      provider,
      providerDir,
      agentTeams,
      selectedAgents,
      // tier read from install-config.yaml above. If the user installed
      // with --quick, we re-apply the quick-tier direct placement
      // (agents + commands into <providerDir> with placeholder substitution
      // and VPC exclusion) instead of leaving the live agents/ stale.
      tier,
    })
  } else if (scope === 'rules') {
    rescaffoldComponent('rules', { scriptDir, repoRoot })
  } else if (scope === 'agents') {
    rescaffoldComponent('agents', { scriptDir, repoRoot })
  }

  step('Update: rewriting manifest')
  const manifest: SpecrailsManifest = buildManifest({
    scriptDir,
    repoRoot,
    version: currentVersion,
  })
  const { manifestPath, versionPath } = writeManifestFiles(repoRoot, manifest)
  ok(`Wrote ${path.relative(repoRoot, manifestPath)}`)
  ok(`Wrote ${path.relative(repoRoot, versionPath)}`)

  step('Update complete')
  info(`specrails-core ${previousVersion ?? '?'} → ${currentVersion}`)
  // Terminal sentinel for programmatic consumers (see comment in init.ts).
  ok('update complete')
  return { repoRoot, previousVersion, currentVersion, provider, dryRun: false, scope, tier, agentTeams }
}

/**
 * Re-applies a single subtree (rules or agents) from the bundled
 * templates into both the staging dir (.specrails/setup-templates/)
 * and the live provider directory if it already exists. Skips the
 * enrich placeholders + agent-memory bootstrap that scaffoldInstallation
 * does — those should only run on a true (re-)install.
 */
function rescaffoldComponent(
  component: 'rules' | 'agents',
  args: { scriptDir: string; repoRoot: string },
): void {
  const src = path.join(args.scriptDir, 'templates', component)
  if (!isDir(src)) {
    warn(`templates/${component} not found at ${src} — nothing to update`)
    return
  }
  const stagingDest = path.join(args.repoRoot, '.specrails', 'setup-templates', component)
  copyDir(src, stagingDest, {
    filter: (_s, rel) => !rel.includes('node_modules') && !rel.endsWith('package-lock.json'),
  })
  ok(`Refreshed .specrails/setup-templates/${component}/`)
}

function resolveScope(only: string | boolean | undefined): OnlyComponent {
  if (only === undefined) return 'all'
  if (only === true) {
    warn('--only requires a value (one of: all, core, rules, agents, web-manager) — defaulting to "all"')
    return 'all'
  }
  if (typeof only !== 'string') return 'all'
  const normalised = only.toLowerCase()
  if (!VALID_ONLY.has(normalised)) {
    warn(`--only=${only} is not recognised; defaulting to "all"`)
    return 'all'
  }
  return normalised as OnlyComponent
}

async function resolveExistingProvider(repoRoot: string): Promise<Provider> {
  if (pathExists(path.join(repoRoot, '.claude'))) return 'claude'
  if (pathExists(path.join(repoRoot, '.codex'))) return 'codex'
  // Neither present — fall back to resolving via CLI availability.
  const avail = await detectAvailability()
  try {
    return await resolveProvider(avail, { skipPrereqs: true })
  } catch (err) {
    if (err instanceof InstallerError) throw err
    throw new InstallerError(
      `could not determine provider of existing install at ${repoRoot}`,
      40,
    )
  }
}

function readExistingVersion(repoRoot: string): string | null {
  const p = path.join(repoRoot, '.specrails', 'specrails-version')
  if (!pathExists(p)) return null
  try {
    return readTextFile(p).trim() || null
  } catch {
    return null
  }
}

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
