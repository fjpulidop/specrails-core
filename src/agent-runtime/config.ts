import { readFileSync } from 'node:fs'
import type { AgentRole, RuntimeConfig, RuntimeProviderConfig } from './executor-types.js'
import { DEFAULT_REVIEW_POLICY, REVIEW_ASPECTS, type ReviewAspect } from './graph/review-policy.js'

const ROLES: AgentRole[] = ['architect', 'developer', 'reviewer']
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
function fail(field: string, why: string): never { throw new Error(`Invalid runtime config ${field}: ${why}`) }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'expected an object')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field}.${key}`, 'unknown field')
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(field, 'expected a nonempty string')
  return value
}
function identifier(value: unknown, field: string): string {
  const result = string(value, field)
  if (!ID.test(result)) fail(field, 'expected a safe provider identifier')
  return result
}
function model(value: unknown, field: string): string {
  const result = string(value, field)
  if (result.length > 256 || /[\r\n]/.test(result) || result.startsWith('-')) fail(field, 'invalid model identifier')
  return result
}
function effort(value: unknown, field: string): string {
  const result = string(value, field)
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(result)) fail(field, 'invalid effort identifier')
  return result
}
function boolean(value: unknown, field: string): void {
  if (typeof value !== 'boolean') fail(field, 'expected boolean')
}
function choices(value: unknown, allowed: string[], field: string): void {
  if (!allowed.includes(String(value)) || typeof value !== 'string') fail(field, `expected ${allowed.join(' or ')}`)
}
function positive(value: unknown, field: string, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) fail(field, 'expected a positive finite number' + (integer ? ' (integer)' : ''))
  return value
}
/** Review thresholds may only tighten Core's own gate; the pipeline journal enforces the floor regardless of configuration. */
function score(value: unknown, field: string, floor: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) fail(field, 'expected a number from 0 to 100')
  if (value < floor) fail(field, `must be at least ${floor}, Core's own review gate`)
  return value
}
export function validateRuntimeConfig(input: unknown, options: { registeredProviderIds?: string[] } = {}): RuntimeConfig {
  const config = object(input, '$')
  keys(config, ['schemaVersion', 'enabled', 'providers', 'agents', 'limits', 'verification', 'approvalBeforeArchive', 'review', 'architect', 'rolePrompts', 'efficiency'], '$')
  if (config.schemaVersion !== 1) fail('schemaVersion', 'expected 1')
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') fail('enabled', 'expected boolean')
  if (!Array.isArray(config.providers)) fail('providers', 'expected an array')
  const providers = config.providers.map((item, i): RuntimeProviderConfig => {
    const field = `providers[${i}]`, provider = object(item, field)
    const id = identifier(provider.id, `${field}.id`)
    if (provider.kind === 'cli') {
      keys(provider, ['id', 'kind', 'cli'], field)
      if (!['claude', 'codex', 'gemini', 'kimi'].includes(String(provider.cli))) fail(`${field}.cli`, 'unsupported CLI')
      return { id, kind: 'cli', cli: provider.cli as 'claude' | 'codex' | 'gemini' | 'kimi' }
    }
    if (provider.kind !== 'openai-compatible') fail(`${field}.kind`, 'unsupported executor kind')
    keys(provider, ['id', 'kind', 'baseUrl', 'apiKeyEnv'], field)
    const baseUrl = string(provider.baseUrl, `${field}.baseUrl`)
    let url: URL
    try { url = new URL(baseUrl) } catch { fail(`${field}.baseUrl`, 'expected an absolute HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(`${field}.baseUrl`, 'use HTTP(S) without credentials, query or fragment')
    if (provider.apiKeyEnv !== undefined && (typeof provider.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv))) fail(`${field}.apiKeyEnv`, 'expected an environment variable name, never a credential value')
    return { id, kind: 'openai-compatible', baseUrl, ...(provider.apiKeyEnv === undefined ? {} : { apiKeyEnv: provider.apiKeyEnv as string }) }
  })
  if (new Set(providers.map(p => p.id)).size !== providers.length) fail('providers', 'duplicate provider id')
  const known = new Set([...providers.map(p => p.id), ...options.registeredProviderIds ?? []])
  const rawAgents = object(config.agents, 'agents')
  keys(rawAgents, ROLES, 'agents')
  const agents = Object.fromEntries(ROLES.map(role => {
    const field = `agents.${role}`, agent = object(rawAgents[role], field)
    keys(agent, ['provider', 'model', 'maxTurns', 'effort', 'escalation'], field)
    const provider = identifier(agent.provider, `${field}.provider`)
    if (!known.has(provider)) fail(`${field}.provider`, `provider '${provider}' is not configured or registered`)
    if (agent.model !== undefined) {
      model(agent.model, `${field}.model`)
    }
    if (providers.find(p => p.id === provider)?.kind === 'openai-compatible' && agent.model === undefined) fail(`${field}.model`, 'required for an OpenAI-compatible provider')
    if (agent.maxTurns !== undefined) positive(agent.maxTurns, `${field}.maxTurns`)
    if (agent.effort !== undefined) effort(agent.effort, `${field}.effort`)
    if (agent.escalation !== undefined) {
      const escalation = object(agent.escalation, `${field}.escalation`)
      keys(escalation, ['model', 'effort'], `${field}.escalation`)
      if (agent.model === undefined) fail(`${field}.model`, 'an explicit base model is required for escalation')
      model(escalation.model, `${field}.escalation.model`)
      if (escalation.effort !== undefined) effort(escalation.effort, `${field}.escalation.effort`)
      if (escalation.model === agent.model && escalation.effort === agent.effort) fail(`${field}.escalation`, 'must select a different model or effort')
    }
    return [role, structuredClone(agent) as unknown as RuntimeConfig['agents'][AgentRole]]
  })) as RuntimeConfig['agents']
  if (config.limits !== undefined) {
    const limits = object(config.limits, 'limits')
    keys(limits, ['maxAttempts', 'maxTokens', 'maxCostUsd', 'timeoutMs'], 'limits')
    for (const [key, value] of Object.entries(limits)) positive(value, `limits.${key}`, key !== 'maxCostUsd')
  }
  if (!Array.isArray(config.verification)) fail('verification', 'expected an array of verification commands')
  const verification = config.verification.map((item, i) => {
    const field = `verification[${i}]`, command = object(item, field)
    keys(command, ['repositoryId', 'command', 'args', 'cwd', 'env', 'timeoutMs', 'key', 'label', 'policy'], field)
    if (command.key !== undefined) identifier(command.key, `${field}.key`)
    if (command.label !== undefined && string(command.label, `${field}.label`).length > 256) fail(`${field}.label`, 'maximum 256 characters')
    if (command.policy !== undefined) {
      const policy = object(command.policy, `${field}.policy`)
      keys(policy, ['reuse', 'inputs', 'deterministic', 'readOnly', 'toolchainInputs', 'independentGroup', 'resources'], `${field}.policy`)
      if (policy.reuse !== undefined) choices(policy.reuse, ['never', 'snapshot-local'], `${field}.policy.reuse`)
      for (const key of ['deterministic', 'readOnly']) if (policy[key] !== undefined) boolean(policy[key], `${field}.policy.${key}`)
      if (policy.independentGroup !== undefined) identifier(policy.independentGroup, `${field}.policy.independentGroup`)
      for (const key of ['inputs', 'toolchainInputs', 'resources']) {
        const values = policy[key]
        if (values === undefined) continue
        if (!Array.isArray(values) || values.length > 256) fail(`${field}.policy.${key}`, 'expected at most 256 entries')
        for (const value of values) if (string(value, `${field}.policy.${key}`).length > 4096) fail(`${field}.policy.${key}`, 'entry exceeds 4096 characters')
      }
    }
    identifier(command.repositoryId, `${field}.repositoryId`)
    string(command.command, `${field}.command`)
    if (!Array.isArray(command.args) || !command.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) fail(`${field}.args`, 'expected a string array')
    if (command.cwd !== undefined) string(command.cwd, `${field}.cwd`)
    if (command.timeoutMs !== undefined) positive(command.timeoutMs, `${field}.timeoutMs`)
    if (command.env !== undefined) {
      const env = object(command.env, `${field}.env`)
      for (const [key, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) fail(`${field}.env`, 'expected environment names and string values')
        if (/(?:token|secret|password|api_?key|credential)/i.test(key)) fail(`${field}.env.${key}`, 'credentials must be inherited from the process environment, never saved')
      }
    }
    return structuredClone(command)
  }) as unknown as RuntimeConfig['verification']
  const checkKeys = verification.flatMap(check => check.key ? [check.key] : [])
  if (new Set(checkKeys).size !== checkKeys.length) fail('verification', 'duplicate check key')
  if (config.efficiency !== undefined) {
    const policy = object(config.efficiency, 'efficiency')
    keys(policy, ['schemaVersion', 'contextMode', 'reviewMode', 'planning', 'acceptDeveloperChecks', 'verification'], 'efficiency')
    if (policy.schemaVersion !== 1) fail('efficiency.schemaVersion', 'expected 1')
    for (const key of ['contextMode', 'reviewMode']) if (policy[key] !== undefined) choices(policy[key], ['full', 'incremental'], `efficiency.${key}`)
    if (policy.planning !== undefined) choices(policy.planning, ['full', 'proportional'], 'efficiency.planning')
    if (policy.acceptDeveloperChecks !== undefined) boolean(policy.acceptDeveloperChecks, 'efficiency.acceptDeveloperChecks')
    if (policy.verification !== undefined) {
      const verification = object(policy.verification, 'efficiency.verification')
      keys(verification, ['maxConcurrency'], 'efficiency.verification')
      if (verification.maxConcurrency !== undefined && positive(verification.maxConcurrency, 'efficiency.verification.maxConcurrency') > 4) fail('efficiency.verification.maxConcurrency', 'maximum 4')
    }
  }
  if (config.approvalBeforeArchive !== undefined && typeof config.approvalBeforeArchive !== 'boolean') fail('approvalBeforeArchive', 'expected boolean')
  let review: RuntimeConfig['review']
  if (config.review !== undefined) {
    const raw = object(config.review, 'review')
    keys(raw, ['minScore', 'aspects'], 'review')
    review = {}
    if (raw.minScore !== undefined) review.minScore = score(raw.minScore, 'review.minScore', DEFAULT_REVIEW_POLICY.minScore)
    if (raw.aspects !== undefined) {
      const aspects = object(raw.aspects, 'review.aspects')
      keys(aspects, [...REVIEW_ASPECTS], 'review.aspects')
      review.aspects = Object.fromEntries(Object.entries(aspects).map(([name, value]) => [name, score(value, `review.aspects.${name}`, DEFAULT_REVIEW_POLICY.aspects[name as ReviewAspect])])) as RuntimeConfig['review'] extends { aspects?: infer A } ? A : never
    }
  }
  let architect: RuntimeConfig['architect']
  if (config.architect !== undefined) {
    const raw = object(config.architect, 'architect')
    keys(raw, ['onLowConfidence'], 'architect')
    architect = {}
    if (raw.onLowConfidence !== undefined) {
      if (raw.onLowConfidence !== 'ask' && raw.onLowConfidence !== 'proceed') fail('architect.onLowConfidence', 'expected "ask" or "proceed"')
      architect.onLowConfidence = raw.onLowConfidence
    }
  }
  let rolePrompts: RuntimeConfig['rolePrompts']
  if (config.rolePrompts !== undefined) {
    const raw = object(config.rolePrompts, 'rolePrompts')
    keys(raw, ROLES, 'rolePrompts')
    rolePrompts = {}
    for (const [role, value] of Object.entries(raw)) {
      const text = string(value, `rolePrompts.${role}`)
      if (text.length > 20000) fail(`rolePrompts.${role}`, 'maximum 20000 characters')
      rolePrompts[role as AgentRole] = text
    }
  }
  return { schemaVersion: 1, enabled: true, providers, agents, verification,
    ...(config.efficiency === undefined ? {} : { efficiency: structuredClone(config.efficiency) as RuntimeConfig['efficiency'] }),
    ...(rolePrompts === undefined ? {} : { rolePrompts }),
    ...(config.limits === undefined ? {} : { limits: { ...config.limits as RuntimeConfig['limits'] } }),
    ...(config.approvalBeforeArchive === undefined ? {} : { approvalBeforeArchive: config.approvalBeforeArchive }),
    ...(review === undefined ? {} : { review }),
    ...(architect === undefined ? {} : { architect }),
  }
}
export function loadRuntimeConfig(file: string, options?: { registeredProviderIds?: string[] }): RuntimeConfig {
  return validateRuntimeConfig(JSON.parse(readFileSync(file, 'utf8')), options)
}

/** New admissions normalize once; validation of a saved document is lossless. */
export function normalizeRuntimeConfig(input: unknown, options?: { registeredProviderIds?: string[] }): RuntimeConfig {
  const config = JSON.parse(JSON.stringify(validateRuntimeConfig(input, options))) as RuntimeConfig
  config.efficiency = {
    schemaVersion: 1, contextMode: 'incremental', reviewMode: 'incremental', planning: 'proportional', acceptDeveloperChecks: true,
    ...config.efficiency, verification: { maxConcurrency: 1, ...config.efficiency?.verification },
  }
  return config
}
