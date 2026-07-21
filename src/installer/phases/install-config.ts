import path from 'node:path'

import yaml from 'js-yaml'

import { FilesystemError, InstallerError } from '../util/errors.js'
import { pathExists, readTextFile, writeFileLf } from '../util/fs.js'

/**
 * Provider identifier. Kept in lock-step with `provider-detect.ts` `Provider`.
 */
export type Provider = 'claude' | 'codex' | 'gemini' | 'kimi'

/** Cost / capability preset for the model picker. */
export type ModelPreset = 'balanced' | 'budget' | 'max'

/** Provider-native model selection retained verbatim in install-config.yaml. */
export interface InstallModelConfig {
  preset: ModelPreset
  defaults: {
    model: string
  }
  overrides: Record<string, string>
}

/**
 * Shape of the `.specrails/install-config.yaml` file — the single
 * source of truth the TUI writes and the installer reads. Fields map
 * 1:1 onto the grep-based parser in the retired install.sh.
 */
export interface InstallConfig {
  version: 1
  provider: Provider
  agents: {
    selected: string[]
    excluded?: string[]
    /** Legacy pre-models-section location, accepted for backward compatibility. */
    preset?: ModelPreset
  }
  models?: InstallModelConfig
}

const PROVIDER_DEFAULT_MODELS: Record<Provider, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.5-mini',
  gemini: 'gemini-3.5-flash',
  kimi: 'k3',
}

/**
 * Agent ids become provider-native file/directory names. Keep them to the
 * portable direct-child skill grammar so config cannot escape an install root
 * or create names that Kimi's managed runner will later reject.
 */
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Must remain byte-for-byte equivalent to the canonical Kimi runtime and the
 * public integration contract. Config validation happens before any framework
 * write so an unsafe model can never create an install that only fails later at
 * process launch.
 */
const SAFE_KIMI_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/

/**
 * Resolve a preset into provider-native identifiers. Kimi currently exposes no
 * Core-defined cost/capability tier mapping, so every named preset resolves to
 * its explicit `k3` default. User-supplied exact identifiers are handled later
 * and are never interpreted as Claude aliases.
 */
