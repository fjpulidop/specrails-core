import { homedir } from 'node:os'
import path from 'node:path'

import { ProviderError } from '../util/errors.js'
import { commandExists, runCommand } from '../util/exec.js'
import { pathExists, readTextFile } from '../util/fs.js'

/**
 * Provider detection + authentication checks. These mirror the Phase
 * 1.2 / 1.3 branches of the retired install.sh.
 */

export type Provider = 'claude' | 'codex' | 'gemini' | 'kimi'

/** Oldest TypeScript Kimi Code CLI release covered by this integration. */
export const MIN_KIMI_VERSION = '0.27.0'

export interface ProviderAvailability {
  claude: boolean
  codex: boolean
  /** Optional so callers/tests predating Gemini still typecheck; absent = false. */
  gemini?: boolean
  /** Optional so callers/tests predating Kimi still typecheck; absent = false. */
  kimi?: boolean
}

export interface ProviderDerivedPaths {
  /** Root directory inside the user's repo: `.claude` / `.codex` / `.gemini` / `.kimi-code`. */
  providerDir: string
  /** Instructions file relative to the artifact root. */
  instructionsFile: string
}

/**
 * Detects which AI CLIs are on PATH. Runs `where` on Windows and
 * `which` on POSIX via the cross-platform commandExists helper.
 */
