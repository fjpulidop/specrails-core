import { readFileSync } from 'node:fs'
import type { AgentRole, RuntimeConfig, RuntimeProviderConfig } from './executor-types.js'

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
function positive(value: unknown, field: string, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) fail(field, 'expected a positive finite number' + (integer ? ' (integer)' : ''))
  return value
}
export function validateRuntimeConfig(input: unknown, options: { registeredProviderIds?: string[] } = {}): RuntimeConfig {
  const config = object(input, '$')
  keys(config, ['schemaVersion', 'enabled', 'providers', 'agents', 'limits', 'verification', 'approvalBeforeArchive'], '$')
  if (config.schemaVersion !== 1) fail('schemaVersion', 'expected 1')
  if (typeof config.enabled !== 'boolean') fail('enabled', 'expected boolean')
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
    keys(agent, ['provider', 'model', 'maxTurns'], field)
    const provider = identifier(agent.provider, `${field}.provider`)
    if (!known.has(provider)) fail(`${field}.provider`, `provider '${provider}' is not configured or registered`)
    if (agent.model !== undefined) {
      const model = string(agent.model, `${field}.model`)
      if (model.length > 256 || /[\r\n]/.test(model) || model.startsWith('-')) fail(`${field}.model`, 'invalid model identifier')
    }
    if (providers.find(p => p.id === provider)?.kind === 'openai-compatible' && agent.model === undefined) fail(`${field}.model`, 'required for an OpenAI-compatible provider')
    if (agent.maxTurns !== undefined) positive(agent.maxTurns, `${field}.maxTurns`)
    return [role, { provider, ...(agent.model === undefined ? {} : { model: agent.model }), ...(agent.maxTurns === undefined ? {} : { maxTurns: agent.maxTurns }) }]
  })) as RuntimeConfig['agents']
  if (config.limits !== undefined) {
    const limits = object(config.limits, 'limits')
    keys(limits, ['maxAttempts', 'maxTokens', 'maxCostUsd', 'timeoutMs'], 'limits')
    for (const [key, value] of Object.entries(limits)) positive(value, `limits.${key}`, key !== 'maxCostUsd')
  }
  if (!Array.isArray(config.verification)) fail('verification', 'expected an array of verification commands')
  const verification = config.verification.map((item, i) => {
    const field = `verification[${i}]`, command = object(item, field)
    keys(command, ['repositoryId', 'command', 'args', 'cwd', 'env', 'timeoutMs'], field)
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
  if (config.approvalBeforeArchive !== undefined && typeof config.approvalBeforeArchive !== 'boolean') fail('approvalBeforeArchive', 'expected boolean')
  return { schemaVersion: 1, enabled: config.enabled, providers, agents, verification,
    ...(config.limits === undefined ? {} : { limits: { ...config.limits as RuntimeConfig['limits'] } }),
    ...(config.approvalBeforeArchive === undefined ? {} : { approvalBeforeArchive: config.approvalBeforeArchive }),
  }
}
export function loadRuntimeConfig(file: string, options?: { registeredProviderIds?: string[] }): RuntimeConfig {
  return validateRuntimeConfig(JSON.parse(readFileSync(file, 'utf8')), options)
}
