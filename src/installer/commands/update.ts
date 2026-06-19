import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { InstallerError, PrerequisiteError } from '../util/errors.js'
import { info, ok, step, warn } from '../util/logger.js'
import { copyDir, isDir, pathExists, readTextFile } from '../util/fs.js'

import { loadInstallConfig, resolveConfigPath, type Tier } from '../phases/install-config.js'
import { buildManifest, writeManifestFiles, type SpecrailsManifest } from '../phases/manifest.js'
import { derivedPaths, detectAvailability, resolveProvider, type Provider } from '../phases/provider-detect.js'
import { assembleProjectWorkspace } from '../phases/scaffold.js'
import { frameworkRoot, resolveArtifacts } from '../util/registry.js'

import { ensureFramework } from './init.js'

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
  // ─── Relocate-always: resolve where artifacts live ───────────────────
  // All Specrails artifacts (incl. the specrails-version marker, manifest,
  // install-config) live under `artifactRoot` (the $HOME workspace), never the
  // repo. On update the registry entry already exists (created by init), so the
  // `providers` hint is ignored; we resolve first, then read the install.
  const { artifactRoot, codeRoot } = resolveArtifacts(repoRoot, {
    allocate: true,
    allocator: 'core-standalone',
    home: process.env.SPECRAILS_REGISTRY_HOME,
    coreVersion: currentVersion,
  })

  // install-config.yaml is a USER-authored file that lives in the repo (the user
  // can't know the relocated workspace path), so it is read from repoRoot — NOT
  // the artifactRoot. Falls back to a workspace copy if present (none today).
  const config =
    loadInstallConfig(resolveConfigPath(repoRoot)) ?? loadInstallConfig(resolveConfigPath(artifactRoot))
  const tier: Tier = config?.tier ?? 'full'
  const agentTeams = flags['agent-teams'] === true || config?.agent_teams === true
  const selectedAgents = config?.agents.selected

  const marker = path.join(artifactRoot, '.specrails', 'specrails-version')
  if (!pathExists(marker)) {
    throw new PrerequisiteError(
      `No existing specrails install detected at ${repoRoot}. Run \`npx specrails-core init\` first.`,
    )
  }
  const previousVersion = readExistingVersion(artifactRoot)

  step('Update: resolving provider from existing install')
  const provider = await resolveExistingProvider(artifactRoot)
  const { providerDir } = derivedPaths(provider)
  ok(`Detected provider: ${provider} (${providerDir})`)

  // ─── Resolve --only scope ────────────────────────────────────────
  const scope = resolveScope(flags.only)
  if (scope === 'web-manager') {
    warn(
      '--only=web-manager is deprecated. The standalone web-manager has been retired; ' +
        'specrails-desktop is the supported dashboard. Skipping with no changes.',
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
    // Bundled-framework update: re-materialize the framework to the (possibly
    // new) version dir, atomically swap `current`, then RE-ASSEMBLE the
    // workspace (re-link the static subtrees at the new `current` + re-seed the
    // project layer). `assembleProjectWorkspace` rewrites the manifest itself.
    const fwDir = frameworkRoot(process.env.SPECRAILS_REGISTRY_HOME)
    ensureFramework({
      scriptDir,
      frameworkDir: fwDir,
      provider,
      providerDir,
      version: currentVersion,
      agentTeams,
      selectedAgents,
    })
    assembleProjectWorkspace({
      workspace: artifactRoot,
      frameworkDir: fwDir,
      provider,
      providerDir,
      version: currentVersion,
      codeRoot,
      scriptDir,
      selectedAgents,
      agentTeams,
    })
    ok(`Re-linked ${providerDir}/ at framework ${currentVersion} + rewrote manifest`)
  } else if (scope === 'rules' || scope === 'agents') {
    rescaffoldComponent(scope, { scriptDir, artifactRoot })

    step('Update: rewriting manifest')
    const manifest: SpecrailsManifest = buildManifest({
      scriptDir,
      repoRoot: artifactRoot,
      version: currentVersion,
    })
    const { manifestPath, versionPath } = writeManifestFiles(artifactRoot, manifest)
    ok(`Wrote ${path.relative(artifactRoot, manifestPath)}`)
    ok(`Wrote ${path.relative(artifactRoot, versionPath)}`)
  }

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
  args: { scriptDir: string; artifactRoot: string },
): void {
  const src = path.join(args.scriptDir, 'templates', component)
  if (!isDir(src)) {
    warn(`templates/${component} not found at ${src} — nothing to update`)
    return
  }
  const stagingDest = path.join(args.artifactRoot, '.specrails', 'setup-templates', component)
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

async function resolveExistingProvider(artifactRoot: string): Promise<Provider> {
  if (pathExists(path.join(artifactRoot, '.claude'))) return 'claude'
  if (pathExists(path.join(artifactRoot, '.codex'))) return 'codex'
  if (pathExists(path.join(artifactRoot, '.gemini'))) return 'gemini'
  // None present — fall back to resolving via CLI availability.
  const avail = await detectAvailability()
  try {
    return await resolveProvider(avail, { skipPrereqs: true })
  } catch (err) {
    if (err instanceof InstallerError) throw err
    throw new InstallerError(
      `could not determine provider of existing install at ${artifactRoot}`,
      40,
    )
  }
}

function readExistingVersion(artifactRoot: string): string | null {
  const p = path.join(artifactRoot, '.specrails', 'specrails-version')
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
