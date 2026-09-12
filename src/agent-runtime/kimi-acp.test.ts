import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeKimiReadonlyAcp } from './kimi-acp.js'
import { CliExecutor } from './cli-executor.js'
import { runCliProcess, type CliProcessRunner } from './cli-process.js'
import type { AgentRequest } from './executor-types.js'

const temporary: string[] = []
function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const cwd = mkdtempSync(path.join(tmpdir(), 'specrails-acp-')); temporary.push(cwd)
  writeFileSync(path.join(cwd, 'source.ts'), 'export const value = 42\n')
  return { role: 'reviewer', cwd, allowedRoots: [cwd], prompt: 'Return the review JSON', model: 'k3', ...overrides }
}
afterEach(() => { for (const cwd of temporary.splice(0)) rmSync(cwd, { recursive: true, force: true }) })
interface HarnessOptions { permissionTitle?: string; mode?: string; fail?: string; operation?: string; path?: string; changesMode?: boolean; stopReason?: string; toolCalls?: number; multipleRoots?: boolean; responseFixture?: string }
function harness(input: AgentRequest, options: HarnessOptions = {}): { runProcess: CliProcessRunner; messages: Record<string, unknown>[] } {
  const messages: Record<string, unknown>[] = []
  const runProcess: CliProcessRunner = async (_invocation, settings) => {
    let completed = false, promptId: unknown
    const receive = (value: unknown): void => settings.onLine?.(JSON.stringify({ jsonrpc: '2.0', ...value as Record<string, unknown> }))
    const finish = (): void => {
      if (options.responseFixture) {
        for (const line of options.responseFixture.trim().split('\n')) settings.onLine?.(line)
        receive({ id: promptId, result: { stopReason: options.stopReason ?? 'end_turn' } })
        return
      }
      if (options.changesMode) receive({ method: 'session/update', params: { sessionId: 'test-session', update: { sessionUpdate: 'current_mode_update', currentModeId: 'auto' } } })
      for (let i = 0; i < (options.toolCalls ?? 0); i++) receive({ method: 'session/update', params: { sessionId: 'test-session', update: { sessionUpdate: 'tool_call', toolCallId: String(i), title: 'Read file' } } })
      receive({ method: 'session/update', params: { sessionId: 'test-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"approved":' } } } })
      receive({ method: 'session/update', params: { sessionId: 'test-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'true}' } } } })
      receive({ id: promptId, result: { stopReason: options.stopReason ?? 'end_turn' } })
    }
    settings.duplex?.({
      complete: () => { completed = true },
      send: line => {
        const message = JSON.parse(line) as Record<string, unknown>; messages.push(message)
        const params = message.params as Record<string, unknown> | undefined
        if (message.id === 'reverse-request') { finish(); return }
        if (options.fail === message.method) { receive({ id: message.id, error: { code: -32603, message: 'must-not-echo-secret' } }); return }
        switch (message.method) {
          case 'initialize': receive({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: '0.27.0' }, agentCapabilities: { sessionCapabilities: options.multipleRoots ? { additionalDirectories: {} } : {} } } }); break
          case 'session/new': receive({ id: message.id, result: { sessionId: 'test-session', configOptions: [{ id: 'mode', currentValue: 'default', options: [{ value: options.mode ?? 'plan', name: 'Plan' }] }] } }); break
          case 'session/set_mode': expect(params?.modeId).toBe(input.role === 'developer' ? 'auto' : 'plan'); receive({ id: message.id, result: {} }); break
          case 'session/set_config_option': expect(params).toMatchObject({ configId: 'model', value: 'kimi-code/k3' }); receive({ id: message.id, result: {} }); break
          case 'session/prompt': {
            promptId = message.id
            expect(params?.prompt).toEqual([{ type: 'text', text: input.prompt }])
            const operation = options.operation ?? 'fs/read_text_file'
            const reverseParams = operation === 'session/request_permission'
              ? { toolCall: { title: options.permissionTitle, kind: 'edit', rawInput: { path: path.join(input.cwd, 'source.ts') } }, options: [{ kind: 'allow_once', optionId: 'allow' }] }
              : { path: options.path ?? path.join(input.cwd, 'source.ts') }
            receive({ id: 'reverse-request', method: operation, params: { sessionId: 'test-session', ...reverseParams } })
            break
          }
        }
      },
    })
    return { exitCode: completed ? 0 : 1, stdout: '', stderr: '' }
  }
  return { runProcess, messages }
}
describe('Kimi 0.27 read-only ACP compatibility', () => {
  it('negotiates observed 0.27 mode options before prompting and serves scoped source reads', async () => {
    const input = request(), fake = harness(input)
    const result = await executeKimiReadonlyAcp(input, fake)
    expect(fake.messages.filter(message => message.method).map(message => message.method)).toEqual(['initialize', 'session/new', 'session/set_mode', 'session/set_config_option', 'session/prompt'])
    expect(fake.messages.find(message => message.id === 'reverse-request')?.result).toEqual({ content: 'export const value = 42\n' })
    expect(result).toMatchObject({ structured: { approved: true }, usage: { inputTokens: null, outputTokens: null, costUsd: null } })
  })
  it('forwards the fixed OpenSpec server and approves only its exact tool during a plan role', async () => {
    const input = request({ role: 'architect' })
    const fake = harness(input, { operation: 'session/request_permission', permissionTitle: 'mcp__specrails_openspec__workflow' })
    const bridge = { command: process.execPath, args: ['/runtime/openspec-tool-server.js', '/runtime/context.json'] }
    await executeKimiReadonlyAcp(input, { ...fake, openspecBridge: bridge })
    expect(fake.messages.find(item => item.method === 'session/new')?.params).toMatchObject({ mcpServers: [{ name: 'specrails_openspec', ...bridge, env: [] }] })
    expect(fake.messages.find(item => item.id === 'reverse-request')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await expect(executeKimiReadonlyAcp(input, { ...harness(input, { operation: 'session/request_permission', permissionTitle: 'mcp__other__workflow' }), openspecBridge: bridge })).rejects.toMatchObject({ code: 'tool_policy_violation' })
  })
  it('admits developer ACP auto mode with the same scoped OpenSpec server', async () => {
    const input = request({ role: 'developer' })
    const fake = harness(input, { mode: 'auto', operation: 'session/request_permission' })
    await executeKimiReadonlyAcp(input, { ...fake, openspecBridge: { command: process.execPath, args: ['/bridge.js'] } })
    expect(fake.messages.find(item => item.method === 'initialize')?.params).toMatchObject({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  })
  it('automatically chooses ACP for old Kimi after a nonbilling help probe', async () => {
    const input = request(), fake = harness(input)
    const runProcess = vi.fn<CliProcessRunner>(async (invocation, settings) => invocation.args[0] === '--help' ? { stdout: '--prompt <prompt>', stderr: '', exitCode: 0 } : fake.runProcess(invocation, settings))
    expect((await new CliExecutor('kimi', { runProcess }).execute(input)).structured).toEqual({ approved: true })
    expect(runProcess.mock.calls.map(call => call[0].args)).toEqual([['--help'], ['acp']])
  })
  it('streams Kimi ACP progress while preserving only the final JSON after tool calls', async () => {
    const onEvent = vi.fn(), input = request({ onEvent })
    const responseFixture = readFileSync(new URL('./__fixtures__/kimi-acp-review.jsonl', import.meta.url), 'utf8')
    const result = await executeKimiReadonlyAcp(input, harness(input, { responseFixture }))
    expect(result.structured).toEqual({ approved: true, summary: 'Verified source' })
    expect(result.text).toBe('{"approved":true,"summary":"Verified source"}')
    expect(onEvent).toHaveBeenCalledWith({ kind: 'text', text: 'I will inspect the source first.' })
    expect(onEvent).toHaveBeenCalledWith({ kind: 'tool-start', tool: 'Read source.ts', detail: 'source.ts', targetPaths: ['source.ts'] })
  })
  it.each(['fs/write_text_file', 'terminal/create', 'session/request_permission'])('denies %s and refuses to certify a result after a forbidden attempt', async operation => {
    const input = request(), fake = harness(input, { operation })
    await expect(executeKimiReadonlyAcp(input, fake)).rejects.toMatchObject({ code: 'tool_policy_violation' })
    const reply = fake.messages.find(message => message.id === 'reverse-request')
    expect(operation === 'session/request_permission' ? reply?.result : reply?.error).toBeDefined()
  })
  it('rejects reads outside the frozen roots, absent plan modes and mode escape', async () => {
    const input = request()
    await expect(executeKimiReadonlyAcp(input, harness(input, { path: path.join(input.cwd, '..', 'secret') }))).rejects.toMatchObject({ code: 'tool_policy_violation' })
    await expect(executeKimiReadonlyAcp(input, harness(input, { mode: 'auto' }))).rejects.toMatchObject({ code: 'provider_capability_unsupported' })
    await expect(executeKimiReadonlyAcp(input, harness(input, { changesMode: true }))).rejects.toMatchObject({ code: 'tool_policy_violation' })
  })
  it('rejects provider errors, incomplete stops and exhausted tools', async () => {
    const input = request({ maxTurns: 1 })
    await expect(executeKimiReadonlyAcp(input, harness(input, { fail: 'session/set_mode' }))).rejects.toMatchObject({ code: 'provider_execution_error' })
    await expect(executeKimiReadonlyAcp(input, harness(input, { stopReason: 'max_tokens' }))).rejects.toMatchObject({ code: 'incomplete_response' })
    await expect(executeKimiReadonlyAcp(input, harness(input, { toolCalls: 2 }))).rejects.toMatchObject({ code: 'max_turns' })
  })
  it('gates additional directories by native capability rather than silently ignoring scope', async () => {
    const other = request(), input = request({ allowedRoots: [] })
    input.allowedRoots = [input.cwd, other.cwd]
    await expect(executeKimiReadonlyAcp(input, harness(input))).rejects.toMatchObject({ code: 'provider_capability_unsupported' })
    expect((await executeKimiReadonlyAcp(input, harness(input, { multipleRoots: true }))).structured).toEqual({ approved: true })
  })
  it('rejects unavailable usage caps before launching an ACP process', async () => {
    const runProcess = vi.fn<CliProcessRunner>()
    await expect(executeKimiReadonlyAcp(request({ maxTokens: 500 }), { runProcess })).rejects.toMatchObject({ code: 'usage_unavailable' })
    expect(runProcess).not.toHaveBeenCalled()
  })
  it('transports real newline JSON-RPC frames and terminates the persistent child after completion', async () => {
    const input = request(), fixture = path.join(input.cwd, 'acp-server.cjs')
    writeFileSync(fixture, `const readline=require('node:readline');const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});else if(m.method==='session/new')send({id:m.id,result:{sessionId:'s',configOptions:[{id:'mode',options:[{value:'plan'}]}]}});else if(m.method==='session/set_mode'||m.method==='session/set_config_option')send({id:m.id,result:{}});else if(m.method==='session/prompt'){send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"approved":true}'}}}});send({id:m.id,result:{stopReason:'end_turn'}})}});setInterval(()=>{},1000);`)
    const runProcess: CliProcessRunner = (_invocation, settings) => runCliProcess({ command: process.execPath, args: [fixture] }, settings)
    expect((await executeKimiReadonlyAcp(input, { runProcess })).structured).toEqual({ approved: true })
  })
})
