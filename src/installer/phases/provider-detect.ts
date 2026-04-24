import { homedir } from 'node:os'
import path from 'node:path'

import { ProviderError } from '../util/errors.js'
import { commandExists, runCommand } from '../util/exec.js'
import { pathExists, readTextFile } from '../util/fs.js'

/**
 * Provider detection + authentication checks. These mirror the Phase
 * 1.2 / 1.3 branches of the retired install.sh. Codex detection is
 * preserved so its "coming soon" error can still be surfaced when a
 * user has only codex installed.
 */

export type Provider = 'claude' | 'codex'

export interface ProviderAvailability {
  claude: boolean
  codex: boolean
}

export interface ProviderDerivedPaths {
  /** Root directory inside the user's repo: `.claude` for Claude, `.codex` for Codex. */
  providerDir: string
  /** Top-level instructions file: `CLAUDE.md` for Claude, `AGENTS.md` for Codex. */
  instructionsFile: string
}

/**
 * Detects which AI CLIs are on PATH. Runs `where` on Windows and
 * `which` on POSIX via the cross-platform commandExists helper.
 */
export async function detectAvailability(): Promise<ProviderAvailability> {
  const [claude, codex] = await Promise.all([commandExists('claude'), commandExists('codex')])
  return { claude, codex }
}

/**
 * Returns the Claude CLI version string (stdout of `claude --version`)
 * or 'unknown' if the CLI cannot be invoked.
 */
export async function claudeVersion(): Promise<string> {
  try {
    const { stdout } = await runCommand('claude', ['--version'], { inherit: false })
    return stdout.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Resolves which provider the installer should use. Priority:
 *   1. Explicit `--provider claude` flag (already passed through args).
 *   2. Config file (read upstream in install-config.ts).
 *   3. Whichever CLI is installed.
 *
 * Codex-only installs error out — see design: Codex is "coming soon".
 * The caller may bypass prereq failures with `skipPrereqs: true`
 * (env `SPECRAILS_SKIP_PREREQS=1`).
 */
export async function resolveProvider(
  availability: ProviderAvailability,
  options: { explicit?: Provider; skipPrereqs?: boolean } = {},
): Promise<Provider> {
  if (options.explicit === 'codex') {
    throw new ProviderError(
      'Codex (OpenAI) support is coming soon — currently being tested in our lab. ' +
        'Use --provider claude for now.',
    )
  }
  if (options.explicit === 'claude') return 'claude'

  if (availability.claude && availability.codex) return 'claude'
  if (availability.claude) return 'claude'
  if (availability.codex) {
    throw new ProviderError(
      'Only Codex detected — Codex (OpenAI) support is coming soon (currently in our lab). ' +
        'Please install Claude Code to continue: https://claude.ai/download',
    )
  }
  if (options.skipPrereqs) return 'claude'
  throw new ProviderError(
    'No AI CLI found (claude). ' +
      'Install Claude Code: https://claude.ai/download. ' +
      'Codex (OpenAI) support: coming soon.',
  )
}

/**
 * Directory / filename conventions the provider dictates.
 *   - Claude Code:  .claude/ + CLAUDE.md
 *   - Codex:        .codex/  + AGENTS.md
 */
export function derivedPaths(provider: Provider): ProviderDerivedPaths {
  if (provider === 'codex') {
    return { providerDir: '.codex', instructionsFile: 'AGENTS.md' }
  }
  return { providerDir: '.claude', instructionsFile: 'CLAUDE.md' }
}

/**
 * Asserts that Claude Code is authenticated. Matches the three-path
 * check from install.sh: `claude config list` → ANTHROPIC_API_KEY env →
 * ~/.claude.json OAuth.
 */
export async function assertClaudeAuthenticated(
  options: { skipPrereqs?: boolean } = {},
): Promise<void> {
  if (await hasClaudeApiKeyConfigured()) return
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) return
  if (await hasClaudeOauthJson()) return

  if (options.skipPrereqs) return

  throw new ProviderError(
    [
      'No Claude authentication found.',
      '',
      '  Option 1 (API key): claude config set api_key <your-key>',
      '  Option 2 (OAuth):   claude auth login',
    ].join('\n'),
  )
}

async function hasClaudeApiKeyConfigured(): Promise<boolean> {
  try {
    const { stdout } = await runCommand('claude', ['config', 'list'], { inherit: false })
    return stdout.includes('api_key')
  } catch {
    return false
  }
}

async function hasClaudeOauthJson(): Promise<boolean> {
  const p = path.join(homedir(), '.claude.json')
  if (!pathExists(p)) return false
  try {
    const raw = readTextFile(p)
    return raw.includes('"oauthAccount"')
  } catch {
    return false
  }
}
