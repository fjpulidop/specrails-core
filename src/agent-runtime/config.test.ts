import { describe, expect, it } from 'vitest'
import { validateRuntimeConfig } from './config.js'
import { createExecutorRegistry, ExecutorRegistry } from './executors.js'
import { unknownUsage, type RuntimeConfig } from './executor-types.js'

function config(): RuntimeConfig {
  return { schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }], agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } }, verification: [] }
}
describe('runtime configuration and registration', () => {
  it('defaults to the agent runtime and ignores the retired opt-in flag', () => {
    expect(validateRuntimeConfig({ ...config(), enabled: undefined }).enabled).toBe(true)
    expect(validateRuntimeConfig({ ...config(), enabled: false }).enabled).toBe(true)
  })
  it('preserves all four CLI identities and opaque custom models', () => {
    const value = config()
    value.providers = ['claude', 'codex', 'gemini', 'kimi'].map(cli => ({ id: cli, kind: 'cli', cli: cli as 'claude' }))
    value.agents.developer = { provider: 'kimi', model: 'company/future-model:local' }
    expect(validateRuntimeConfig(value)).toEqual(value)
    expect(createExecutorRegistry(value).ids()).toEqual(['claude', 'codex', 'gemini', 'kimi'])
  })
  it('accepts an unauthenticated local endpoint and requires its explicit model', () => {
    const value = config()
    value.providers.push({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })
    value.agents.developer = { provider: 'local', model: 'qwen3-coder:30b' }
    expect(validateRuntimeConfig(value)).toEqual(value)
    delete value.agents.developer.model
    expect(() => validateRuntimeConfig(value)).toThrow('agents.developer.model')
  })
  it.each([
    (value: RuntimeConfig) => { value.providers.push(value.providers[0]) },
    (value: RuntimeConfig) => { value.agents.reviewer.provider = 'missing' },
    (value: RuntimeConfig) => { value.limits = { maxAttempts: 0 } },
    (value: RuntimeConfig) => { value.agents.architect.maxTurns = Infinity },
    (value: RuntimeConfig) => { Object.assign(value.providers[0], { apiKey: 'do-not-save' }) },
    (value: RuntimeConfig) => { value.providers.push({ id: 'api', kind: 'openai-compatible', baseUrl: 'https://user:password@provider.test/v1' }) },
    (value: RuntimeConfig) => { value.providers.push({ id: 'api', kind: 'openai-compatible', baseUrl: 'https://provider.test/v1?api_key=secret' }) },
    (value: RuntimeConfig) => { value.providers.push({ id: 'api', kind: 'openai-compatible', baseUrl: 'file:///private', apiKeyEnv: 'sk-not-an-env' }) },
    (value: RuntimeConfig) => { value.verification.push({ repositoryId: 'main', command: 'npm', args: [], env: { API_KEY: 'do-not-save' } }) },
    (value: RuntimeConfig) => { value.review = { minScore: 101 } },
    (value: RuntimeConfig) => { value.review = { aspects: { security: 74 } } },
    (value: RuntimeConfig) => { value.review = { minScore: 69 } },
    (value: RuntimeConfig) => { Object.assign(value, { architect: { onLowConfidence: 'guess' } }) },
    (value: RuntimeConfig) => { Object.assign(value, { review: { aspects: { readability: 90 } } }) },
  ])('rejects malformed, ambiguous or credential-bearing configuration', mutate => {
    const value = config(); mutate(value)
    expect(() => validateRuntimeConfig(value)).toThrow('Invalid runtime config')
  })
  it('lets projects tighten the review gate and choose how a low-confidence design proceeds', () => {
    const value = config()
    value.review = { minScore: 85, aspects: { security: 90, test_coverage: 60 } }
    value.architect = { onLowConfidence: 'proceed' }
    expect(validateRuntimeConfig(value)).toEqual(value)
    expect(() => validateRuntimeConfig({ ...value, review: { minScore: 60 } })).toThrow("at least 70, Core's own review gate")
    expect(() => validateRuntimeConfig({ ...value, review: { aspects: { security: 70 } } })).toThrow('review.aspects.security')
  })
  it('supports programmatic providers absent from serialized provider definitions', async () => {
    const value = config(); value.agents.developer.provider = 'my-ai'
    const executor = { execute: async () => ({ text: 'done', usage: unknownUsage() }) }
    const registry = createExecutorRegistry(value, { executors: { 'my-ai': executor } })
    expect(registry.get('my-ai')).toBe(executor)
    expect(registry.ids()).toContain('my-ai')
    expect(() => validateRuntimeConfig(value)).toThrow('not configured')
    expect(validateRuntimeConfig(value, { registeredProviderIds: registry.ids() })).toEqual(value)
    expect(await registry.execute('my-ai', { role: 'developer', prompt: 'task', cwd: '/', allowedRoots: ['/'] })).toMatchObject({ text: 'done' })
  })
  it('validates custom executor results and invocation limits', async () => {
    const registry = new ExecutorRegistry().register('bad', { execute: async () => ({ text: '', usage: unknownUsage() }) })
    const request = { role: 'developer' as const, prompt: 'task', cwd: '/', allowedRoots: ['/'] }
    await expect(registry.execute('bad', request)).rejects.toMatchObject({ code: 'invalid_executor_result' })
    await expect(registry.execute('bad', { ...request, maxTurns: -1 })).rejects.toMatchObject({ code: 'invalid_limit' })
  })
})

it('validates and clones role prompt overrides without changing older configurations', () => {
  const value = { ...config(), rolePrompts: { developer: 'Custom developer' } }
  const validated = validateRuntimeConfig(value)
  value.rolePrompts.developer = 'Changed later'
  expect(validated.rolePrompts?.developer).toBe('Custom developer')
  for (const rolePrompts of [{ developer: '' }, { developer: ' ' }, { alien: 'x' }, { developer: 'x'.repeat(20001) }, { developer: 'x\0y' }]) expect(() => validateRuntimeConfig({ ...config(), rolePrompts })).toThrow()
})
