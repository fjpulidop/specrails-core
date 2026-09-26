import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Ajv } from 'ajv'
import { BUILTIN_ROLES, BUILTIN_ROLE_POLICY, normalizeAgentRequest, validateAgentRequest, type AgentRequest, type RuntimeConfig } from './executor-types.js'
import { normalizeRuntimeConfig, resolveRoleDescriptor, roleIds, validateRuntimeConfig } from './config.js'
import { buildCliInvocation, CliExecutor, kimiNativeSkill } from './cli-executor.js'
import { WorkspaceTools } from './workspace-tools.js'
import { OpenAICompatibleExecutor } from './openai-executor.js'
import { extractPromptInputs } from './compact/prompt-inputs.js'
import { configuredCapabilities } from './capabilities.js'
import { ExecutorRegistry } from './executors.js'
import { selectRoleRoute } from './role-routing.js'

const directories: string[] = []
function directory(): string { const root = mkdtempSync(path.join(tmpdir(), 'open-roles-')); directories.push(root); return root }
function config(): RuntimeConfig { return { schemaVersion: 1, enabled: true, providers: [{ id: 'cli', kind: 'cli', cli: 'claude' }], agents: { architect: { provider: 'cli' }, developer: { provider: 'cli' }, reviewer: { provider: 'cli' } }, verification: [], roles: { 'security-reviewer': { provider: 'cli', access: 'read', artifacts: 'none', prompt: 'Inspect security boundaries.' } } } }
function request(extra: Partial<AgentRequest> = {}): AgentRequest { const cwd = directory(); return { role: 'security-reviewer', access: 'read', artifacts: 'none', instructions: 'role', prompt: 'Inspect this change', cwd, allowedRoots: [cwd], ...extra } }
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('open role contracts', () => {
  it('normalizes admission once while preserving lossless saved validation and the required trio', () => {
    const input = config(), before = JSON.stringify(input)
    expect(validateRuntimeConfig(input)).toEqual(input)
    const normalized = normalizeRuntimeConfig(input)
    expect(normalizeRuntimeConfig(normalized)).toEqual(normalized)
    expect(JSON.stringify(input)).toBe(before)
    expect(roleIds(normalized)).toEqual([...BUILTIN_ROLES, 'security-reviewer'])
    for (const role of BUILTIN_ROLES) expect(resolveRoleDescriptor(normalized, role)).toMatchObject({ id: role, provider: 'cli', ...BUILTIN_ROLE_POLICY[role] })
    expect(resolveRoleDescriptor(normalized, 'security-reviewer').prompt).toContain('security')
    expect(() => resolveRoleDescriptor(input, 'unknown')).toThrow('Unknown runtime role')
    expect(() => validateRuntimeConfig({ ...input, agents: {} })).toThrow()
    const { roles: _roles, ...legacy } = input
    expect(validateRuntimeConfig(legacy)).not.toHaveProperty('roles')
  })
  it('keeps schema validation aligned with additive roles and prompts', () => {
    const schema = JSON.parse(readFileSync(new URL('../../schemas/agent-runtime.schema.json', import.meta.url), 'utf8'))
    const validate = new Ajv({ strict: false }).compile(schema)
    const value = { ...config(), rolePrompts: { 'security-reviewer': 'Review the attack surface.' } }
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true)
    expect(validateRuntimeConfig(value)).toEqual(value)
    expect(resolveRoleDescriptor(value, 'security-reviewer').prompt).toBe('Review the attack surface.')
    expect(validate({ ...value, roles: { MixedCase: value.roles!['security-reviewer'] } })).toBe(false)
  })
  it.each([
    { roles: { MixedCase: { provider: 'cli', access: 'read', artifacts: 'none' } } },
    { roles: { fixer: { provider: 'cli', access: 'read', artifacts: 'none' } } },
    { roles: { custom: { provider: 'cli', access: 'admin', artifacts: 'none' } } },
    { roles: { custom: { provider: 'cli', access: 'read', artifacts: 'all', compact: true } } },
    { roles: { developer: { provider: 'cli', access: 'read', artifacts: 'none' } } },
    { roles: { custom: { provider: 'missing', access: 'read', artifacts: 'none' } } },
    { rolePrompts: { undeclared: 'Do work' } },
  ])('rejects invalid role declarations: %j', extra => expect(() => validateRuntimeConfig({ ...config(), ...extra })).toThrow('Invalid runtime config'))
  it('requires explicit custom policy and rejects ambiguous native requests before effects', () => {
    const input = request()
    expect(normalizeAgentRequest({ ...input, role: 'architect', access: undefined, artifacts: undefined, instructions: undefined })).toMatchObject({ access: 'read', artifacts: 'all', instructions: 'role' })
    for (const extra of [{ access: undefined }, { artifacts: undefined }, { instructions: undefined }, { role: 'MixedCase' }, { nativeCommand: { id: 'opsx:ff' } }, { instructions: 'none', prompt: '', nativeCommand: { id: '../shell' } }, { instructions: 'none', prompt: '', nativeCommand: { id: 'opsx:ff', args: '\0' } }]) {
      expect(() => validateAgentRequest({ ...input, ...extra } as AgentRequest)).toThrow()
    }
    expect(() => validateAgentRequest({ ...input, instructions: 'none', prompt: '', nativeCommand: { id: 'opsx:ff', args: 'a "quoted" value' } })).not.toThrow()
  })
  it('applies read policy to each CLI independently of the role name', () => {
    const input = request()
    expect(buildCliInvocation('claude', input).args).toContain('Read,Grep,Glob')
    expect(buildCliInvocation('claude', input).args).toContain('plan')
    expect(buildCliInvocation('codex', input).args).toContain('read-only')
    expect(buildCliInvocation('gemini', input, { geminiPolicyFile: '/policy.toml' }).args).toContain('plan')
    expect(buildCliInvocation('kimi', input, { kimiAgentFile: '/readonly.md' }).args).toContain('--agent-file')
    expect(() => buildCliInvocation('kimi', input)).toThrow('read-only')
    expect(buildCliInvocation('codex', { ...input, access: 'write' }).args).toContain('workspace-write')
    const workspace = new WorkspaceTools(input.cwd, input.allowedRoots, input.access!)
    expect(() => workspace.execute('write_file', { path: 'forbidden.ts', content: 'bad' })).toThrow('unavailable')
    expect(existsSync(path.join(input.cwd, 'forbidden.ts'))).toBe(false)
  })
  it.each(['claude', 'codex', 'gemini'] as const)('renders native %s commands without role instructions or shell evaluation', provider => {
    const input = request({ instructions: 'none', prompt: '', nativeCommand: { id: 'opsx:ff', args: 'a "quoted" $(literal)' } })
    const invocation = buildCliInvocation(provider, input, { geminiPolicyFile: '/policy.toml' })
    const text = provider === 'codex' ? invocation.stdin : invocation.args[invocation.args.indexOf('-p') + 1]
    expect(text).toBe(`${provider === 'codex' ? '$' : '/'}opsx:ff a "quoted" $(literal)`)
    expect(invocation.args).not.toContain('--append-system-prompt')
    const plain = buildCliInvocation(provider, { ...input, nativeCommand: undefined, prompt: 'Just the request' }, { geminiPolicyFile: '/policy.toml' })
    expect(plain.stdin).toBe('Just the request')
  })
  it('renders Kimi skills without inference then uses the existing read-only transport', async () => {
    const input = request({ instructions: 'none', prompt: '', model: 'k3', nativeCommand: { id: 'opsx:ff', args: 'feature' } })
    mkdirSync(path.join(input.cwd, '.kimi-code/specrails'), { recursive: true })
    writeFileSync(path.join(input.cwd, '.kimi-code/specrails/run-skill.mjs'), '// installed runner fixture')
    const runProcess = vi.fn(async (invocation: { command: string; args: string[] }) => {
      if (invocation.command === process.execPath) { expect(invocation.args).toContain('--render-only'); expect(invocation.args).toContain('openspec-ff-change'); return { exitCode: 0, stdout: JSON.stringify({ prompt: 'Exact installed skill instructions' }), stderr: '' } }
      if (invocation.args[0] === '--help') return { exitCode: 0, stdout: '--agent-file', stderr: '' }
      expect(invocation.args).toContain('--agent-file')
      expect(invocation.args[invocation.args.indexOf('-p') + 1]).toBe('Exact installed skill instructions')
      return { exitCode: 0, stdout: '{"role":"assistant","content":"done"}\n{"role":"meta","type":"session.resume_hint","session_id":"native-session"}\n', stderr: '' }
    })
    const result = await new CliExecutor('kimi', { runProcess }).execute(input)
    expect(result.usage.costUsd).toBeNull()
    expect(runProcess).toHaveBeenCalledTimes(3)
    expect(kimiNativeSkill('specrails:implement')).toBe('specrails-implement')
    expect(() => kimiNativeSkill('foreign:unsafe')).toThrow('unsupported')
    await expect(new CliExecutor('kimi', { runProcess }).execute(request({ prompt: '', instructions: 'none', nativeCommand: { id: 'opsx:ff' } }))).rejects.toMatchObject({ code: 'native_command_unsupported' })
  })
  it('keeps custom API turns free, bounded and read-only with unknown usage preserved', async () => {
    const input = request({ instructions: 'none', model: 'fixture' })
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.messages).toEqual([{ role: 'user', content: input.prompt }])
      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain('write_file')
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Reviewed' }, finish_reason: 'stop' }] }))
    })
    const executor = new OpenAICompatibleExecutor({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://fixture.invalid', agentLoop: 'compact' }, { fetch })
    const result = await executor.execute(input)
    expect(result.text).toBe('Reviewed')
    expect(result.usage).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null })
    await expect(executor.execute({ ...input, prompt: '', nativeCommand: { id: 'opsx:ff' } })).rejects.toMatchObject({ code: 'native_command_unsupported' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(extractPromptInputs('Free user request')).toMatchObject({ developerSummary: '', scope: '', criteria: [] })
  })
  it('does not select the compact reviewer protocol for a custom role with an OpenSpec binding', async () => {
    const input = request({ model: 'fixture' })
    input.openspec = { role: input.role, root: input.cwd, stateDirectory: input.cwd, change: 'audit', cli: '/unused/openspec.js', skillPath: '/unused/SKILL.md', skillHash: 'unused', access: 'read', artifacts: 'none', openspecSkill: 'openspec-verify-change' }
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.messages[0].content).toContain('one security-reviewer task')
      expect(body.messages[1].content).toContain('openspec-verify-change')
      expect(body.messages[0].content).not.toContain('Reviewer verdict')
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Audited' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } }))
    })
    const result = await new OpenAICompatibleExecutor({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://fixture.invalid', agentLoop: 'compact' }, { fetch }).execute(input)
    expect(result.text).toBe('Audited')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('reports declared roles without introducing automatic escalation policy', async () => {
    const input = config()
    input.roles!['security-reviewer']!.model = 'base'
    input.roles!['security-reviewer']!.escalation = { model: 'higher' }
    const registry = new ExecutorRegistry().register('cli', { execute: vi.fn(), capabilities: () => ({ transport: 'fixture', continuation: 'unsupported', effortSupport: 'unsupported', supportedEfforts: [], observedModel: false, observedEffort: false }) })
    const capabilities = await configuredCapabilities(input, registry)
    expect(capabilities.roles.filter(row => row.role === 'security-reviewer').map(row => row.tier)).toEqual(['base', 'escalation'])
    expect(selectRoleRoute('security-reviewer', resolveRoleDescriptor(input, 'security-reviewer'), 'repair', { history: [] }).tier).toBe('base')
  })
})
