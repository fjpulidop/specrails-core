import { ARCHITECT_OUTPUT_SCHEMA } from './prompts.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCliInvocation, CliExecutor, cliToolEvents, parseCliOutput } from './cli-executor.js'
import { cliProcessEnvironment, runCliProcess, windowsKimiInvocation, type CliProcessRunner } from './cli-process.js'
import type { AgentRequest, CliProvider } from './executor-types.js'
import { GEMINI_READONLY_POLICY } from './gemini-policy.js'

const temporary: string[] = []
function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const root = mkdtempSync(path.join(tmpdir(), 'specrails-cli-')); temporary.push(root)
  return { role: 'developer', cwd: root, allowedRoots: [root], prompt: 'Fix "quotes"\nand $() & %PATH% | paths', model: 'custom-model', ...overrides }
}
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })
function jsonl(...events: unknown[]): string { return events.map(event => JSON.stringify(event)).join('\n') + '\n' }
const fixtures: Record<CliProvider, string> = {
  claude: jsonl({ type: 'assistant', message: { id: 'one', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } } }, { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 }, total_cost_usd: 0.1 }),
  codex: jsonl({ type: 'thread.started', thread_id: 'thread-1' }, { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
  gemini: jsonl({ type: 'message', role: 'assistant', content: 'done', delta: true }, { type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 2 } }),
  kimi: jsonl({ role: 'assistant', content: 'done' }, { role: 'meta', type: 'session.resume_hint', session_id: 'session-1' }),
}
describe('four CLI execution contracts', () => {
  it('adapts the architect schema before launching Codex and restores optional nulls', async () => {
    const runProcess: CliProcessRunner = async invocation => {
      const index = invocation.args.indexOf('--output-schema')
      const schema = JSON.parse(readFileSync(invocation.args[index + 1], 'utf8'))
      expect(schema.required).toContain('question')
      const verification = schema.properties.verification.anyOf[0]
      expect(verification.items.required).toContain('cwd')
      return { stdout: jsonl({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ confidence: 'high', question: null, verification: [{ repositoryId: 'front', command: 'npm', args: ['test'], cwd: null }] }) } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }), stderr: '', exitCode: 0 }
    }
    const result = await new CliExecutor('codex', { runProcess }).execute(request({ role: 'architect', outputSchema: ARCHITECT_OUTPUT_SCHEMA }))
    expect(result.structured).toEqual({ confidence: 'high', verification: [{ repositoryId: 'front', command: 'npm', args: ['test'] }] })
  })
  it('propagates the real Codex schema error instead of suggesting authentication', async () => {
    const runProcess: CliProcessRunner = async () => ({ stdout: jsonl({ type: 'turn.failed', error: { message: "Invalid schema: Missing 'cwd'." } }), stderr: '', exitCode: 1 })
    await expect(new CliExecutor('codex', { runProcess }).execute(request())).rejects.toThrow("Invalid schema: Missing 'cwd'.")
  })

  it.each(['claude', 'codex', 'gemini', 'kimi'] as const)('retains %s prompt identity without using platform skills', provider => {
    const input = request(), invocation = buildCliInvocation(provider, input)
    expect(invocation.command).toBe(provider)
    expect(provider === 'kimi' ? invocation.args[invocation.args.indexOf('-p') + 1] : invocation.stdin).toBe(input.prompt)
    expect(invocation.args.join(' ')).not.toContain('implement')
  })
  it('gives the developer the legacy Implement autonomy inside each CLI sandbox, never a read-only role', () => {
    const developer = buildCliInvocation('claude', request()).args
    expect(developer).toContain('--dangerously-skip-permissions')
    expect(developer.slice(developer.indexOf('--tools'), developer.indexOf('--tools') + 2)).toEqual(['--tools', 'default'])
    expect(developer.slice(developer.indexOf('--disallowedTools'), developer.indexOf('--disallowedTools') + 2)).toEqual(['--disallowedTools', 'Agent,Task,Skill'])
    expect(developer).not.toContain('--safe-mode')
    expect(developer.slice(developer.indexOf('--setting-sources'), developer.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'project,local'])
    expect(buildCliInvocation('gemini', request()).args).toContain('--yolo')
    expect(buildCliInvocation('codex', request()).args).toContain('workspace-write')
    for (const role of ['architect', 'reviewer'] as const) {
      const readOnly = buildCliInvocation('claude', request({ role })).args
      expect(readOnly).not.toContain('--dangerously-skip-permissions')
      expect(readOnly).toContain('plan')
      expect(readOnly).toContain('--strict-mcp-config')
      expect(buildCliInvocation('gemini', request({ role }), { geminiPolicyFile: '/tmp/p.toml' }).args).not.toContain('--yolo')
    }
  })
  it('resumes a prior session per CLI and passes native output schemas', () => {
    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
    const claude = buildCliInvocation('claude', request({ role: 'reviewer', resumeSessionId: 'sess-1', outputSchema: schema })).args
    expect(claude.slice(claude.indexOf('--resume'), claude.indexOf('--resume') + 2)).toEqual(['--resume', 'sess-1'])
    expect(claude[claude.indexOf('--json-schema') + 1]).toBe(JSON.stringify(schema))
    const codex = buildCliInvocation('codex', request({ resumeSessionId: 'thread-1' }))
    expect(codex.args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(codex.args).toContain('sandbox_mode="workspace-write"')
    expect(codex.args).not.toContain('--sandbox')
    const roots = ['/repo/front', '/repo/back with spaces']
    expect(buildCliInvocation('codex', request({ allowedRoots: roots, resumeSessionId: 'thread-1' })).args).toContain('sandbox_workspace_write.writable_roots=' + JSON.stringify(roots))
    expect(buildCliInvocation('codex', request({ role: 'reviewer', allowedRoots: roots, resumeSessionId: 'thread-1' })).args).toContain('sandbox_workspace_write.writable_roots=[]')
    expect(codex.args.slice(-2)).toEqual(['thread-1', '-'])
    expect(codex.stdin).toBe(codex.stdin)
    expect(buildCliInvocation('codex', request({ role: 'reviewer' }), { codexSchemaFile: '/tmp/schema.json' }).args).toContain('--output-schema')
    expect(buildCliInvocation('gemini', request({ resumeSessionId: 'g-1' })).args).toContain('g-1')
    expect(buildCliInvocation('kimi', request({ resumeSessionId: 'k-1' })).args).toContain('--session=k-1')
    expect(() => buildCliInvocation('claude', request({ resumeSessionId: '../etc' }))).not.toThrow()
  })
  it.each(['claude', 'codex', 'gemini'] as const)('wires the confined OpenSpec MCP server for %s without changing native source permissions', async provider => {
    const input = request({ role: 'architect' })
    input.openspec = { root: input.cwd, change: 'feature', stateDirectory: input.cwd, cli: '/pinned/openspec.js', skillPath: '/official/SKILL.md', skillHash: 'frozen', role: 'architect' }
    let inspected = false
    const runProcess: CliProcessRunner = async (invocation, options) => {
      if (invocation.args[0] === '--help') return { stdout: '--admin-policy', stderr: '', exitCode: 0 }
      inspected = true
      expect(invocation.stdin).toContain('explicit skill-document adaptation')
      expect(invocation.stdin!.indexOf('Official OpenSpec workflow binding')).toBeLessThan(invocation.stdin!.indexOf(input.prompt))
      if (provider === 'codex') {
        expect(invocation.args).toContain('read-only')
        expect(invocation.args).toContain('mcp_servers.specrails_openspec.default_tools_approval_mode="approve"')
        expect(invocation.args).toContain('mcp_servers.specrails_openspec.required=true')
      } else {
        const file = provider === 'claude' ? invocation.args[invocation.args.indexOf('--mcp-config') + 1]! : options.env!.GEMINI_CLI_SYSTEM_SETTINGS_PATH!
        const configured = JSON.parse(readFileSync(file, 'utf8')).mcpServers.specrails_openspec
        expect(configured.command).toBe(process.execPath)
        expect(JSON.parse(readFileSync(configured.args[1], 'utf8'))).toEqual(input.openspec)
        if (provider === 'claude') {
          expect(invocation.args).toContain('Read,Grep,Glob,ToolSearch,mcp__specrails_openspec__workflow,mcp__specrails_openspec__read_verification_evidence')
          expect(invocation.args).toContain('Read,Grep,Glob,ToolSearch')
          expect(invocation.args).not.toContain('--dangerously-skip-permissions')
        } else {
          const policy = readFileSync(invocation.args[invocation.args.indexOf('--admin-policy') + 1]!, 'utf8')
          expect(policy).toContain('mcpName = "specrails_openspec"')
          expect(policy).toContain('decision = "deny"')
        }
      }
      return { stdout: fixtures[provider], stderr: '', exitCode: 0 }
    }
    await new CliExecutor(provider, { runProcess }).execute(input)
    expect(inspected).toBe(true)
  })

  it('returns Claude structured output and streams tool activity with short details', async () => {
    const stdout = jsonl(
      { type: 'assistant', session_id: 's1', message: { id: 'one', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/repo/src/very/long/path/'.padEnd(200, 'x') + '/file.ts' } }] } },
      { type: 'result', subtype: 'success', session_id: 's1', result: '{"approved":true}', structured_output: { approved: true, summary: 'ok' }, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01 },
    )
    const onEvent = vi.fn()
    const runProcess: CliProcessRunner = async (_invocation, options) => { for (const line of stdout.trim().split('\n')) options.onLine?.(line); return { stdout, stderr: '', exitCode: 0 } }
    const result = await new CliExecutor('claude', { runProcess }).execute(request({ role: 'reviewer', onEvent }))
    expect(result.structured).toEqual({ approved: true, summary: 'ok' })
    expect(result.sessionId).toBe('s1')
    const tool = onEvent.mock.calls.map(call => call[0]).find(event => event.kind === 'tool-start')
    expect(tool.tool).toBe('Read')
    expect(tool.detail.length).toBeLessThanOrEqual(160)
    expect(tool.targetPaths).toEqual(['/repo/src/very/long/path/'.padEnd(200, 'x') + '/file.ts'])
    expect(onEvent.mock.calls.filter(call => call[0].kind === 'text' && call[0].text === '{"approved":true}')).toHaveLength(0)
    expect(cliToolEvents('codex', { type: 'item.started', item: { type: 'command_execution', command: 'npm test' } })).toEqual([{ kind: 'tool-start', tool: 'shell', detail: 'npm test' }])
    expect(cliToolEvents('gemini', { type: 'tool_use', tool_name: 'read_file', parameters: { path: 'a.ts' } })).toEqual([{ kind: 'tool-start', tool: 'read_file', detail: 'a.ts', targetPaths: ['a.ts'] }])
  })
  it('preserves read-only native permissions and Kimi model aliases', () => {
    const input = request({ role: 'reviewer' })
    expect(buildCliInvocation('claude', input).args).toContain('Read,Grep,Glob')
    expect(buildCliInvocation('codex', input).args).toContain('read-only')
    expect(() => buildCliInvocation('gemini', input)).toThrow('--admin-policy')
    expect(buildCliInvocation('gemini', input, { geminiPolicyFile: '/tmp/reviewer.toml' }).args).toContain('plan')
    expect(() => buildCliInvocation('kimi', input)).toThrow('--agent-file')
    const args = buildCliInvocation('kimi', { ...input, model: 'k3' }, { kimiAgentFile: '/tmp/reviewer.md' }).args
    expect(args).toContain('kimi-code/k3')
    expect(args).toContain('--agent-file')
    expect(args).not.toContain('--plan')
  })
  it.each(['claude', 'codex', 'gemini', 'kimi'] as const)('accepts only a valid final %s event and keeps unknown cost unknown', async provider => {
    const runProcess = vi.fn<CliProcessRunner>(async () => ({ stdout: fixtures[provider], stderr: '', exitCode: 0 }))
    const result = await new CliExecutor(provider, { runProcess }).execute(request())
    expect(result.text).toBe('done')
    expect(result.usage.costUsd).toBe(provider === 'claude' ? 0.1 : null)
    if (provider === 'kimi') expect(result.usage.inputTokens).toBeNull()
  })
  it('deduplicates Claude assistant usage and includes cache input without treating internal notifications as completion', () => {
    const assistant = { type: 'assistant', message: { id: 'one', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } } }
    const partial = parseCliOutput('claude', jsonl(assistant, assistant, { type: 'result', origin: { kind: 'task-notification' }, result: '', usage: { input_tokens: 0, output_tokens: 0 } }))
    expect(partial.terminal).toBe(false)
    expect(partial.usage).toEqual({ inputTokens: 20, outputTokens: 3, costUsd: null, uncachedInputTokens: 10, cacheReadInputTokens: 8, cacheWriteInputTokens: 2 })
  })
  it('keeps Gemini progress in events and returns only the chunked final assistant turn after tools', async () => {
    const stdout = readFileSync(new URL('./__fixtures__/gemini-review.jsonl', import.meta.url), 'utf8')
    const onEvent = vi.fn()
    const runProcess: CliProcessRunner = async (invocation, options) => {
      if (invocation.args[0] === '--help') return { stdout: '--admin-policy <path>', stderr: '', exitCode: 0 }
      for (const line of stdout.trim().split('\n')) options.onLine?.(line)
      return { stdout, stderr: '', exitCode: 0 }
    }
    const result = await new CliExecutor('gemini', { runProcess }).execute(request({ role: 'reviewer', onEvent }))
    expect(result.structured).toEqual({ approved: true, summary: 'Verified source' })
    expect(result.text).toBe('{"approved":true,"summary":"Verified source"}')
    expect(onEvent).toHaveBeenCalledWith({ kind: 'text', text: 'I will inspect ' })
    expect(onEvent).toHaveBeenCalledWith({ kind: 'text', text: 'the source first.' })
  })
  it.each(['claude', 'codex', 'kimi'] as const)('keeps the final %s response separate from earlier assistant/tool turns', provider => {
    const final = '{"approved":true}'
    const streams = {
      claude: jsonl({ type: 'assistant', message: { id: 'one', content: [{ type: 'text', text: 'Inspecting source.' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'source.ts' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'source' }] } }, { type: 'assistant', message: { id: 'two', content: [{ type: 'text', text: final }] } }, { type: 'result', subtype: 'success', result: final }),
      codex: jsonl({ type: 'item.completed', item: { id: 'one', type: 'agent_message', text: 'Inspecting source.' } }, { type: 'item.completed', item: { id: 'two', type: 'command_execution', command: 'read source', exit_code: 0 } }, { type: 'item.completed', item: { id: 'three', type: 'agent_message', text: final } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
      kimi: jsonl({ role: 'assistant', content: 'Inspecting source.', tool_calls: [{ id: 'read', type: 'function', function: { name: 'Read', arguments: '{"path":"source.ts"}' } }] }, { role: 'tool', tool_call_id: 'read', content: 'source' }, { role: 'assistant', content: [{ type: 'text', text: final }] }, { role: 'meta', type: 'session.resume_hint', session_id: 'kimi-review' }),
    }
    expect(parseCliOutput(provider, streams[provider])).toMatchObject({ text: final, structured: { approved: true }, terminal: true, failed: false })
  })
  it.each(['claude', 'codex', 'gemini', 'kimi'] as const)('does not convert missing terminal output or provider failure into %s success', async provider => {
    const runProcess = vi.fn<CliProcessRunner>(async () => ({ stdout: '{}\n', stderr: 'secret-provider-details', exitCode: 0 }))
    await expect(new CliExecutor(provider, { runProcess }).execute(request())).rejects.toMatchObject({ code: 'incomplete_response' })
    runProcess.mockResolvedValue({ stdout: fixtures[provider], stderr: 'secret-provider-details', exitCode: 1 })
    await expect(new CliExecutor(provider, { runProcess }).execute(request())).rejects.toMatchObject({ code: 'provider_execution_error' })
  })
  it.each([
    ['error_max_turns', 'max_turns', 'limit of 100 turns'],
    ['error_max_budget_usd', 'cost_budget', 'cost budget'],
    ['error_max_structured_output_retries', 'structured_output_retries', 'structured output retries'],
  ])('preserves Claude termination reason %s and billed usage', async (subtype, code, message) => {
    const runProcess = vi.fn<CliProcessRunner>(async () => ({ stdout: jsonl({ type: 'result', subtype, is_error: true, total_cost_usd: 2.422, usage: { input_tokens: 100, output_tokens: 20 } }), stderr: 'secret-provider-details', exitCode: 1 }))
    await expect(new CliExecutor('claude', { runProcess }).execute(request())).rejects.toMatchObject({ code, message: expect.stringContaining(message), usage: { costUsd: 2.422 } })
  })
  it('probes Kimi capability without billing and uses a disposable enforced read-only agent when available', async () => {
    const runProcess = vi.fn<CliProcessRunner>(async invocation => {
      if (invocation.args[0] === '--help') return { stdout: '--agent-file <path>', stderr: '', exitCode: 0 }
      const file = invocation.args[invocation.args.indexOf('--agent-file') + 1]
      expect(readFileSync(file, 'utf8')).toContain('tools:\n  - Read\n  - Grep\n  - Glob\nsubagents: []')
      return { stdout: fixtures.kimi, stderr: '', exitCode: 0 }
    })
    expect((await new CliExecutor('kimi', { runProcess }).execute(request({ role: 'reviewer' }))).text).toBe('done')
    expect(runProcess).toHaveBeenCalledTimes(2)
    runProcess.mockResolvedValue({ stdout: '--prompt <prompt>', stderr: '', exitCode: 0 })
    await expect(new CliExecutor('kimi', { runProcess }).execute(request({ role: 'architect' }))).rejects.toMatchObject({ code: 'incomplete_response' })
    expect(runProcess.mock.calls.at(-1)?.[0]).toEqual({ command: 'kimi', args: ['acp'] })
  })
  it('requires Gemini admin policy support before a read-only model invocation', async () => {
    const runProcess = vi.fn<CliProcessRunner>(async () => ({ stdout: '--approval-mode plan', stderr: '', exitCode: 0 }))
    await expect(new CliExecutor('gemini', { runProcess }).execute(request({ role: 'architect' }))).rejects.toMatchObject({ code: 'provider_capability_unsupported' })
    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(runProcess.mock.calls[0][0]).toEqual({ command: 'gemini', args: ['--help'] })
  })
  it.each([false, true])('retains the Gemini policy until the child settles, then cleans it (cancelled=%s)', async cancelled => {
    const input = request({ role: 'reviewer' }), controller = new AbortController()
    let policyFile = '', markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const runProcess: CliProcessRunner = async invocation => {
      if (invocation.args[0] === '--help') return { stdout: '--admin-policy <path>', stderr: '', exitCode: 0 }
      policyFile = invocation.args[invocation.args.indexOf('--admin-policy') + 1]
      expect(readFileSync(policyFile, 'utf8')).toBe(GEMINI_READONLY_POLICY)
      markStarted()
      await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => {
        expect(existsSync(policyFile)).toBe(true)
        resolve()
      }, { once: true }))
      if (cancelled) throw new Error('fixture child terminated')
      return { stdout: fixtures.gemini, stderr: '', exitCode: 0 }
    }
    const running = new CliExecutor('gemini', { runProcess }).execute({ ...input, signal: controller.signal })
    await started
    controller.abort()
    if (cancelled) await expect(running).rejects.toThrow('fixture child terminated')
    else await running
    expect(existsSync(policyFile)).toBe(false)
  })
  it('rejects unsupported strict USD caps before invoking providers and passes the Claude native cap', async () => {
    const runProcess = vi.fn<CliProcessRunner>()
    for (const provider of ['codex', 'gemini', 'kimi'] as const) await expect(new CliExecutor(provider, { runProcess }).execute(request({ maxCostUsd: 1 }))).rejects.toMatchObject({ code: 'cost_limit_unsupported' })
    expect(runProcess).not.toHaveBeenCalled()
    expect(buildCliInvocation('claude', request({ maxCostUsd: 1 })).args).toContain('--max-budget-usd')
  })
  it('stops a provider that exceeds its observable tool/turn limit', async () => {
    const runProcess = vi.fn<CliProcessRunner>(async (_invocation, options) => {
      options.onLine?.('{"role":"assistant","content":"first"}')
      options.onLine?.('{"role":"assistant","content":"second"}')
      return { stdout: fixtures.kimi, stderr: '', exitCode: 0 }
    })
    await expect(new CliExecutor('kimi', { runProcess }).execute(request({ maxTurns: 1 }))).rejects.toMatchObject({ code: 'max_turns' })
  })
})
describe('portable child process transport', () => {
  it('transports Kimi Windows npm prompts over stdin without cmd.exe or escaping changes', () => {
    const input = request(), invocation = buildCliInvocation('kimi', input)
    const launched = windowsKimiInvocation(invocation, {
      env: { Path: 'C:\\Program Files\\nodejs' }, node: 'C:\\Program Files\\nodejs\\node.exe',
      exists: file => file.endsWith('kimi.cmd'), read: () => '"%dp0%\\node_modules\\kimi-code\\cli.js" %*',
    })
    expect(launched.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(launched.args).toContain('C:\\Program Files\\nodejs\\node_modules\\kimi-code\\cli.js')
    expect(launched.args).not.toContain(input.prompt)
    expect(launched.stdin).toBe(input.prompt)
  })
  it('rejects non-standard Windows shell wrappers', () => {
    expect(() => windowsKimiInvocation(buildCliInvocation('kimi', request()), { env: { PATH: 'C:\\bin' }, exists: file => file.endsWith('kimi.cmd'), read: () => '@echo off\nkimi %*' })).toThrow('Unsupported Kimi Windows shim')
  })
  it('normalizes Windows env keys and preserves the actual system directory', () => {
    expect(cliProcessEnvironment({ SYSTEMROOT: 'D:\\Win', ComSpec: 'D:\\Win\\System32\\cmd.exe', CLAUDECODE: '1' }, 'win32')).toEqual({ SystemRoot: 'D:\\Win', windir: 'D:\\Win', ComSpec: 'D:\\Win\\System32\\cmd.exe' })
  })
  it.each([
    { Path: 'C:\\old', PATH: 'C:\\new' },
    { PATH: 'C:\\old', Path: 'C:\\new' },
  ])('uses the last Windows PATH overlay consistently for Kimi and child spawning', original => {
    const env = cliProcessEnvironment(original, 'win32')
    expect(Object.keys(env).filter(key => key.toLowerCase() === 'path')).toEqual(['PATH'])
    expect(env.PATH).toBe('C:\\new')
    const launched = windowsKimiInvocation(buildCliInvocation('kimi', request()), {
      env, exists: file => file === 'C:\\new\\kimi.exe',
    })
    expect(launched.command).toBe('C:\\new\\kimi.exe')
  })
  it('preserves UTF-8 stdin and multiline arguments for real native children in a path with spaces', async () => {
    const input = request()
    const output = await runCliProcess({ command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], stdin: input.prompt + '\n¡hola! 日本語' }, { cwd: input.cwd, timeoutMs: 5000 })
    expect(output).toMatchObject({ exitCode: 0, stdout: input.prompt + '\n¡hola! 日本語' })
  })
  it('waits for a hung owned child to terminate on timeout and cancellation', async () => {
    const input = request(), invocation = { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }
    await expect(runCliProcess(invocation, { cwd: input.cwd, timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' })
    const controller = new AbortController()
    const pending = runCliProcess(invocation, { cwd: input.cwd, timeoutMs: 5000, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  })
})