export async function detectAvailability(): Promise<ProviderAvailability> {
  const [claude, codex, gemini, kimi] = await Promise.all([
    commandExists('claude'),
    commandExists('codex'),
    commandExists('gemini'),
    commandExists('kimi'),
  ])
  return { claude, codex, gemini, kimi }
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

/** Returns the raw Kimi Code CLI version or `unknown` when it cannot be probed. */
export async function kimiVersion(): Promise<string> {
  try {
    const { stdout, stderr } = await runCommand('kimi', ['--version'], {
      inherit: false,
      timeoutMs: 10_000,
    })
    return stdout.trim() || stderr.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Extracts a semver-like triple from version output such as `kimi-code 0.27.0`. */
export function parseCliVersion(raw: string): string | null {
  return /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/.exec(raw)?.slice(1, 4).join('.') ?? null
}

/** True when `raw` identifies a Kimi CLI at or above {@link MIN_KIMI_VERSION}. */
export function isSupportedKimiVersion(raw: string): boolean {
  const parsed = parseCliVersion(raw)
  if (!parsed) return false
  return compareVersionTriples(parsed, MIN_KIMI_VERSION) >= 0
}

/**
 * Resolves which provider the installer should use. Priority:
 *   1. Explicit `--provider claude` flag (already passed through args).
 *   2. Config file (read upstream in install-config.ts).
 *   3. Whichever CLI is installed.
 *
 * The caller may bypass prereq failures with `skipPrereqs: true`
 * (env `SPECRAILS_SKIP_PREREQS=1`).
 */
export async function resolveProvider(
  availability: ProviderAvailability,
  options: { explicit?: Provider; skipPrereqs?: boolean } = {},
): Promise<Provider> {
  if (options.explicit === 'codex') return 'codex'
  if (options.explicit === 'claude') return 'claude'
  if (options.explicit === 'gemini') return 'gemini'
  if (options.explicit === 'kimi') return 'kimi'

  // No multi-provider auto-pick beyond the historical Claude-first default: when
  // several CLIs are installed and no provider was requested, prefer Claude so
  // existing projects don't get re-bootstrapped onto a different provider. Users
  // pick codex/gemini/kimi via --provider or install-config.yaml.
  if (availability.claude) return 'claude'
  if (availability.codex) return 'codex'
  if (availability.gemini) return 'gemini'
  if (availability.kimi) return 'kimi'
  if (options.skipPrereqs) return 'claude'
  throw new ProviderError(
    'No AI CLI found. Install Claude Code (https://claude.ai/download), ' +
      'Codex CLI (https://developers.openai.com/codex), or ' +
      'Gemini CLI (https://github.com/google-gemini/gemini-cli), or ' +
      'Kimi Code (https://www.kimi.com/code/docs/en/) before running specrails-core init.',
  )
}

/**
 * Directory / filename conventions the provider dictates.
 *   - Claude Code:  .claude/ + CLAUDE.md
 *   - Codex:        .codex/  + AGENTS.md
 *   - Gemini CLI:   .gemini/ + GEMINI.md
 *   - Kimi Code:    .kimi-code/ + AGENTS.md
 */
export function derivedPaths(provider: Provider): ProviderDerivedPaths {
  if (provider === 'codex') {
    return { providerDir: '.codex', instructionsFile: 'AGENTS.md' }
  }
  if (provider === 'gemini') {
    return { providerDir: '.gemini', instructionsFile: 'GEMINI.md' }
  }
  if (provider === 'kimi') {
    return { providerDir: '.kimi-code', instructionsFile: '.kimi-code/AGENTS.md' }
  }
  if (provider === 'claude') {
    return { providerDir: '.claude', instructionsFile: 'CLAUDE.md' }
  }
  throw new ProviderError(`Unsupported provider: ${String(provider)}`)
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

export type KimiAuthenticationStatus = 'authenticated' | 'unauthenticated' | 'unknown'

/**
 * Bounded, non-billing Kimi authentication probe.
 *
 * Kimi 0.27 has no CLI command that proves managed OAuth readiness without
 * starting a model request. We therefore recognise non-secret evidence (the
 * managed credential file or a process-scoped model key), and honour explicit
 * login failures emitted by `kimi doctor`. A successful `kimi doctor` only
 * validates configuration, so it deliberately yields `unknown`.
 */
export async function probeKimiAuthentication(
  options: { kimiCodeHome?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<KimiAuthenticationStatus> {
  const env = options.env ?? process.env
  if (
    typeof env.KIMI_MODEL_API_KEY === 'string' &&
    env.KIMI_MODEL_API_KEY.length > 0 &&
    typeof env.KIMI_MODEL_NAME === 'string' &&
    env.KIMI_MODEL_NAME.length > 0
  ) {
    return 'authenticated'
  }

  const kimiHome =
    options.kimiCodeHome ??
    (typeof env.KIMI_CODE_HOME === 'string' && env.KIMI_CODE_HOME.length > 0
      ? env.KIMI_CODE_HOME
      : path.join(homedir(), '.kimi-code'))
  if (pathExists(path.join(kimiHome, 'credentials', 'kimi-code.json'))) {
    return 'authenticated'
  }

  try {
    const { stdout, stderr } = await runCommand('kimi', ['doctor'], {
      inherit: false,
      timeoutMs: 10_000,
      env,
    })
    return textReportsMissingKimiLogin(`${stdout}\n${stderr}`) ? 'unauthenticated' : 'unknown'
  } catch (error) {
    const probe = error as { stdout?: string; stderr?: string; message?: string }
    const text = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}\n${probe.message ?? ''}`
    return textReportsMissingKimiLogin(text) ? 'unauthenticated' : 'unknown'
  }
}

/**
 * Rejects only a conclusive login failure. `unknown` is allowed because setup
 * must not spend quota merely to prove authentication.
 */
export async function assertKimiAuthenticated(
  options: { skipPrereqs?: boolean; kimiCodeHome?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<KimiAuthenticationStatus> {
  const status = await probeKimiAuthentication(options)
  if (status !== 'unauthenticated' || options.skipPrereqs) return status
  throw new ProviderError(
    [
      'Kimi Code is installed but login is required.',
      '',
      '  Run: kimi login',
      '  Then retry specrails-core init.',
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

function textReportsMissingKimiLogin(raw: string): boolean {
  const text = raw.toLowerCase()
  return (
    text.includes('login required') ||
    text.includes('not logged in') ||
    text.includes('not authenticated') ||
    text.includes('please run kimi login') ||
    text.includes('run `kimi login`')
  )
}

function compareVersionTriples(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
