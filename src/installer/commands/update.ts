import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { InstallerError, PrerequisiteError } from '../util/errors.js'
import { info, ok, step, warn } from '../util/logger.js'
import { pathExists, readTextFile } from '../util/fs.js'

import { buildManifest, writeManifestFiles, type SpecrailsManifest } from '../phases/manifest.js'
import { derivedPaths, detectAvailability, resolveProvider, type Provider } from '../phases/provider-detect.js'
import { scaffoldInstallation } from '../phases/scaffold.js'

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
}

export async function runUpdate(flags: UpdateFlags): Promise<UpdateResult> {
  const scriptDir = resolveScriptDir()
  const currentVersion = readVersion(scriptDir)

  const repoRoot = path.resolve(
    typeof flags['root-dir'] === 'string' ? flags['root-dir'] : process.cwd(),
  )
  const dryRun = flags['dry-run'] === true
  const agentTeams = flags['agent-teams'] === true

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

  if (flags.only !== undefined && typeof flags.only === 'string') {
    // The --only flag in the retired bash installer accepted "core",
    // "rules", "templates". We surface it as a warning for now: the
    // Node implementation applies the full scaffold atomically.
    warn(
      `--only=${flags.only} is not yet honoured by the Node installer; the full scaffold will run.`,
    )
  }

  if (dryRun) {
    info(
      `Dry run: would update templates, commands, and manifest ` +
        `for ${previousVersion ?? '(unknown)'} → ${currentVersion}.`,
    )
    return { repoRoot, previousVersion, currentVersion, provider, dryRun }
  }

  step(`Update: refreshing scaffold (${previousVersion ?? '?'} → ${currentVersion})`)
  scaffoldInstallation({
    scriptDir,
    repoRoot,
    provider,
    providerDir,
    agentTeams,
    // Update always applies the full layer; quick-tier-vs-full is an
    // install-time choice. We re-apply whatever the user had (we
    // cannot know the original tier from the repo state alone, so
    // default to `full` — the extra files under setup-templates/ are
    // exactly what the enrich flow expects).
    tier: 'full',
  })

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
  return { repoRoot, previousVersion, currentVersion, provider, dryRun: false }
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
