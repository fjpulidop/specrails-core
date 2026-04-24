import path from 'node:path'

import yaml from 'js-yaml'

import { FilesystemError, InstallerError } from '../util/errors.js'
import { pathExists, readTextFile, writeFileLf } from '../util/fs.js'

/**
 * Provider identifier. `codex` is gated — the CLI rejects it with a
 * "coming soon" error message — but the type exists so we can carry
 * the same validation diagnostics the bash installer emitted.
 */
export type Provider = 'claude' | 'codex'

/** Install tier selected at install time. */
export type Tier = 'full' | 'quick'

/** Cost / capability preset for the model picker. */
export type ModelPreset = 'balanced' | 'budget' | 'max'

/**
 * Shape of the `.specrails/install-config.yaml` file — the single
 * source of truth the TUI writes and the installer reads. Fields map
 * 1:1 onto the grep-based parser in the retired install.sh.
 */
export interface InstallConfig {
  version: 1
  provider: Provider
  agent_teams?: boolean
  tier?: Tier
  agents: {
    selected: string[]
    preset?: ModelPreset
  }
}

export class InvalidConfigError extends InstallerError {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`install-config.yaml is invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`, 40)
    this.name = 'InvalidConfigError'
    this.errors = errors
  }
}

export const CONFIG_RELATIVE_PATH = '.specrails/install-config.yaml'

/**
 * Resolves the install-config path: explicit argument > repo-root default.
 */
export function resolveConfigPath(repoRoot: string, explicit?: string): string {
  if (explicit && explicit.length > 0) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(repoRoot, explicit)
  }
  return path.join(repoRoot, CONFIG_RELATIVE_PATH)
}

/**
 * Reads and parses the install-config. Returns `null` if the file is
 * not present — caller decides whether that's an error or a fallback.
 */
export function loadInstallConfig(configPath: string): InstallConfig | null {
  if (!pathExists(configPath)) return null
  const raw = readTextFile(configPath)
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    throw new InvalidConfigError([`YAML parse error: ${(err as Error).message}`])
  }
  return validateInstallConfig(parsed)
}

/**
 * Validates an already-parsed YAML document. Collects every error
 * before throwing so the user sees them all at once (matches the
 * bash installer's `_config_errors` accumulator behaviour).
 */
export function validateInstallConfig(raw: unknown): InstallConfig {
  const errors: string[] = []

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    throw new InvalidConfigError(['config must be a YAML mapping'])
  }
  const doc = raw as Record<string, unknown>

  if (doc.version === undefined) {
    errors.push(`missing required 'version' field`)
  } else if (doc.version !== 1) {
    errors.push(`unsupported version '${String(doc.version)}' (expected: 1)`)
  }

  if (doc.provider === undefined) {
    errors.push(`missing required 'provider' field`)
  } else if (doc.provider === 'codex') {
    errors.push(
      `Codex (OpenAI) support is coming soon — currently being tested in our lab. Set provider: claude.`,
    )
  } else if (doc.provider !== 'claude') {
    errors.push(`unsupported provider '${String(doc.provider)}' (expected: claude)`)
  }

  if (doc.tier !== undefined && doc.tier !== 'full' && doc.tier !== 'quick') {
    errors.push(`unsupported tier '${String(doc.tier)}' (expected: full or quick)`)
  }

  const agents = doc.agents as Record<string, unknown> | undefined
  if (!agents || typeof agents !== 'object') {
    errors.push(`missing required 'agents' section with 'selected' list`)
  } else {
    if (!Array.isArray(agents.selected)) {
      errors.push(`'agents.selected' must be a list`)
    }
    if (
      agents.preset !== undefined &&
      agents.preset !== 'balanced' &&
      agents.preset !== 'budget' &&
      agents.preset !== 'max'
    ) {
      errors.push(
        `unsupported preset '${String(agents.preset)}' (expected: balanced, budget, or max)`,
      )
    }
  }

  if (errors.length > 0) {
    throw new InvalidConfigError(errors)
  }

  const selected = (agents?.selected as string[]) ?? []
  const result: InstallConfig = {
    version: 1,
    provider: doc.provider as Provider,
    agents: {
      selected,
    },
  }
  if (typeof doc.agent_teams === 'boolean') {
    result.agent_teams = doc.agent_teams
  }
  if (doc.tier !== undefined) {
    result.tier = doc.tier as Tier
  }
  if (agents?.preset !== undefined) {
    result.agents.preset = agents.preset as ModelPreset
  }
  return result
}

/**
 * Serialises an {@link InstallConfig} back to YAML and writes it with
 * LF line endings. Used by `npx specrails-core update --reset-config`
 * paths (not wired yet) and by tests.
 */
export function writeInstallConfig(configPath: string, config: InstallConfig): void {
  try {
    const text = yaml.dump(config, { lineWidth: 120, noRefs: true })
    writeFileLf(configPath, text)
  } catch (err) {
    throw new FilesystemError(
      `failed to write install-config.yaml: ${(err as Error).message}`,
      configPath,
    )
  }
}
