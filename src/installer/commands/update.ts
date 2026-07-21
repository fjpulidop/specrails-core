import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { InstallerError, PrerequisiteError } from '../util/errors.js'
import { info, ok, step, warn } from '../util/logger.js'
import { copyDir, isDir, pathExists, readTextFile } from '../util/fs.js'

import { loadInstallConfig, resolveConfigPath } from '../phases/install-config.js'
import { buildManifest, writeManifestFiles, type SpecrailsManifest } from '../phases/manifest.js'
import { derivedPaths, detectAvailability, resolveProvider, type Provider } from '../phases/provider-detect.js'
import { frameworkRoot, resolveArtifacts } from '../util/registry.js'
import { migratePreV5Install } from './v5-migration.js'

import {
  ensureFramework,
  installOpenSpecProject,
  reassembleWorkspaceProviders,
  snapshotWorkspaceProviderSelections,
  warnUnknownSelectedAgents,
} from './init.js'

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
  /**
   * Force the provider to update. Without it, the provider is auto-detected
   * from the existing install (`.claude` > `.codex` > `.gemini` > `.kimi-code`), which on a
   * MULTI-PROVIDER workspace always picks `.claude` first — so codex/gemini/kimi
   * could never be updated. specrails-desktop (and standalone users) pass
   * `--provider <name>` to update one specific provider. Mirrors `init`.
   */
  provider?: string | boolean
  /**
   * Relocate artifacts to the $HOME workspace (symlinked) instead of in-repo.
   * Mirrors `init --relocate`: standalone updates resolve in-repo by default,
   * desktop relocates (its registry entry already exists, so `allocate:false`
   * still resolves the relocated entry). Also honoured via `SPECRAILS_RELOCATE=1`.
   */
  relocate?: boolean
}

export interface UpdateResult {
  repoRoot: string
  previousVersion: string | null
  currentVersion: string
  provider: Provider
  dryRun: boolean
  /** Resolved scope of the update — what was actually re-applied. */
  scope: OnlyComponent
}