export function resolveProviderModelConfig(
  provider: Provider,
  preset: ModelPreset = 'balanced',
): InstallModelConfig {
  if (provider === 'claude') {
    if (preset === 'budget') {
      return { preset, defaults: { model: 'haiku' }, overrides: {} }
    }
    if (preset === 'max') {
      return {
        preset,
        defaults: { model: 'sonnet' },
        overrides: {
          'sr-architect': 'opus',
          'sr-product-manager': 'opus',
        },
      }
    }
  }
  return {
    preset,
    defaults: { model: PROVIDER_DEFAULT_MODELS[provider] },
    overrides: {},
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
  } else if (
    doc.provider !== 'claude' &&
    doc.provider !== 'codex' &&
    doc.provider !== 'gemini' &&
    doc.provider !== 'kimi'
  ) {
    errors.push(
      `unsupported provider '${String(doc.provider)}' (expected: claude, codex, gemini, or kimi)`,
    )
  }

  // NOTE: a legacy `tier` field (`full`/`quick`) may still be present in pre-v5
  // configs. It is intentionally ignored (not rejected and not carried forward)
  // — v5 has no install tiers.

  const agents = doc.agents as Record<string, unknown> | undefined
  let selectedAgents: string[] = []
  let excludedAgents: string[] | undefined
  if (!agents || typeof agents !== 'object') {
    errors.push(`missing required 'agents' section with 'selected' list`)
  } else {
    if (!Array.isArray(agents.selected)) {
      errors.push(`'agents.selected' must be a list`)
    } else {
      selectedAgents = validateAgentIdList(
        agents.selected,
        'agents.selected',
        errors,
      )
    }
    if (agents.excluded !== undefined && !Array.isArray(agents.excluded)) {
      errors.push(`'agents.excluded' must be a list`)
    } else if (Array.isArray(agents.excluded)) {
      excludedAgents = validateAgentIdList(
        agents.excluded,
        'agents.excluded',
        errors,
      )
    }
    if (Array.isArray(agents.selected) && Array.isArray(agents.excluded)) {
      const excluded = new Set(excludedAgents ?? [])
      for (const agent of selectedAgents) {
        if (excluded.has(agent)) {
          errors.push(
            `'agents.selected' and 'agents.excluded' must not overlap: ${agent}`,
          )
        }
      }
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

  const models = doc.models as Record<string, unknown> | undefined
  if (doc.models !== undefined && (!models || typeof models !== 'object')) {
    errors.push(`'models' must be a mapping`)
  }
  const modelPreset = models?.preset
  if (
    modelPreset !== undefined &&
    modelPreset !== 'balanced' &&
    modelPreset !== 'budget' &&
    modelPreset !== 'max'
  ) {
    errors.push(
      `unsupported model preset '${String(modelPreset)}' (expected: balanced, budget, or max)`,
    )
  }
  const provider = doc.provider as Provider
  const modelDefaults = models?.defaults as Record<string, unknown> | undefined
  if (
    models?.defaults !== undefined &&
    (!modelDefaults || typeof modelDefaults !== 'object')
  ) {
    errors.push(`'models.defaults' must be a mapping`)
  } else if (
    modelDefaults?.model !== undefined &&
    !isValidModelIdentifier(provider, modelDefaults.model)
  ) {
    errors.push(modelIdentifierError('models.defaults.model', provider))
  }
  const modelOverrides = models?.overrides
  if (
    modelOverrides !== undefined &&
    (!modelOverrides || typeof modelOverrides !== 'object' || Array.isArray(modelOverrides))
  ) {
    errors.push(`'models.overrides' must be a mapping`)
  } else if (modelOverrides && typeof modelOverrides === 'object') {
    for (const [agent, model] of Object.entries(modelOverrides)) {
      if (!SAFE_AGENT_ID.test(agent)) {
        errors.push(
          `'models.overrides' key '${agent}' must be a lowercase kebab-case agent id (1-64 characters)`,
        )
      }
      if (!isValidModelIdentifier(provider, model)) {
        errors.push(modelIdentifierError(`models.overrides.${agent}`, provider))
      }
    }
  }

  if (errors.length > 0) {
    throw new InvalidConfigError(errors)
  }

  const preset = (modelPreset ?? agents?.preset ?? 'balanced') as ModelPreset
  const resolvedModels = resolveProviderModelConfig(provider, preset)
  if (typeof modelDefaults?.model === 'string') {
    resolvedModels.defaults.model = modelDefaults.model
  }
  if (modelOverrides && typeof modelOverrides === 'object') {
    resolvedModels.overrides = { ...(modelOverrides as Record<string, string>) }
  }
  const result: InstallConfig = {
    version: 1,
    provider,
    agents: {
      selected: selectedAgents,
    },
    models: resolvedModels,
  }
  // NOTE: a legacy `agent_teams` field may still be present in older configs.
  // It is intentionally ignored (not rejected) for backward compatibility.
  if (agents?.preset !== undefined) {
    result.agents.preset = agents.preset as ModelPreset
  }
  if (excludedAgents !== undefined) {
    result.agents.excluded = excludedAgents
  }
  return result
}

function validateAgentIdList(
  value: unknown[],
  field: string,
  errors: string[],
): string[] {
  const valid: string[] = []
  const seen = new Set<string>()
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !SAFE_AGENT_ID.test(entry)) {
      errors.push(
        `'${field}[${index}]' must be a lowercase kebab-case agent id (1-64 characters)`,
      )
      continue
    }
    if (seen.has(entry)) {
      errors.push(`'${field}' must not contain duplicate agent id '${entry}'`)
      continue
    }
    seen.add(entry)
    valid.push(entry)
  }
  return valid
}

function isValidModelIdentifier(
  provider: Provider,
  value: unknown,
): value is string {
  if (provider === 'kimi') {
    return typeof value === 'string' && SAFE_KIMI_MODEL_ID.test(value)
  }
  return isExactModelIdentifier(value)
}

function modelIdentifierError(field: string, provider: Provider): string {
  if (provider === 'kimi') {
    return (
      `'${field}' must be a safe Kimi model id: 1-128 characters matching ` +
      `[A-Za-z0-9][A-Za-z0-9._/:-]*`
    )
  }
  return `'${field}' must be a nonblank provider model identifier`
}

function isExactModelIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value === value.trim()
  )
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
