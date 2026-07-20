import path from 'node:path'

import { PrerequisiteError } from '../util/errors.js'
import { commandExists, runCommand } from '../util/exec.js'
import { isDir, isFile, listDir } from '../util/fs.js'
import { info, ok, warn } from '../util/logger.js'
import { gitInstalled, initRepo, isGitRepo, repoRoot } from '../util/git.js'

import {
  type Provider,
  type ProviderAvailability,
  assertClaudeAuthenticated,
  assertKimiAuthenticated,
  claudeVersion,
  detectAvailability,
  isSupportedKimiVersion,
  kimiVersion,
  MIN_KIMI_VERSION,
  resolveProvider,
} from './provider-detect.js'

/**
 * OpenSpec 1.4.1, which the installer invokes during the default init/update
 * flow, requires Node >=20.19.0. Keep this floor independent from Kimi's npm
 * package requirement: SpecRails launches an externally installed Kimi CLI and
 * does not require the Kimi npm distribution.
 */
export const MIN_NODE_VERSION = '20.19.0'

export function isSupportedNodeVersion(version: string): boolean {
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim())
  if (!parsed) return false

  const actual = parsed.slice(1, 4).map(Number)
  const minimum = MIN_NODE_VERSION.split('.').map(Number)
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index]! > minimum[index]!) return true
    if (actual[index]! < minimum[index]!) return false
  }
  return true
}

/**
 * Phase 1 prerequisite bundle. Mirrors install.sh's Phase 1 flow but
 * with explicit options rather than a grab-bag of globals.
 *
 * Returns the resolved inputs later phases need — primarily the
 * selected provider and the detected CLI availability.
 */

export interface PrereqOptions {
  /** Absolute path to the target repository root. */
  repoRoot: string
  /** --yes / -y equivalent — auto-init git, skip interactive prompts. */
  autoYes: boolean
  /** Explicit --provider flag (if passed). */
  explicitProvider?: Provider
  /** SPECRAILS_SKIP_PREREQS=1 equivalent — relax hard failures for CI. */
  skipPrereqs: boolean
}

export interface PrereqResult {
  availability: ProviderAvailability
  provider: Provider
  /**
   * OSS heuristics. Three signals must align for `isOss` to be true:
   * a public GitHub repo (via `gh repo view`), at least one CI workflow
   * file under `.github/workflows/`, and a `CONTRIBUTING.md` at the
   * repo root or under `.github/`. Surfaced for the downstream
   * `/specrails:enrich` flow to tailor the persona generation.
   */
  ossSignals: OssSignals
}

export interface OssSignals {
  hasGh: boolean
  publicRepo: boolean
  hasCi: boolean
  hasContributing: boolean
  isOss: boolean
}

/**
 * Orchestrates every prerequisite check that must pass before the
 * installer proceeds to Phase 3 (scaffolding). Emits ok/warn/info
 * lines matching the retired bash output.
 */