export async function runUpdate(flags: UpdateFlags): Promise<UpdateResult> {
  const scriptDir = resolveScriptDir()
  const currentVersion = readVersion(scriptDir)

  const repoRoot = path.resolve(
    typeof flags['root-dir'] === 'string' ? flags['root-dir'] : process.cwd(),
  )
  const dryRun = flags['dry-run'] === true

  // ─── Resolve where artifacts live: in-repo (default) vs relocated ─────
  // Mirrors init: standalone updates resolve IN-REPO by default (`allocate:false`
  // + no registry entry ⇒ `artifactRoot === codeRoot === repoRoot`); desktop and
  // `--relocate`/`SPECRAILS_RELOCATE=1` users resolve the relocated $HOME
  // workspace (desktop's registry entry already exists, so even `allocate:false`
  // returns it). All Specrails artifacts (the specrails-version marker, manifest,
  // install-config) live under `artifactRoot`.
  const relocate = flags.relocate === true || process.env.SPECRAILS_RELOCATE === '1'
  const { artifactRoot, codeRoot } = resolveArtifacts(repoRoot, {
    allocate: relocate,
    allocator: 'core-standalone',
    home: process.env.SPECRAILS_REGISTRY_HOME,
    coreVersion: currentVersion,
  })

  // install-config.yaml is a USER-authored file that lives in the repo (the user
  // can't know the relocated workspace path), so it is read from repoRoot — NOT
  // the artifactRoot. Falls back to a workspace copy if present (none today).
  const config =
    loadInstallConfig(resolveConfigPath(repoRoot)) ?? loadInstallConfig(resolveConfigPath(artifactRoot))
  const selectedAgents = config?.agents.selected
  warnUnknownSelectedAgents(selectedAgents)

  const marker = path.join(artifactRoot, '.specrails', 'specrails-version')
  if (!pathExists(marker)) {
    throw new PrerequisiteError(
      `No existing specrails install detected at ${repoRoot}. Run \`npx specrails-core init\` first.`,
    )
  }
  const previousVersion = readExistingVersion(artifactRoot)
  const previousSelections =
    snapshotWorkspaceProviderSelections(artifactRoot)

  // Provider can be FORCED via --provider (e.g. specrails-desktop updating one
  // provider on a multi-provider workspace, where auto-detection would always
  // resolve `.claude` first and never reach codex/gemini/kimi). Absent ⇒ auto-detect
  // from the existing install — byte-identical single-provider behaviour.
  let provider: Provider
  if (typeof flags.provider === 'string') {
    if (
      flags.provider !== 'claude' &&
      flags.provider !== 'codex' &&
      flags.provider !== 'gemini' &&
      flags.provider !== 'kimi'
    ) {
      throw new InstallerError(
        `--provider value must be 'claude', 'codex', 'gemini', or 'kimi', got: ${flags.provider}`,
        40,
      )
    }
    provider = flags.provider as Provider
    step(`Update: using requested provider ${provider}`)
  } else {
    step('Update: resolving provider from existing install')
    provider = await resolveExistingProvider(artifactRoot)
  }
  const { providerDir } = derivedPaths(provider)
  ok(`Detected provider: ${provider} (${providerDir})`)
  if (artifactRoot !== codeRoot) {
    resolveArtifacts(repoRoot, {
      allocate: true,
      allocator: 'core-standalone',
      home: process.env.SPECRAILS_REGISTRY_HOME,
      providers: [provider],
      coreVersion: currentVersion,
    })
  }

  // ─── Resolve --only scope ────────────────────────────────────────
  const scope = resolveScope(flags.only)
  if (scope === 'web-manager') {
    warn(
      '--only=web-manager is deprecated. The standalone web-manager has been retired; ' +
        'specrails-desktop is the supported dashboard. Skipping with no changes.',
    )
    return { repoRoot, previousVersion, currentVersion, provider, dryRun, scope }
  }
  if (
    provider === 'kimi' &&
    (scope === 'rules' || scope === 'agents')
  ) {
    throw new InstallerError(
      `--only=${scope} cannot safely refresh Kimi's linked direct-child skill ` +
        'catalogue in isolation. Run `npx specrails-core update --provider kimi` ' +
        'without --only so framework, live workspace, and manifest advance together.',
      40,
    )
  }

  if (dryRun) {
    info(
      `Dry run: would update [${scope}] ` +
        `for ${previousVersion ?? '(unknown)'} → ${currentVersion}.`,
    )
    return { repoRoot, previousVersion, currentVersion, provider, dryRun, scope }
  }

  // ─── v5 migration: remove artefacts a pre-v5 install left behind ─────
  // Runs BEFORE the re-scaffold so obsolete agents/commands/staging are gone
  // before the fresh v5 template set is placed. Reserved paths (profiles, custom-*)
  // and files the installer never owned are left untouched.
  if (scope === 'all' || scope === 'core') {
    migratePreV5Install({ artifactRoot, providerDir })
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
      selectedAgents,
    })
    reassembleWorkspaceProviders({
      workspace: artifactRoot,
      frameworkDir: fwDir,
      version: currentVersion,
      codeRoot,
      scriptDir,
      selectedProvider: provider,
      selectedAgents:
        config?.provider === provider
          ? selectedAgents
          : previousSelections[provider] ?? selectedAgents,
      previousSelections,
      // In-repo updates COPY real files; relocated workspaces symlink.
      copyStatics: artifactRoot === codeRoot,
    })
    if (provider === 'kimi') {
      await installOpenSpecProject(codeRoot, provider, artifactRoot)
    }
    ok(`Re-linked ${providerDir}/ at framework ${currentVersion} + rewrote manifest`)
  } else if (scope === 'rules' || scope === 'agents') {
    rescaffoldComponent(scope, { scriptDir, artifactRoot })

    step('Update: rewriting manifest')
    const manifest: SpecrailsManifest = buildManifest({
      scriptDir,
      repoRoot: artifactRoot,
      version: currentVersion,
      providers: [provider],
      primaryProvider: provider,
    })
    const { manifestPath, versionPath } = writeManifestFiles(artifactRoot, manifest)
    ok(`Wrote ${path.relative(artifactRoot, manifestPath)}`)
    ok(`Wrote ${path.relative(artifactRoot, versionPath)}`)
  }

  step('Update complete')
  info(`specrails-core ${previousVersion ?? '?'} → ${currentVersion}`)
  // Terminal sentinel for programmatic consumers (see comment in init.ts).
  ok('update complete')
  return { repoRoot, previousVersion, currentVersion, provider, dryRun: false, scope }
}

/**
 * Re-applies a single subtree (rules or agents) from the bundled
 * templates into the staging dir (.specrails/setup-templates/). Skips the
 * agent-memory bootstrap that scaffoldInstallation does — that should only
 * run on a true (re-)install.
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
  if (pathExists(path.join(artifactRoot, '.kimi-code'))) return 'kimi'
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
