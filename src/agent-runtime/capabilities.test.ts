import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertEffortSupported, cliCapabilities, configuredCapabilities } from './capabilities.js'
import { ExecutorRegistry } from './executors.js'
import { unknownUsage, type RuntimeConfig } from './executor-types.js'
import { buildCliInvocation } from './cli-executor.js'
import { OpenAICompatibleExecutor } from './openai-executor.js'

const scratch: string[] = []
afterEach(() => { for (const file of scratch.splice(0)) rmSync(file, { recursive: true, force: true }) })
describe('installed transport capability introspection', () => {
  it('reads Claude effort values without treating resume flags as history guarantees', async () => {
    const runProcess = vi.fn(async () => ({ stdout: '--effort <level> Effort for this session (low, medium, high)\n  --resume <id> Continue', stderr: '', exitCode: 0 }))
    const result = await cliCapabilities('claude', 'sonnet', { runProcess })
    expect(result).toMatchObject({ continuation: 'unknown', effortSupport: 'supported', supportedEfforts: ['low', 'medium', 'high'] })
    expect(runProcess.mock.calls).toHaveLength(1)
    expect(() => assertEffortSupported({ effort: 'max' }, result)).toThrow('not confirmed')
  })
  it('requires the exact fresh Codex client/model catalog and maps explicit effort into argv', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'effort-')); scratch.push(root)
    const cache = { fetched_at: new Date().toISOString(), client_version: '0.153.4', models: [{ slug: 'test-model', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] }] }
    const save = () => writeFileSync(path.join(root, 'models_cache.json'), JSON.stringify(cache))
    save()
    const runProcess = vi.fn(async (invocation: { args: string[] }) => ({ stdout: invocation.args[0] === '--version' ? 'codex-cli 0.153.4\n' : '--config <key=value>', stderr: '', exitCode: 0 }))
    const options = { runProcess, env: { CODEX_HOME: root } }
    expect(await cliCapabilities('codex', 'test-model', options)).toMatchObject({ supportedEfforts: ['medium', 'high'] })
    expect(await cliCapabilities('codex', 'other-model', options)).toMatchObject({ effortSupport: 'unknown' })
    cache.client_version = '0.1'; save()
    expect(await cliCapabilities('codex', 'test-model', options)).toMatchObject({ effortSupport: 'unknown' })
    cache.client_version = '0.153.4'; cache.fetched_at = '2020-01-01'; save()
    expect(await cliCapabilities('codex', 'test-model', options)).toMatchObject({ effortSupport: 'unknown' })
    const invocation = buildCliInvocation('codex', { role: 'developer', prompt: 'task', model: 'test-model', effort: 'medium', cwd: root, allowedRoots: [root] })
    expect(invocation.args).toContain('model_reasoning_effort="medium"')
  })
  it('does not infer Kimi ACP support from legacy print mode', async () => {
    const runProcess = vi.fn()
    expect(await cliCapabilities('kimi', 'k3', { runProcess })).toMatchObject({ transport: 'kimi-acp', continuation: 'unsupported', supportedEfforts: [] })
    expect(runProcess).not.toHaveBeenCalled()
  })
  it('queries base and escalation models separately', async () => {
    const capabilities = vi.fn(async (model?: string) => ({ transport: 'fixture', continuation: 'supported' as const, effortSupport: 'supported' as const, supportedEfforts: model === 'base' ? ['low'] : ['high'], observedEffort: false, observedModel: false }))
    const registry = new ExecutorRegistry().register('fixture', { execute: async () => ({ text: 'ok', usage: unknownUsage() }), capabilities })
    const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: { provider: 'fixture', model: 'base', escalation: { model: 'higher' } }, developer: { provider: 'fixture', model: 'base' }, reviewer: { provider: 'fixture', model: 'base' } }, verification: [] }
    const result = await configuredCapabilities(config, registry)
    expect(result.roles[1]).toMatchObject({ role: 'architect', tier: 'escalation', model: 'higher', supportedEfforts: ['high'] })
  })
  it('rejects an unsupported API effort before any HTTP request', async () => {
    const fetch = vi.fn()
    const executor = new OpenAICompatibleExecutor({ id: 'api', kind: 'openai-compatible', baseUrl: 'http://localhost:1' }, { fetch })
    await expect(executor.execute({ role: 'developer', model: 'model', effort: 'medium', prompt: 'task', cwd: '/', allowedRoots: ['/'] })).rejects.toMatchObject({ code: 'provider_capability_unsupported' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