export async function checkPrerequisites(options: PrereqOptions): Promise<PrereqResult> {
  const nodeVersion = process.versions.node
  if (!isSupportedNodeVersion(nodeVersion)) {
    throw new PrerequisiteError(
      `Node.js ${nodeVersion} is unsupported. SpecRails requires Node.js ` +
        `${MIN_NODE_VERSION} or newer because OpenSpec 1.4.1 uses that runtime floor. ` +
        'Install a supported Node.js release from https://nodejs.org/',
    )
  }
  ok(`Node.js: ${nodeVersion}`)

  if (!(await gitInstalled())) {
    throw new PrerequisiteError(
      'git is required but not on PATH. Install git: https://git-scm.com/',
    )
  }

  // 1.1 Git repository — auto-init when --yes, otherwise assume caller
  //     resolved the prompt upstream (bin/specrails-core.cjs / desktop app TUI).
  if (!(await isGitRepo(options.repoRoot))) {
    if (!options.autoYes) {
      throw new PrerequisiteError(
        `${options.repoRoot} is not a git repository. ` +
          `Run \`git init\` first, or pass --yes to let the installer initialise it.`,
      )
    }
    await initRepo(options.repoRoot)
  }
  const root = await repoRoot(options.repoRoot)
  ok(`Git repository root: ${root}`)

  // 1.2 Provider detection.
  const availability = await detectAvailability()
  const provider = await resolveProvider(availability, {
    explicit: options.explicitProvider,
    skipPrereqs: options.skipPrereqs,
  })

  if (provider === 'claude') {
    if (availability.claude) {
      const v = await claudeVersion()
      ok(`Claude Code CLI: ${v}`)
    } else if (options.explicitProvider === 'claude') {
      ok(`Provider: claude (--provider flag)`)
    }
  }
  if (provider === 'kimi') {
    if (availability.kimi) {
      const v = await kimiVersion()
      if (!isSupportedKimiVersion(v) && !options.skipPrereqs) {
        throw new PrerequisiteError(
          `Kimi Code ${v} is unsupported. Upgrade to ${MIN_KIMI_VERSION} or newer: ` +
            'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
        )
      }
      ok(`Kimi Code CLI: ${v}`)
    } else if (options.explicitProvider === 'kimi') {
      if (!options.skipPrereqs) {
        throw new PrerequisiteError(
          'Kimi Code CLI is not installed. Install it from https://www.kimi.com/code/docs/en/ ' +
            'and retry, or run with SPECRAILS_SKIP_PREREQS=1 for fixture generation.',
        )
      }
      ok('Provider: kimi (--provider flag)')
    }
  }

  // 1.3 Authentication for the selected provider.
  if (provider === 'claude') {
    await assertClaudeAuthenticated({ skipPrereqs: options.skipPrereqs })
    ok('Claude: authenticated')
  }
  if (provider === 'kimi' && availability.kimi) {
    const status = await assertKimiAuthenticated({ skipPrereqs: options.skipPrereqs })
    if (status === 'authenticated') {
      ok('Kimi: authentication evidence found')
    } else if (status === 'unknown') {
      info(
        'Kimi authentication could not be proven without a billable prompt; ' +
          'the first workflow will report 401/login errors. Run `kimi login` if needed.',
      )
    }
  }

  // 1.4 npm — required for running the TUI and for the `update` command.
  if (!(await commandExists('npm'))) {
    if (options.skipPrereqs) {
      warn('npm not found (skipped — SPECRAILS_SKIP_PREREQS=1)')
    } else {
      throw new PrerequisiteError(
        `npm is required but not on PATH. Install Node.js ${MIN_NODE_VERSION}+ from https://nodejs.org/`,
      )
    }
  } else {
    ok('npm: found')
  }

  // 1.5 OpenSpec CLI — optional. The installer falls back to
  //     `npx openspec` automatically, so a missing global install is
  //     not a problem. Warn only when present is preferable (faster).
  if (await commandExists('openspec')) {
    ok('OpenSpec CLI: found (global)')
  } else {
    info('OpenSpec CLI not on PATH — will fetch via npx during install')
  }

  // 1.6 GitHub CLI — optional; enables OSS detection + issue-backed flows.
  const hasGh = await commandExists('gh')
  if (hasGh) {
    ok('GitHub CLI: found')
  } else {
    info('GitHub CLI not found — optional, enables OSS detection')
  }

  // 1.7 OSS detection — runs only when gh is present + authenticated.
  //     Degrades gracefully (every signal independently false) when
  //     prereqs are missing.
  const ossSignals = await detectOssSignals(options.repoRoot, hasGh)
  if (ossSignals.isOss) {
    ok('OSS project detected (public repo + CI + CONTRIBUTING.md)')
  }

  // 1.8 JIRA CLI — silently skipped when missing (only relevant in enrich).
  return { availability, provider, ossSignals }
}

async function detectOssSignals(repoRoot: string, hasGh: boolean): Promise<OssSignals> {
  let publicRepo = false
  if (hasGh) {
    try {
      const { stdout } = await runCommand(
        'gh',
        ['repo', 'view', '--json', 'isPrivate', '--jq', '.isPrivate'],
        { cwd: repoRoot, inherit: false },
      )
      // gh emits 'true' / 'false' newline-terminated.
      publicRepo = stdout.trim().toLowerCase() === 'false'
    } catch {
      /* not a gh-tracked repo or gh not authenticated — leave false */
    }
  }

  const hasCi = hasCiWorkflows(repoRoot)
  const hasContributing =
    isFile(path.join(repoRoot, 'CONTRIBUTING.md')) ||
    isFile(path.join(repoRoot, '.github', 'CONTRIBUTING.md'))

  return {
    hasGh,
    publicRepo,
    hasCi,
    hasContributing,
    isOss: hasGh && publicRepo && hasCi && hasContributing,
  }
}

function hasCiWorkflows(repoRoot: string): boolean {
  const dir = path.join(repoRoot, '.github', 'workflows')
  if (!isDir(dir)) return false
  return listDir(dir).some((p) => p.endsWith('.yml') || p.endsWith('.yaml'))
}
