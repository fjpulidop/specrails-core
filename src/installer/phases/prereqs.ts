import { PrerequisiteError } from '../util/errors.js'
import { commandExists } from '../util/exec.js'
import { info, ok, warn } from '../util/logger.js'
import { gitInstalled, initRepo, isGitRepo, repoRoot } from '../util/git.js'

import {
  type Provider,
  type ProviderAvailability,
  assertClaudeAuthenticated,
  claudeVersion,
  detectAvailability,
  resolveProvider,
} from './provider-detect.js'

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
}

/**
 * Orchestrates every prerequisite check that must pass before the
 * installer proceeds to Phase 3 (scaffolding). Emits ok/warn/info
 * lines matching the retired bash output.
 */
export async function checkPrerequisites(options: PrereqOptions): Promise<PrereqResult> {
  if (!(await gitInstalled())) {
    throw new PrerequisiteError(
      'git is required but not on PATH. Install git: https://git-scm.com/',
    )
  }

  // 1.1 Git repository — auto-init when --yes, otherwise assume caller
  //     resolved the prompt upstream (bin/specrails-core.cjs / hub TUI).
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

  // 1.3 Authentication for the selected provider.
  if (provider === 'claude') {
    await assertClaudeAuthenticated({ skipPrereqs: options.skipPrereqs })
    ok('Claude: authenticated')
  }

  // 1.4 npm — required for running the TUI and for the `update` command.
  if (!(await commandExists('npm'))) {
    if (options.skipPrereqs) {
      warn('npm not found (skipped — SPECRAILS_SKIP_PREREQS=1)')
    } else {
      throw new PrerequisiteError(
        'npm is required but not on PATH. Install Node.js 20+ from https://nodejs.org/',
      )
    }
  } else {
    ok('npm: found')
  }

  // 1.5 OpenSpec CLI — optional but highly recommended (used by the
  //     agent workflow). Warn only.
  if (await commandExists('openspec')) {
    ok('OpenSpec CLI: found')
  } else {
    info('OpenSpec CLI not found — install via `npm install -g openspec` (optional)')
  }

  // 1.6 GitHub CLI — optional; enables OSS detection + issue-backed flows.
  if (await commandExists('gh')) {
    ok('GitHub CLI: found')
  } else {
    info('GitHub CLI not found — optional, enables OSS detection')
  }

  // 1.8 JIRA CLI — silently skipped when missing (only relevant in enrich).
  return { availability, provider }
}
