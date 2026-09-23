import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCoreWorkflow } from './core-host.js'
import { createExecutorRegistry } from './executors.js'
import { validateRuntimeConfig } from './config.js'
import { OpenAICompatibleExecutor } from './openai-executor.js'
import { buildCliInvocation } from './cli-executor.js'
import { roleInstructions } from './prompts.js'
import { openSpecPrompt, type OpenSpecRoleContext } from './openspec.js'
import type { AgentEvent, AgentEventRole, AgentRequest, RuntimeConfig } from './executor-types.js'
import { compactMessages, estimateTokens, validateToolArguments } from './compact/guarded-loop.js'
import { extractPromptInputs } from './compact/prompt-inputs.js'
import { parseTaskGroups, tickTasks, writtenFiles } from './compact/developer.js'
import { coverCriteria, criterionTokens, dedupeSpecRequirements, hasBinaryAssets, renderSpec, renderTasks, validateTaskPlan } from './compact/architect.js'
import { inspectPipeline, type PipelineContext } from '../installer/runtime/pipeline-state.js'

type Body = { model?: string; messages: Record<string, unknown>[]; tools?: unknown[]; response_format?: Record<string, unknown> }
const provider = { id: 'local', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:9/v1' }
const usage = { prompt_tokens: 10, completion_tokens: 2 }
function reply(message: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? { choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }], usage } : { error: { message: 'unsupported' } }), { status, headers: { 'Content-Type': 'application/json' } })
}
function call(name: string, args: Record<string, unknown>, id = `${name}-${Math.random().toString(36).slice(2, 8)}`): Record<string, unknown> {
  return { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}
function last(body: Body, role: string): string {
  const message = [...body.messages].reverse().find(item => item.role === role)
  return typeof message?.content === 'string' ? message.content : ''
}
function system(body: Body): string { return String(body.messages[0]?.content ?? '') }
const temporary: string[] = []
function readdirArchive(artifactRoot: string): string[] {
  const archive = path.join(artifactRoot, 'openspec', 'changes', 'archive')
  const entry = readdirSync(archive).find(name => name.includes('compact-feature'))
  if (!entry) throw new Error('archived change not found')
  return [entry]
}
function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const root = mkdtempSync(path.join(tmpdir(), 'specrails-compact-')); temporary.push(root)
  return { role: 'developer', cwd: root, allowedRoots: [root], prompt: 'Implement the requested task', model: 'small', maxTurns: 12, ...overrides }
}
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('small-model configuration', () => {
  const base = (): RuntimeConfig => ({ schemaVersion: 1, enabled: true, providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }], agents: { architect: { provider: 'local', model: 'm' }, developer: { provider: 'local', model: 'm' }, reviewer: { provider: 'local', model: 'm' } }, verification: [] })
  it('accepts agentLoop and contextWindowTokens losslessly and defaults them at use time', () => {
    const value = base()
    expect(validateRuntimeConfig(value).providers[0]).toEqual({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' })
    expect(new OpenAICompatibleExecutor(provider).capabilities()).toMatchObject({ agentLoop: 'compact', contextWindowTokens: 32768 })
    value.providers[0] = { id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', agentLoop: 'free', contextWindowTokens: 8192 }
    expect(validateRuntimeConfig(value).providers[0]).toEqual(value.providers[0])
    expect(new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free', contextWindowTokens: 8192 }).capabilities()).toMatchObject({ agentLoop: 'free', contextWindowTokens: 8192 })
    value.providers[0] = { id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', maxOutputTokens: 12288 }
    expect(validateRuntimeConfig(value).providers[0]).toEqual(value.providers[0])
    // Per-role thinking switch.
    const roles = { ...base(), agents: { ...base().agents, developer: { provider: 'local', model: 'm', thinking: 'on' as const } } }
    expect(validateRuntimeConfig(roles).agents.developer.thinking).toBe('on')
    expect(() => validateRuntimeConfig({ ...base(), agents: { ...base().agents, developer: { provider: 'local', model: 'm', thinking: 'maybe' } } } as unknown as RuntimeConfig)).toThrow(/thinking/)
  })
  it.each([
    { agentLoop: 'loose' }, { contextWindowTokens: 4095 }, { contextWindowTokens: 8192.5 }, { contextWindowTokens: '32768' }, { maxOutputTokens: 1023 }, { maxOutputTokens: '8192' },
  ])('rejects invalid loop settings %j', extra => {
    const value = base()
    value.providers[0] = { ...value.providers[0]!, ...extra } as RuntimeConfig['providers'][number]
    expect(() => validateRuntimeConfig(value)).toThrow('Invalid runtime config providers[0]')
  })
  it('rejects the fields on CLI providers', () => {
    const value = base()
    value.providers = [{ id: 'local', kind: 'cli', cli: 'claude', agentLoop: 'compact' } as unknown as RuntimeConfig['providers'][number]]
    expect(() => validateRuntimeConfig(value)).toThrow('providers[0].agentLoop: unknown field')
  })
  it('matches the JSON schema', () => {
    const schema = JSON.parse(readFileSync(new URL('../../schemas/agent-runtime.schema.json', import.meta.url), 'utf8'))
    const api = schema.properties.providers.items.oneOf[1].properties
    expect(api.agentLoop.enum).toEqual(['compact', 'free'])
    expect(api.contextWindowTokens).toMatchObject({ type: 'integer', minimum: 4096 })
  })
})

describe('executor guardrails for OpenAI-compatible endpoints', () => {
  it('answers a placeholder search query and a misused openspec action with one correct example', () => {
    const available = new Set(['search_text', 'openspec_workflow', 'read_file'])
    expect(validateToolArguments('search_text', '{"path":".","query":"."}', available)).toMatchObject({ error: expect.stringContaining('{"path":".","query":"functionName"}') })
    expect(validateToolArguments('search_text', '{"path":".","query":"handleRequest"}', available)).toEqual({ args: { path: '.', query: 'handleRequest' } })
    expect(validateToolArguments('openspec_workflow', '{"action":"proposal.md"}', available)).toMatchObject({ error: expect.stringContaining('{"action":"instructions","artifact":"proposal"}') })
    expect(validateToolArguments('read_file', 'not json', available)).toMatchObject({ error: expect.stringContaining('JSON object') })
    expect(validateToolArguments('write_file', '{"path":"a"}', available)).toMatchObject({ error: expect.stringContaining('unavailable') })
  })
  it('compacts the oldest tool results while protecting system, user and the last four messages', () => {
    const big = 'x'.repeat(6000)
    const calls = new Map([['t1', { name: 'read_file', args: '{"path":"a.ts"}' }], ['t2', { name: 'read_file', args: '{"path":"b.ts"}' }]])
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }, { role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', tool_call_id: 't1', content: big }, { role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', tool_call_id: 't2', content: big }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }]
    expect(compactMessages(messages, 4096, calls)).toBe(1)
    expect(messages[3]!.content).toMatch(/^\[compacted: read_file \{"path":"a\.ts"\} → x{120}\]$/)
    expect(messages[5]!.content).toBe(big)
    expect(estimateTokens(messages)).toBeLessThan(0.7 * 4096)
  })
  it('rejects a third consecutive identical call and aborts the step with tool_loop — on the fifth for a write-shaped tool, the eighth for a read', async () => {
    const sent: Body[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => { sent.push(JSON.parse(options!.body as string)); return reply(call('list_files', { path: '.' }, `list-${sent.length}`)) })
    await expect(new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch }).execute(request())).rejects.toMatchObject({ code: 'tool_loop' })
    expect(sent).toHaveLength(8)
    const results = sent[4]!.messages.filter(message => message.role === 'tool').map(message => String(message.content))
    expect(results[0]).toContain('"entries"')
    expect(results[2]).toContain('identical call repeated')
    expect(sent[4]!.messages.filter(message => message.role === 'assistant').every(message => message.content === '')).toBe(true)
    sent.length = 0
    const patching = vi.fn<typeof globalThis.fetch>(async (_url, options) => { sent.push(JSON.parse(options!.body as string)); return reply(call('apply_patch', { path: 'a.js', oldText: 'x', newText: 'y' }, `patch-${sent.length}`)) })
    await expect(new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch: patching }).execute(request())).rejects.toMatchObject({ code: 'tool_loop' })
    expect(sent).toHaveLength(5)
  })
  it('grants a write-only extension when the tool budget was spent on reads alone, then closes the budget for good', async () => {
    const { runToolLoop } = await import('./compact/guarded-loop.js')
    const { ChatClient } = await import('./compact/chat-client.js')
    const sent: Body[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      const body = JSON.parse(options!.body as string) as Body
      sent.push(body)
      const n = sent.length
      const names = (body.tools ?? []).map(tool => String((tool as { function?: { name?: string } }).function?.name))
      // Reads until the budget is gone; then, offered only write tools, writes once; then replies.
      if (names.includes('read_file')) return reply(call('read_file', { path: `f${n}.js` }, `r${n}`))
      if (names.includes('write_file')) return reply(call('write_file', { path: 'out.js', content: 'ok' }, `w${n}`))
      return reply({ content: 'done' })
    })
    const client = new ChatClient({ endpoint: new URL('http://127.0.0.1:9/v1/chat/completions'), headers: {}, fetch, signal: new AbortController().signal, model: 'm' })
    const events: string[] = []
    const written: string[] = []
    const result = await runToolLoop({
      client, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], maxTurns: 20, maxToolCalls: 3, contextWindowTokens: 32768,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }, { type: 'function', function: { name: 'write_file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }],
      writeExtension: { tools: ['write_file'], extraCalls: 2 }, signal: new AbortController().signal,
      onEvent: event => { if (event.kind === 'text') events.push(event.text ?? '') },
      execute: async (name, args) => { if (name === 'write_file') written.push(String(args.path)); return JSON.stringify({ ok: true, name }) },
    })
    expect(result.text).toBe('done')
    expect(written, sent.map(body => (body.tools ?? []).map(tool => String((tool as { function?: { name?: string } }).function?.name)).join(',')).join(' | ')).toEqual(['out.js', 'out.js'])
    expect(events.some(text => text.startsWith('Tool budget spent on reads alone; granting 2 extra calls restricted to write_file'))).toBe(true)
    // Turns 1–3 offered read+write, the two extension turns offered write only, the final turn offered no tools.
    const offered = sent.map(body => (body.tools ?? []).map(tool => String((tool as { function?: { name?: string } }).function?.name)).join(','))
    expect(offered.slice(0, 3)).toEqual(['read_file,write_file', 'read_file,write_file', 'read_file,write_file'])
    expect(offered[3]).toBe('write_file')
    expect(offered[4]).toBe('write_file')
    expect(offered[5]).toBe('')
  })
  it('refuses the third consecutive whole-file rewrite of one path (reads of it in between allowed), never patches or other files', async () => {
    const sent: Body[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      const body = JSON.parse(options!.body as string) as Body
      sent.push(body)
      const n = sent.length
      if (n === 1) return reply(call('write_file', { path: 'gen.js', content: 'v1' }, 'w1'))
      if (n === 2) return reply(call('read_lines', { path: 'gen.js', startLine: 1, endLine: 5 }, 'r1'))
      if (n === 3) return reply(call('write_file', { path: 'gen.js', content: 'v2' }, 'w2'))
      if (n === 4) return reply(call('write_file', { path: 'gen.js', content: 'v3' }, 'w3'))
      if (n === 5) return reply(call('write_file', { path: 'other.js', content: 'x' }, 'w4'))
      if (n === 6) return reply(call('apply_patch', { path: 'other.js', oldText: 'x', newText: 'y' }, 'p1'))
      if (n === 7) return reply(call('apply_patch', { path: 'other.js', oldText: 'y', newText: 'z' }, 'p2'))
      if (n === 8) return reply(call('apply_patch', { path: 'other.js', oldText: 'z', newText: 'w' }, 'p3'))
      return reply({ content: 'done' })
    })
    const req = request()
    const result = await new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch }).execute(req)
    expect(result.text).toBe('done')
    const tools = sent.at(-1)!.messages.filter(message => message.role === 'tool').map(message => String(message.content))
    expect(tools[0]).not.toContain('rewritten')
    expect(tools[2]).not.toContain('rewritten')
    expect(tools[3], JSON.stringify(tools)).toContain("rewritten 3 times in a row")
    expect(readFileSync(path.join(req.cwd, 'gen.js'), 'utf8')).toBe('v2')
    expect(tools.slice(4).every(text => !text.includes('rewritten'))).toBe(true)
    expect(readFileSync(path.join(req.cwd, 'other.js'), 'utf8')).toBe('w')
  })
  it('answers a repeated read of unchanged content with a pointer instead of the bytes, and with the bytes again once the file changed', async () => {
    const sent: Body[] = []
    const big = 'x'.repeat(2000)
    const req = request()
    writeFileSync(path.join(req.cwd, 'big.js'), big)
    const events: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      const body = JSON.parse(options!.body as string) as Body
      sent.push(body)
      const n = sent.length
      if (n === 1) return reply(call('read_file', { path: 'big.js' }, 'r1'))
      if (n === 2) return reply(call('list_files', { path: '.' }, 'l1'))
      if (n === 3) return reply(call('read_file', { path: 'big.js' }, 'r2'))
      if (n === 4) { writeFileSync(path.join(req.cwd, 'big.js'), big + 'changed'); return reply(call('read_file', { path: 'big.js' }, 'r3')) }
      return reply({ content: 'done' })
    })
    const result = await new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch }).execute({ ...req, onEvent: event => { if (event.kind === 'text') events.push(event.text ?? '') } })
    expect(result.text).toBe('done')
    const tools = sent[4]!.messages.filter(message => message.role === 'tool').map(message => String(message.content))
    expect(tools[0]).toContain(big.slice(0, 50))
    expect(tools[2]).toContain('"unchanged":true')
    expect(tools[2]).toContain('still above')
    expect(tools[3]).toContain('changed')
    expect(events.some(text => text.startsWith('Read cache: 1 repeated read'))).toBe(true)
  })
  it('nudges once after an empty final reply, then fails', async () => {
    const sent: Body[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => { sent.push(JSON.parse(options!.body as string)); return reply({ content: sent.length === 1 ? '' : '{"done":true}' }) })
    const result = await new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch }).execute(request())
    expect(result.structured).toEqual({ done: true })
    expect(last(sent[1]!, 'user')).toContain('Reply with the final result now')
    const empty = vi.fn<typeof globalThis.fetch>(async () => reply({ content: '' }))
    await expect(new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch: empty }).execute(request())).rejects.toMatchObject({ code: 'invalid_response' })
    expect(empty).toHaveBeenCalledTimes(2)
  })
  it('compacts old tool results in the free loop once the window budget is exceeded', async () => {
    const input = request()
    writeFileSync(path.join(input.cwd, 'big.txt'), 'line\n'.repeat(3000))
    const sent: Body[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      const body = JSON.parse(options!.body as string) as Body
      sent.push(body)
      return sent.length <= 3 ? reply(call('read_file', { path: sent.length === 2 ? './big.txt' : sent.length === 3 ? 'big.txt' : '././big.txt' }, `r${sent.length}`)) : reply({ content: 'done' })
    })
    await new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free', contextWindowTokens: 4096 }, { fetch }).execute(input)
    const tools = sent[3]!.messages.filter(message => message.role === 'tool')
    expect(tools[0]!.content).toMatch(/^\[compacted: read_file/)
    expect(sent[3]!.messages.some(message => 'compacted' in message)).toBe(false)
  })
  it('runs the guarded free loop when compact mode has no OpenSpec workflow to drive', async () => {
    const sent: Body[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => { sent.push(JSON.parse(options!.body as string)); return reply({ content: '{"implemented":true}' }) })
    const result = await new OpenAICompatibleExecutor(provider, { fetch }).execute(request())
    expect(result.structured).toEqual({ implemented: true })
    expect(sent[0]!.tools).toBeDefined()
    expect(system(sent[0]!)).toContain('You execute one developer task')
  })
})

describe('tool-turn output budget', () => {
  it('retries a cut-off tool turn once with a wider budget and one notch less effort', async () => {
    const sent: Array<Record<string, unknown>> = []
    let cut = false
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      sent.push(body)
      if (!cut) { cut = true; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }], usage })) }
      return reply({ content: 'done' })
    }
    const executor = new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free', supportsReasoningEffort: true }, { fetch })
    const result = await executor.execute(request({ effort: 'high' }))
    expect(result.text).toBe('done')
    expect(sent.map(body => [body.max_tokens, body.reasoning_effort])).toEqual([[8192, 'high'], [16384, 'medium']])
  })
  it('a connection-declared maxOutputTokens sets the tool-turn budget and its cut-off retry (twice), bounded by the room left in the context window', async () => {
    const sent: Array<Record<string, unknown>> = []
    let cut = false
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      sent.push(body)
      if (!cut) { cut = true; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }], usage })) }
      return reply({ content: 'done' })
    }
    const wide = new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free', maxOutputTokens: 12288, contextWindowTokens: 65536 }, { fetch })
    expect((await wide.execute(request())).text).toBe('done')
    expect(sent.map(body => body.max_tokens)).toEqual([12288, 24576])
    // A 16k window with a ~1k prompt cannot host 24k of output: the retry gets what fits, never more.
    sent.length = 0; cut = false
    const narrow = new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free', maxOutputTokens: 12288, contextWindowTokens: 16384 }, { fetch })
    expect((await narrow.execute(request())).text).toBe('done')
    expect(sent[0]!.max_tokens).toBe(12288)
    expect(sent[1]!.max_tokens).toBeGreaterThan(12288)
    expect(sent[1]!.max_tokens).toBeLessThan(16384)
  })
  it('does not retry a cut-off when neither the effort can drop nor the window has room', async () => {
    let calls = 0
    const fetch: typeof globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }], usage })) }
    const executor = new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free', maxOutputTokens: 12288, contextWindowTokens: 12288 }, { fetch })
    await expect(executor.execute(request())).rejects.toMatchObject({ code: 'incomplete_response' })
    expect(calls).toBe(1)
  })
  it('sends the thinking switch off by default on local engines, keeps it off when the role says so, and drops it once the endpoint rejects it', async () => {
    const sent: Array<Record<string, unknown>> = []
    const fetch: typeof globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init!.body as string)); return reply({ content: 'done' }) }
    await new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch }).execute(request())
    expect(sent[0]!.chat_template_kwargs).toEqual({ enable_thinking: false })
    await new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch }).execute(request({ thinking: 'on' }))
    expect(sent[1]!.chat_template_kwargs).toBeUndefined()
    sent.length = 0
    let rejected = false
    const strict: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      sent.push(body)
      if (body.chat_template_kwargs && !rejected) { rejected = true; return new Response('{"error":"unknown field: chat_template_kwargs"}', { status: 400 }) }
      return reply({ content: 'done' })
    }
    const events: string[] = []
    const result = await new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch: strict }).execute(request({ onEvent: event => { if (event.kind === 'text') events.push(event.text ?? '') } }))
    expect(result.text).toBe('done')
    expect(sent.map(body => body.chat_template_kwargs !== undefined)).toEqual([true, false])
    expect(events.some(text => text.includes('rejected the thinking switch'))).toBe(true)
  })
  it('surfaces a second cut-off as the incomplete_response error', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'length' }], usage }))
    await expect(new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch }).execute(request())).rejects.toThrow('did not complete')
  })
})

describe('compact pipeline helpers', () => {
  it('extracts scope, repositories and frozen criteria from the role prompt', () => {
    const prompt = roleInstructions('reviewer', { schemaVersion: 1, runId: 'r', backlogRoot: '/tmp/b', artifactRoot: '/repo/app', artifactRepositoryId: 'app', repositories: [{ id: 'app', name: 'App', path: '/repo/app' }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 3, title: 'Feature', description: 'Do it', acceptanceCriteria: ['It works'] }] } as PipelineContext, 'demo', { criteria: [{ specId: '3', criterionIndex: 0, requirement: 'It works' }] })
      + '\nCurrent frozen acceptance obligations (all remain required):\n' + JSON.stringify([{ specId: '3', criterionIndex: 0, requirement: 'It works' }]) + '\n\n## Repository reference (current checkout facts)\nmap'
    const inputs = extractPromptInputs(prompt)
    expect(inputs.repositories).toEqual([{ id: 'app', name: 'App', path: '/repo/app' }])
    expect(inputs.scope).toContain('### Feature')
    expect(inputs.criteria).toEqual([{ specId: '3', criterionIndex: 0, requirement: 'It works' }])
    expect(inputs.repositoryMap).toContain('map')
    expect(inputs.reviewGate).toContain('Scores are numbers')
    expect(inputs.definition).toMatch(/^You are the Specrails reviewer/)
    // The fixer definition (host-editable) reaches the compact fixer through the same channel.
    const fixerPrompt = roleInstructions('developer', { schemaVersion: 1, runId: 'r', backlogRoot: '/tmp/b', artifactRoot: '/repo/app', artifactRepositoryId: 'app', repositories: [{ id: 'app', name: 'App', path: '/repo/app' }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [] } as unknown as PipelineContext, 'demo', { stance: 'fixer', definition: '## Your task: correction\n\nMy fixer stance.' })
    expect(extractPromptInputs(fixerPrompt).definition).toBe('My fixer stance.')
    expect(inputs.reReviewChanges).toEqual([])
    expect(extractPromptInputs(prompt + '\nRe-review changes (JSON): [{"repositoryId":"app","path":"src/a.js","status":"changed"},{"bogus":1}]\n').reReviewChanges).toEqual([{ repositoryId: 'app', path: 'src/a.js', status: 'changed' }])
  })
  it('renders strict-valid specs and tasks and ticks only the completed task ids', () => {
    expect(renderSpec({ name: 'cap', requirements: [{ name: 'R', text: 'does a thing', scenarios: [] }] })).toContain('The system SHALL satisfy the following: does a thing\n\n#### Scenario: Requested behavior')
    const tasks = renderTasks([{ title: 'Setup', tasks: ['Create module'] }, { title: 'Core', tasks: ['Implement', 'Test'] }])
    expect(parseTaskGroups(tasks)).toEqual([{ index: 1, title: 'Setup', tasks: [{ id: '1.1', text: 'Create module', done: false }] }, { index: 2, title: 'Core', tasks: [{ id: '2.1', text: 'Implement', done: false }, { id: '2.2', text: 'Test', done: false }] }])
    const ticked = tickTasks(tasks, new Set(['2.1']))
    expect(ticked).toContain('- [x] 2.1 Implement')
    expect(ticked).toContain('- [ ] 2.2 Test')
    expect(ticked.replace('[x]', '[ ]')).toBe(tasks)
  })
})

describe('compact role timeout', () => {
  it('defaults to 45 minutes for compact pipelines and keeps an explicit or free-loop timeout', async () => {
    const seen: number[] = []
    const fetch: typeof globalThis.fetch = async () => reply({ content: 'done' })
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const openspec = { context: { change: 'x' } } as unknown as AgentRequest['openspec']
    await new OpenAICompatibleExecutor(provider, { fetch }).execute(request({ openspec })).catch(() => undefined)
    await new OpenAICompatibleExecutor({ ...provider, agentLoop: 'free' }, { fetch }).execute(request({ openspec })).catch(() => undefined)
    await new OpenAICompatibleExecutor(provider, { fetch }).execute(request({ openspec, timeoutMs: 60_000 })).catch(() => undefined)
    for (const call of spy.mock.calls) if (typeof call[1] === 'number' && call[1] >= 60_000) seen.push(call[1])
    spy.mockRestore()
    expect(seen).toEqual(expect.arrayContaining([45 * 60_000, 15 * 60_000, 60_000]))
  })
})

describe('supportsReasoningEffort on local connections', () => {
  it('validates the flag and advertises effort support only when declared', () => {
    const value = { schemaVersion: 1, enabled: true, providers: [{ ...provider, supportsReasoningEffort: true }], agents: { architect: { provider: 'local', model: 'm', effort: 'high' }, developer: { provider: 'local', model: 'm' }, reviewer: { provider: 'local', model: 'm' } }, verification: [] } as RuntimeConfig
    expect(validateRuntimeConfig(value).providers[0]).toMatchObject({ supportsReasoningEffort: true })
    expect(new OpenAICompatibleExecutor({ ...provider, supportsReasoningEffort: true }).capabilities()).toMatchObject({ effortSupport: 'supported', supportedEfforts: ['low', 'medium', 'high'] })
    expect(new OpenAICompatibleExecutor(provider).capabilities()).toMatchObject({ effortSupport: 'unsupported' })
    value.providers[0] = { ...provider, supportsReasoningEffort: 'yes' } as unknown as RuntimeConfig['providers'][number]
    expect(() => validateRuntimeConfig(value)).toThrow('supportsReasoningEffort')
  })
})

describe('compact architect spec hygiene (observed: 20 requirements for 8 obligations, soft-drop in the ticket but in no spec)', () => {
  const req = (name: string, text: string) => ({ name, text, scenarios: [{ name: 's', when: 'w', then: 't' }] })
  it('keeps each requirement in exactly one capability and drops capabilities left empty', () => {
    const specs = [
      { name: 'sound-effects', requirements: [req('SFX for piece actions', 'The system SHALL play a distinct SFX for each piece action (move, rotate, hard-drop) when unmuted.'), req('Line clear SFX', 'The system SHALL play the tetris-clear SFX when exactly 4 lines are cleared and the standard SFX for 1-3.')] },
      { name: 'audio-controls', requirements: [req('SFX Playback on Piece Actions', 'The system SHALL play distinct SFX for move, rotate, and hard-drop actions when the game is unmuted.'), req('Mute toggle', 'The system SHALL toggle mute on the M key or the mute button and persist it in localStorage.')] },
      { name: 'gameplay-events', requirements: [req('Line clear SFX selection', 'The system SHALL play the standard line-clear SFX for 1-3 lines and the tetris-clear SFX for exactly 4 lines cleared.')] },
    ]
    const { specs: kept, dropped } = dedupeSpecRequirements(specs)
    expect(kept.map(spec => [spec.name, spec.requirements.map(item => item.name)])).toEqual([
      ['sound-effects', ['SFX for piece actions', 'Line clear SFX']],
      ['audio-controls', ['Mute toggle']],
    ])
    expect(dropped.map(item => item.capability)).toEqual(['audio-controls', 'gameplay-events'])
    expect(dropped[0]!.keptIn).toBe('sound-effects')
  })
  it('appends a ticket criterion no spec mentions to the closest capability, verbatim', () => {
    const specs = [
      { name: 'sound-effects', requirements: [req('SFX for piece actions', 'The system SHALL play a distinct SFX for move, rotate and hard-drop.')] },
      { name: 'background-music', requirements: [req('Music loops', 'The system SHALL loop background music softly on load.')] },
    ]
    const { added } = coverCriteria(specs, ['A distinct SFX plays on soft-drop', 'The system SHALL loop background music softly on load'])
    expect(added).toEqual(['A distinct SFX plays on soft-drop'])
    expect(specs[0]!.requirements.at(-1)!.text).toContain('soft-drop')
    expect(specs[0]!.requirements.at(-1)!.scenarios[0]!.then).toBe('A distinct SFX plays on soft-drop')
    expect(specs[1]!.requirements).toHaveLength(1)
  })
  it('detects binary assets under the roots and ignores dependency and dot directories', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'assets-'))
    mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true }); writeFileSync(path.join(root, 'node_modules', 'x', 'a.png'), '')
    writeFileSync(path.join(root, 'game.js'), '')
    expect(hasBinaryAssets([root])).toBe(false)
    mkdirSync(path.join(root, 'audio')); writeFileSync(path.join(root, 'audio', 'move.wav'), '')
    expect(hasBinaryAssets([root])).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('compact architect task-plan validation', () => {
  const plan = (...tasks: string[]) => ({ groups: [{ title: 'Work', tasks }] })
  it('rejects tasks targeting the frozen plan in any path shape', () => {
    for (const task of [
      'Define the engine configuration in openspec/changes/x/engine.yaml',
      'Create the file at /Users/me/repo/openspec/changes/x/opt.spec.json',
      'Write the design document at /openspec/changes/x/design.md',
      'Update the plan file `openspec\\changes\\x\\tasks.md` with status',
    ]) expect(validateTaskPlan(plan(task, 'Add the game loop in src/game.ts with tests'), [])).toContain('frozen OpenSpec planning directory')
  })
  it('rejects a plan that only produces documents and accepts one that names code', () => {
    expect(validateTaskPlan(plan('Write a JSON spec describing the HUD for the assistant', 'Author README.md with the design of the overlay'), [])).toContain('no task names an application source or test file')
    expect(validateTaskPlan(plan('Implement src/hud/render.ts with tests in tests/render.test.ts'), [])).toBeUndefined()
    expect(validateTaskPlan(plan('Build the board model in board.py with tests in test_board.py'), [])).toBeUndefined()
    expect(validateTaskPlan({ groups: [] }, [])).toContain('at least one group')
  })
  it('rejects stub tasks, one-group plans for real specs, and plans that leave requirements uncovered', () => {
    expect(validateTaskPlan(plan('package.json', 'src/index.js', 'tests/scaffold.test.js'), [])).toContain('file names or stubs')
    const reqs = ['Board placement and collision', 'Seven-bag randomizer', 'Line clearing and scoring', 'Gravity tick and locking']
    const oneGroup = plan('Create the scaffold with package.json, a test script and a smoke test in tests/smoke.test.ts', 'Implement src/board.ts placement and collision with tests', 'Implement src/bag.ts randomizer with tests')
    expect(validateTaskPlan(oneGroup, [], reqs)).toContain('at least 4 tasks across at least 2 groups')
    const wide = { groups: [
      { title: 'Scaffold', tasks: ['Create the scaffold with package.json, a test script and a smoke test in tests/smoke.test.ts'] },
      { title: 'Engine', tasks: ['Implement board placement and collision in src/board.ts with tests', 'Implement the seven-bag randomizer in src/bag.ts with tests', 'Add a helper module in src/util.ts with tests'] },
    ] }
    // Two of four requirements uncovered (more than a third): rejected, naming them.
    expect(validateTaskPlan(wide, [], reqs)).toContain('not covered by any task')
    expect(validateTaskPlan(wide, [], reqs)).toContain('Line clearing and scoring')
    expect(validateTaskPlan(wide, [], reqs)).toContain('Gravity tick and locking')
    wide.groups[1]!.tasks.push('Implement line clearing and the classic scoring table in src/scoring.ts with tests', 'Implement gravity tick and piece locking in src/game.ts with tests')
    expect(validateTaskPlan(wide, [], reqs)).toBeUndefined()
    // A single uncovered PROSE requirement out of four is tolerated (synonyms are common)…
    wide.groups[1]!.tasks.pop()
    expect(validateTaskPlan(wide, [], reqs)).toBeUndefined()
    // …but a requirement carrying an identifier (`#hold-piece-canvas`, `drawHold()`) that no task mentions is rejected on its own.
    const withUi = [...reqs.slice(0, 3), 'Render the held piece in #hold-piece-canvas via drawHoldPiece()']
    expect(validateTaskPlan(wide, [], withUi)).toContain('hold-piece-canvas')
    wide.groups[1]!.tasks.push('Render the held piece in the hold-piece-canvas element with drawHoldPiece() in game.js, with tests')
    expect(validateTaskPlan(wide, [], withUi)).toBeUndefined()
  })
  it('extracts load-bearing tokens from criteria', () => {
    expect(criterionTokens('Calling `tick(state)` advances gravity by one row')).toEqual(['tick'])
    expect(criterionTokens('7-bag randomizer: each of the 7 pieces appears once')).toEqual(expect.arrayContaining(['7-bag']))
    expect(criterionTokens('`createGame(seed?: number): GameState` — optional seed')).toEqual(['creategame', 'gamestate'])
    expect(criterionTokens('Scoring: 1 line=100×level, 4 (Tetris)=800×level')).toEqual(expect.arrayContaining(['100', '800']))
  })
  it('only treats a real question as blocking, never the schema placeholder or a statement', async () => {
    const { normalizeTasksForTest } = await import('./compact/architect.js')
    const base = { groups: [{ title: 'Work', tasks: ['Implement src/game.ts with tests in tests/game.test.ts'] }] }
    expect(normalizeTasksForTest({ ...base, blockingQuestion: 'omit unless several plausible designs exist and only the requester can choose' }).blockingQuestion).toBeUndefined()
    expect(normalizeTasksForTest({ ...base, blockingQuestion: 'The design is settled.' }).blockingQuestion).toBeUndefined()
    expect(normalizeTasksForTest({ ...base, blockingQuestion: 'Should the board be 10x20 or 10x22 with hidden rows?' }).blockingQuestion).toBe('Should the board be 10x20 or 10x22 with hidden rows?')
  })
  it('rejects one task that swallows most of the spec', () => {
    const reqs = ['`createGame()` returns the initial state', '`tick(state)` applies gravity', '`applyInput` handles commands', '`getState()` returns a snapshot', '`clearLines` updates score']
    const overloaded = { groups: [
      { title: 'Scaffold', tasks: ['Create the scaffold with package.json, a test script and a smoke test in tests/smoke.test.ts'] },
      { title: 'Engine', tasks: ['Implement createGame, tick, applyInput, getState and clearLines in src/engine.ts with tests in tests/engine.test.ts', 'Add the board model in src/board.ts with tests in tests/board.test.ts', 'Add piece shapes in src/pieces.ts with tests in tests/pieces.test.ts'] },
    ] }
    expect(validateTaskPlan(overloaded, [], reqs)).toContain('cover more than two requirements at once')
    const split = { groups: [
      { title: 'Scaffold', tasks: ['Create the scaffold with package.json, a test script and a smoke test in tests/smoke.test.ts'] },
      { title: 'Engine', tasks: ['Implement createGame and getState in src/engine.ts with tests in tests/engine.test.ts', 'Implement tick gravity in src/gravity.ts with tests in tests/gravity.test.ts', 'Implement clearLines scoring in src/scoring.ts with tests in tests/scoring.test.ts', 'Implement applyInput commands in src/input.ts with tests in tests/input.test.ts'] },
    ] }
    expect(validateTaskPlan(split, [], reqs)).toBeUndefined()
  })
})

describe('CLI executors stay byte-identical', () => {
  it('builds the same Claude architect invocation and prompt as before the compact runtime', async () => {
    const context = { schemaVersion: 1, runId: 'snapshot', backlogRoot: '/workspace', artifactRoot: '/repo/app', artifactRepositoryId: 'app', repositories: [{ id: 'app', name: 'App', path: '/repo/app' }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Snapshot feature', description: 'Keep prompts frozen', acceptanceCriteria: ['Prompt is unchanged'] }] } as PipelineContext
    const openspec: OpenSpecRoleContext = { root: '/repo/app', change: 'snapshot-change', stateDirectory: '/repo/app/.specrails/state', cli: '/opt/openspec.js', skillPath: '/opt/skills/openspec-ff-change/SKILL.md', skillHash: 'abc', role: 'architect' }
    const prompt = openSpecPrompt(openspec) + roleInstructions('architect', context, 'snapshot-change', { verification: [{ repositoryId: 'app', command: 'npm', args: ['test'] }] })
    const invocation = buildCliInvocation('claude', { role: 'architect', prompt, cwd: '/repo/app', allowedRoots: ['/repo/app'], model: 'sonnet', maxTurns: 50 }, { mcpConfigFile: '/tmp/mcp.json' })
    await expect(JSON.stringify(invocation, null, 2)).toMatchFileSnapshot('./__fixtures__/claude-architect-invocation.snapshot.json')
  })
})

describe('compact role pipelines through the Core graph', () => {
  let root: string, context: PipelineContext, config: RuntimeConfig
  const change = 'compact-feature'
  function write(file: string, text: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
  function git(repository: string, args: string[]): string {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'compact runtime '))
    const repositories = ['front', 'back'].map(id => {
      const repository = path.join(root, id)
      mkdirSync(repository)
      git(repository, ['init', '-q'])
      write(path.join(repository, 'code.cjs'), 'module.exports = 1\n')
      git(repository, ['add', '.'])
      git(repository, ['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'baseline'])
      return { id, name: id, path: repository }
    })
    mkdirSync(path.join(root, 'workspace'))
    context = {
      schemaVersion: 1, runId: 'compact-fixture', backlogRoot: path.join(root, 'workspace'), artifactRoot: repositories[0]!.path, artifactRepositoryId: 'front', repositories,
      ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
      specs: [{ id: 7, title: 'Shared feature', description: 'Return 2 in both repositories', repositoryIds: ['front', 'back'], acceptanceCriteria: ['Both repositories return 2'] }],
    }
    config = {
      schemaVersion: 1, enabled: true, providers: [{ ...provider, contextWindowTokens: 8192 }],
      agents: { architect: { provider: 'local', model: 'small' }, developer: { provider: 'local', model: 'small' }, reviewer: { provider: 'local', model: 'small' } },
      verification: repositories.map(repository => ({ repositoryId: repository.id, command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);process.stdout.write("real verification passed")'] })),
      limits: { maxAttempts: 2 },
    }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A scripted small model: each compact step is recognised by its instructions, never by turn count. */
  function smallModel(options: { rejectResponseFormatOnce?: boolean; reviewerProseFirst?: boolean; developerSpamBudget?: boolean; planningTasksFirst?: boolean; writeIntoOpenspecFirst?: boolean; loopGroupTwo?: boolean; reviewerRejectOnce?: boolean; slowGroupTwo?: number; proseGroupTwo?: boolean; silentGroupTwo?: boolean; surrenderGroupTwoOnce?: boolean; unreachedTest?: boolean; delayGroupMs?: number; delayGroupTwoOnceMs?: number; dishonestHarness?: boolean; reviewerWandersOnReReview?: boolean } = {}) {
    const sent: Body[] = []
    let rejected = false, reviewerProse = false, spam = 0, planningTasks = false, frozenWrite = false, reviewerRejected = false, groupTwoVisits = 0, surrendered = false, delayedTwo = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Body
      sent.push(body)
      const sys = system(body), user = last(body, 'user')
      // A slow local model: every developer group turn takes `delayGroupMs`; `delayGroupTwoOnceMs` stalls the FIRST turn of group 2 once.
      if (options.delayGroupMs && sys.includes('Implement the listed tasks')) await new Promise(resolve => setTimeout(resolve, options.delayGroupMs))
      if (options.delayGroupTwoOnceMs && sys.includes('Implement the listed tasks') && user.includes('group 2:') && !delayedTwo) { delayedTwo = true; await new Promise(resolve => setTimeout(resolve, options.delayGroupTwoOnceMs)) }
      const seenTool = body.messages.some(message => message.role === 'tool')
      if (options.rejectResponseFormatOnce && body.response_format && !rejected) { rejected = true; return reply({}, 400) }
      if (sys.includes('Inventory the repository')) return seenTool ? reply({ content: JSON.stringify({ greenfield: false, languages: ['javascript'], frameworks: [], keyFiles: ['code.cjs'], tests: [], notes: 'One module per repository.' }) }) : reply(call('list_files', { path: '.' }))
      if (sys.includes('Write the OpenSpec proposal')) return reply({ content: JSON.stringify({ why: 'Both repositories must return 2.', whatChanges: ['code.cjs exports 2'], capabilities: { new: ['shared feature'], modified: [] }, impact: ['front/code.cjs', 'back/code.cjs'] }) })
      if (sys.includes('Write the OpenSpec design')) return reply({ content: '```json\n' + JSON.stringify({ context: 'Each repository exports a constant.', goals: ['Return 2'], nonGoals: ['Anything else'], decisions: [{ title: 'Constant', choice: 'Change the literal', why: 'Smallest change' }], risks: [{ risk: 'Drift', mitigation: 'Verification runs in both repositories' }] }) + '\n```' })
      if (sys.includes('Write the requirements of the capability')) return reply({ content: JSON.stringify({ name: 'shared-feature', requirements: [{ name: 'Return two', text: 'Both repositories SHALL export 2.', scenarios: [{ name: 'Requested behavior', when: 'the module is required', then: 'it returns 2' }] }] }) })
      if (sys.includes('Break the implementation')) {
        if (options.planningTasksFirst && !planningTasks) { planningTasks = true; return reply({ content: JSON.stringify({ groups: [{ title: 'Plan', tasks: ['Define the engine configuration in openspec/changes/compact-feature/engine.yaml'] }] }) }) }
        return reply({ content: JSON.stringify({ groups: [{ title: 'Implement', tasks: ['Set code.cjs to export the value 2 in the front and back repositories'] }, { title: 'Document', tasks: ['Note the change in the README of both repositories'] }] }) })
      }
      if (sys.includes('Implement the listed tasks') || sys.includes('FIXER') || sys.includes('does not execute test files')) {
        const wiredScript = JSON.stringify({ name: 'front', version: '1.0.0', private: true, scripts: { test: 'node tests/a.test.cjs && node tests/b.test.cjs' } })
        // The host said a test file is not run: the model wires it into the test script (group fix round, or the next group's feedback).
        if (options.unreachedTest && (sys.includes('does not execute test files') || (user.includes('not executed by any verification command') && !user.includes('group 1:')))) {
          const calls = body.messages.filter(message => message.role === 'tool').length
          if (calls === 0) return reply(call('write_file', { path: 'package.json', content: wiredScript + '\n' }, 'wire1'))
          return reply({ content: JSON.stringify({ summary: 'Wired tests/b.test.cjs into npm test', files: ['package.json'], tests: ['tests/b.test.cjs'], verification: 'none', incomplete: [] }) })
        }
        if (options.unreachedTest && user.includes('group 1:')) {
          const calls = body.messages.filter(message => message.role === 'tool').length
          if (calls === 0) return reply(call('write_file', { path: 'code.cjs', content: 'module.exports = 2\n' }, 'w1'))
          if (calls === 1) return reply(call('write_file', { path: '../back/code.cjs', content: 'module.exports = 2\n' }, 'w2'))
          if (calls === 2) return reply(call('write_file', { path: 'tests/b.test.cjs', content: 'if (require("../code.cjs") !== 2) process.exit(9)\n' }, 'w3'))
          return reply({ content: JSON.stringify({ summary: 'Set both modules to 2 and added a browser-style test', files: ['code.cjs', 'back/code.cjs', 'tests/b.test.cjs'], tests: ['tests/b.test.cjs'], verification: 'commands you could not run: node tests/b.test.cjs', incomplete: [] }) })
        }
        if (options.dishonestHarness && user.includes('exited 0 but its output reports')) {
          const calls = body.messages.filter(message => message.role === 'tool').length
          if (calls === 0) return reply(call('write_file', { path: 'fixed.txt', content: 'exitCode fixed\n' }, 'hx1'))
          return reply({ content: JSON.stringify({ summary: 'Made the harness exit non-zero and fixed the test', files: ['fixed.txt'], tests: [], verification: 'none', incomplete: [] }) })
        }
        if (user.includes('Review corrections')) {
          const calls = body.messages.filter(message => message.role === 'tool').length
          if (calls === 0) return reply(call('write_file', { path: 'code.cjs', content: 'module.exports = 2 // reviewed\n' }, 'fix1'))
          return reply({ content: JSON.stringify({ summary: 'Applied the review fix', files: ['code.cjs'], tests: [], verification: 'none', incomplete: [] }) })
        }
        if (user.includes('group 1:')) {
          const calls = body.messages.filter(message => message.role === 'tool').length
          if (options.writeIntoOpenspecFirst && !frozenWrite) { frozenWrite = true; return reply(call('write_file', { path: 'openspec/changes/compact-feature/engine.yaml', content: 'engine: true\n' }, 'w0')) }
          if (calls === (frozenWrite ? 1 : 0)) return reply(call('write_file', { path: 'code.cjs', content: 'module.exports = 2\n' }, 'w1'))
          if (calls === (frozenWrite ? 2 : 1)) return reply(call('write_file', { path: '../back/code.cjs', content: 'module.exports = 2\n' }, 'w2'))
          return reply({ content: JSON.stringify({ summary: 'Set both modules to 2', files: ['code.cjs', 'back/code.cjs'], tests: [], verification: 'none', incomplete: [] }) })
        }
        if (options.surrenderGroupTwoOnce && user.includes('group 2:')) {
          if (!surrendered) { surrendered = true; return reply({ content: JSON.stringify({ summary: 'Nothing to do', files: [], tests: [], verification: 'none', incomplete: [{ task: '2.1', reason: 'The repository contains no application source files to test against' }] }) }) }
          if (!user.includes('The repository is NOT empty')) return reply({ content: 'unexpected' })
          const calls = body.messages.filter(message => message.role === 'tool').length
          if (calls === 0) return reply(call('write_file', { path: 'NOTES.md', content: 'documented\n' }, 'doc1'))
          return reply({ content: JSON.stringify({ summary: 'Documented', files: ['NOTES.md'], tests: [], verification: 'none', incomplete: [] }) })
        }
        if (options.proseGroupTwo && body.messages.some(message => message.role === 'user' && String(message.content).includes('group 2:'))) {
          const calls = body.messages.filter(message => message.role === 'tool').length
          if (calls === 0 && body.tools) return reply(call('write_file', { path: 'NOTES.md', content: 'notes\n' }, 'prose-w'))
          // Prose on the group's final turn AND on the structured retry: never the JSON object.
          return reply({ content: 'I wrote the notes file. All good!' })
        }
        if (options.silentGroupTwo && body.messages.some(message => message.role === 'user' && String(message.content).includes('group 2:'))) {
          const calls = body.messages.filter(message => message.role === 'tool').length
          if (calls === 0 && body.tools) return reply(call('write_file', { path: 'NOTES.md', content: 'notes\n' }, 'silent-w'))
          // Empty reply on the final turn AND after the nudge: nothing at all.
          return reply({ content: '' })
        }
        if (options.loopGroupTwo && user.includes('group 2:') && body.tools) return reply(call('read_file', { path: 'code.cjs' }, `loop-${++spam}`))
        if (options.slowGroupTwo && user.includes('group 2:') && groupTwoVisits <= options.slowGroupTwo && body.messages.filter(message => message.role === 'tool').length === 1) return reply({ content: JSON.stringify({ summary: 'Partial notes', files: [`notes-${groupTwoVisits}.md`], tests: [], verification: 'none', incomplete: [{ task: '2.1', reason: 'still working' }] }) })
        if (options.slowGroupTwo && user.includes('group 2:') && body.messages.filter(message => message.role === 'tool').length === 0) {
          // Leaves the group's task open for N visits (a small model needing several passes), then finishes it.
          if (++groupTwoVisits <= options.slowGroupTwo) return reply(call('write_file', { path: `notes-${groupTwoVisits}.md`, content: 'partial\n' }, `slow-${groupTwoVisits}`))
        }
        if (options.developerSpamBudget && body.tools) return reply(call('read_file', { path: `missing-${++spam}.txt` }, `spam-${spam}`))
        return reply({ content: JSON.stringify({ summary: 'Documented', files: [], tests: [], verification: 'none', incomplete: [] }) })
      }
      if (/\b(?:Review|Re-review) an implementation/.test(sys)) {
        if (options.reviewerRejectOnce && !reviewerRejected) { reviewerRejected = true; return reply({ content: JSON.stringify({ approved: false, summary: 'Missing comment', issues: ['code.cjs: export needs a reviewed marker comment'], score: 60, aspects: { type_correctness: 60, pattern_adherence: 60, test_coverage: 60, security: 75, architectural_alignment: 60 } }) }) }
        // Re-review: a wandering reviewer tries to read an unchanged file, then objects to code it already accepted.
        if (options.reviewerWandersOnReReview && sys.includes('Re-review an implementation')) {
          const calls = body.messages.filter(message => message.role === 'tool').length
          if (calls === 0) return reply(call('read_file', { path: 'README.md' }, 'wander'))
          return reply({ content: JSON.stringify({ approved: false, summary: 'Still unhappy', issues: ['README.md: add an architecture section'], score: 55, aspects: { type_correctness: 60, pattern_adherence: 60, test_coverage: 60, security: 75, architectural_alignment: 60 }, acceptance: { criteria: [{ specId: '7', criterionIndex: 0, status: 'met', evidence: ['code.cjs returns 2'] }], checks: [], findings: [] } }) })
        }
        if (options.reviewerProseFirst && !reviewerProse) { reviewerProse = true; return reply({ content: 'Looks good to me, both modules return 2.' }) }
        return reply({ content: JSON.stringify({ approved: true, summary: 'Both modules export 2; verification passed.', issues: [], score: 90, aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 80, security: 90, architectural_alignment: 90 }, acceptance: { criteria: [{ specId: '7', criterionIndex: 0, status: 'met', evidence: ['code.cjs returns 2 in both repositories'] }], checks: [], findings: [] } }) })
      }
      return reply({ content: '{}' })
    })
    return { fetch, sent }
  }

  it('drives the architect, developer and reviewer through host-rendered OpenSpec artifacts that pass the unchanged post-checks', async () => {
    const { fetch, sent } = smallModel({ developerSpamBudget: true, reviewerProseFirst: true })
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
    expect(state.status, state.error).toBe('succeeded')
    const archived = path.join(context.artifactRoot, 'openspec', 'changes', 'archive')
    expect(existsSync(archived)).toBe(true)
    expect(readFileSync(path.join(context.artifactRoot, 'openspec', 'specs', 'shared-feature', 'spec.md'), 'utf8')).toContain('Both repositories SHALL export 2.')
    expect(readFileSync(path.join(root, 'back', 'code.cjs'), 'utf8')).toBe('module.exports = 2\n')
    expect(inspectPipeline(context).phases).toMatchObject({ architect: { status: 'done' }, developer: { status: 'done' }, reviewer: { status: 'done' }, archive: { status: 'done' } })
    // Host-driven OpenSpec calls surface as ordinary tool events for the log.
    const openspecTools = events.filter(item => item.event.kind === 'tool-start' && item.event.tool === 'openspec_workflow').map(item => item.event.detail)
    expect(openspecTools).toEqual(expect.arrayContaining(['load_skill', 'new', 'instructions proposal', 'instructions tasks', 'validate', 'write_progress']))
    expect(events.some(item => item.role === 'architect' && item.event.kind === 'usage')).toBe(true)
    // Every compact step sends a small prompt, never the monolithic role prompt.
    expect(Math.max(...sent.map(body => estimateTokens(body.messages)))).toBeLessThan(6000)
    // Developer: the second task group spent its budget on reads, got the 6-call write-only extension (write tools only), then had to answer without tools.
    const spam = sent.filter(body => body.messages.some(message => message.role === 'user' && String(message.content).includes('group 2:')))
    expect(spam.filter(body => body.tools).length).toBe(25 + 6)
    expect(spam.slice(25, 31).every(body => (body.tools ?? []).every(tool => ['write_file', 'apply_patch'].includes(String((tool as { function?: { name?: string } }).function?.name))))).toBe(true)
    expect(spam.at(-1)!.tools).toBeUndefined()
    expect(last(spam.at(-1)!, 'user')).toContain('tool budget for this step is spent')
    // Reviewer: prose is forced into the review schema through response_format.
    const forced = sent.find(body => body.response_format && (body.response_format.json_schema as { name?: string })?.name === 'review')
    expect(forced).toBeDefined()
    expect(state.usage.inputTokens).toBe(sent.length * 10)
  }, 120_000)

  it('keeps the plan frozen: openspec/ task targets are sent back to the architect and developer writes under openspec/ are refused', async () => {
    const { fetch, sent } = smallModel({ planningTasksFirst: true, writeIntoOpenspecFirst: true })
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry })
    expect(state.status, state.error).toBe('succeeded')
    // Architect: the first tasks answer named a planning file; the retry prompt says so and the rendered plan has none.
    const retry = sent.find(body => last(body, 'user').includes('frozen OpenSpec planning directory'))
    expect(retry).toBeDefined()
    expect(readFileSync(path.join(context.artifactRoot, 'openspec', 'changes', 'archive', ...readdirArchive(context.artifactRoot), 'tasks.md'), 'utf8')).not.toMatch(/openspec\//)
    // Developer: the write into openspec/ came back as a tool error and nothing landed there.
    const refused = sent.find(body => body.messages.some(message => message.role === 'tool' && String(message.content).includes('planning artifacts are frozen')))
    expect(refused).toBeDefined()
    expect(existsSync(path.join(context.artifactRoot, 'openspec', 'changes', 'compact-feature', 'engine.yaml'))).toBe(false)
    expect(readFileSync(path.join(root, 'back', 'code.cjs'), 'utf8')).toBe('module.exports = 2\n')
  }, 120_000)

  it('a project can switch a guardrail off: with frozen-plan-writes disabled the openspec/ write lands and no refusal is sent', async () => {
    const { fetch, sent } = smallModel({ writeIntoOpenspecFirst: true })
    const tuned = { ...config, guardrails: { 'frozen-plan-writes': false as const } }
    const registry = createExecutorRegistry(tuned, { openai: { fetch } })
    await runCoreWorkflow({ context, config: tuned, change, registry })
    expect(sent.some(body => body.messages.some(message => message.role === 'tool' && String(message.content).includes('planning artifacts are frozen')))).toBe(false)
    expect(existsSync(path.join(context.artifactRoot, 'openspec', 'changes', 'compact-feature', 'engine.yaml'))).toBe(true)
  }, 120_000)

  it('closes only the looping task group when a model repeats one call, keeping earlier verified work', async () => {
    const { fetch } = smallModel({ loopGroupTwo: true })
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
    // Group 1 delivered the verified change; group 2 looped and was closed as incomplete instead of failing the step.
    expect(readFileSync(path.join(root, 'back', 'code.cjs'), 'utf8')).toBe('module.exports = 2\n')
    const texts = events.filter(item => item.event.kind === 'text').map(item => String((item.event as { text: string }).text))
    expect(texts.some(t => t.includes('group 2 stopped') && t.includes('repeated 8 times'))).toBe(true)
    // The graph retries once, then parks the run as blocked on the open task — never a crashed step.
    expect(state.status).toBe('blocked')
    expect(String(state.error)).toContain('could not make progress')
  }, 120_000)

  it('turns review feedback into a correction group when every task is already ticked, so the developer actually edits', async () => {
    const { fetch, sent } = smallModel({ reviewerRejectOnce: true })
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry })
    expect(state.status, state.error).toBe('succeeded')
    const correction = sent.find(body => last(body, 'user').includes('Review corrections'))
    expect(correction).toBeDefined()
    expect(last(correction!, 'user')).toContain('reviewed marker comment')
    expect(readFileSync(path.join(context.artifactRoot, 'code.cjs'), 'utf8')).toContain('// reviewed')
    // The second reviewer pass is a RE-REVIEW: settle the previous issues over the files the fixer changed, never the whole candidate again.
    // Two reviewer invocations (each may spend a structured retry): first bodies of each pass.
    const reviews = sent.filter(body => /\b(?:Review|Re-review) an implementation/.test(system(body)) && body.messages.filter(message => message.role === 'user').length === 1)
    expect(reviews.length).toBeGreaterThanOrEqual(2)
    expect(system(reviews[0]!)).toContain('Review an implementation read-only.')
    const second = reviews.find(body => system(body).includes('Re-review an implementation read-only after a correction round'))!
    expect(second).toBeDefined()
    expect(last(second, 'user')).toContain('Diff of the files changed since your previous verdict')
    expect(last(second, 'user')).toContain('code.cjs')
    expect(last(second, 'user')).toContain('reviewed marker comment')
  }, 120_000)

  it('re-review is scoped by the host: reads outside the changed files are refused and off-scope issues are dropped, so a resolved candidate is approved', async () => {
    write(path.join(context.artifactRoot, 'README.md'), '# tetris\n')
    const { fetch, sent } = smallModel({ reviewerRejectOnce: true, reviewerWandersOnReReview: true })
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
    expect(state.status, state.error).toBe('succeeded')
    const texts = events.filter(item => item.event.kind === 'text').map(item => String((item.event as { text: string }).text))
    expect(texts.some(t => t.includes('dropped 1 re-review issue') && t.includes('README.md'))).toBe(true)
    const reReview = sent.find(body => system(body).includes('Re-review an implementation') && body.messages.some(message => message.role === 'tool'))!
    expect(String(reReview.messages.find(message => message.role === 'tool')!.content)).toContain('did not change since your previous verdict')
    // The wandering issue never reached a fixer: exactly one fixer visit (for the real issue), then archive.
    expect(state.history.filter(attempt => attempt.stepId === 'fixer'), texts.join('\n')).toHaveLength(1)
    expect(state.history.at(-1)!.stepId).toBe('archive')
  }, 180_000)

  it('routes the correction round after a rejected review to the configured FIXER engine with the fixer stance', async () => {
    const { fetch, sent } = smallModel({ reviewerRejectOnce: true })
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const tuned = { ...config, providers: [...config.providers, { ...provider, id: 'fixerbox', baseUrl: 'http://127.0.0.1:9/fixer/v1', contextWindowTokens: 8192 }], fixer: { provider: 'fixerbox', model: 'strong' } }
    const registry = createExecutorRegistry(tuned, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config: tuned, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
    expect(state.status, state.error).toBe('succeeded')
    // The correction body went out with the fixer's model and the fixer system prompt; every other body kept the developer's.
    const fixerBodies = sent.filter(body => body.model === 'strong')
    expect(fixerBodies.length).toBeGreaterThan(0)
    expect(fixerBodies.every(body => String(body.messages[0]?.content).includes('FIXER'))).toBe(true)
    expect(sent.some(body => body.model === 'small' && String(body.messages[0]?.content).includes('FIXER'))).toBe(false)
    const texts = events.filter(item => item.event.kind === 'text').map(item => String((item.event as { text: string }).text))
    expect(texts.some(t => t.includes('Correction round on the fixer engine (fixerbox/strong)'))).toBe(true)
    // The correction round's tool calls are attributed to the fixer, never logged as another developer pass.
    expect(events.some(item => item.event.kind === 'tool-start' && (item.role as string) === 'fixer')).toBe(true)
    expect(events.filter(item => item.event.kind === 'tool-start' && item.role === 'developer').length).toBeGreaterThan(0)
    expect(texts.some(t => t.startsWith('Compact fixer:'))).toBe(true)
    // The correction is its own graph node: reviewer → fixer → verify → reviewer, never a second developer visit.
    expect(state.history.map(attempt => attempt.stepId)).toEqual(['architect', 'developer', 'verify', 'reviewer', 'fixer', 'verify', 'reviewer', 'archive'])
  }, 180_000)

  it('does not spend correction attempts on passes that merely continue unchecked tasks (compact developer only)', async () => {
    // 3 continuation passes on group 2, then one real review rejection that must still get its correction.
    const { fetch, sent } = smallModel({ slowGroupTwo: 3, reviewerRejectOnce: true })
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry })
    expect(state.status, state.error).toBe('succeeded')
    expect(sent.filter(body => last(body, 'user').includes('group 2:')).length).toBeGreaterThanOrEqual(4)
    expect(sent.some(body => last(body, 'user').includes('Review corrections'))).toBe(true)
  }, 180_000)

  it('repairs an environment-only verification failure by installing dependencies once, then re-verifies without a developer round', async () => {
    // Verification runs a checker that fails like a missing test runner until node_modules exists.
    const front = context.repositories[0]!.path
    const dep = path.join(root, 'local-dep'); mkdirSync(dep); write(path.join(dep, 'package.json'), '{"name":"local-dep","version":"1.0.0"}'); write(path.join(dep, 'index.js'), 'module.exports = 1\n')
    write(path.join(front, 'package.json'), JSON.stringify({ name: 'front', version: '1.0.0', private: true, dependencies: { 'local-dep': 'file:' + dep } }))
    write(path.join(front, 'check.cjs'), 'const fs=require("fs");if(!fs.existsSync("node_modules")){process.stderr.write("sh: jest: command not found\\n");process.exit(127)}if(require("./code.cjs")!==2)process.exit(9);process.stdout.write("ok")')
    git(front, ['add', '.']); git(front, ['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'manifest'])
    config.verification = [{ repositoryId: 'front', command: process.execPath, args: ['check.cjs'] }, { repositoryId: 'back', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9)'] }]
    const { fetch, sent } = smallModel()
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
    expect(state.status, state.error).toBe('succeeded')
    expect(existsSync(path.join(front, 'node_modules', 'local-dep'))).toBe(true)
    // The developer was NOT asked to "fix" the environment: no correction group ever ran.
    expect(sent.some(body => last(body, 'user').includes('Review corrections'))).toBe(false)
    expect(state.usage.inputTokens).toBe(sent.length * 10)
  }, 180_000)

  describe('test-reachability (observed: a new test file the enumerating test script never ran shipped green)', () => {
    function enumeratingTestScript(): string {
      const front = context.repositories[0]!.path
      write(path.join(front, 'package.json'), JSON.stringify({ name: 'front', version: '1.0.0', private: true, scripts: { test: 'node tests/a.test.cjs' } }))
      write(path.join(front, 'tests', 'a.test.cjs'), 'if (require("../code.cjs") !== 2) process.exit(9)\n')
      git(front, ['add', '.']); git(front, ['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'tests'])
      config.verification = [{ repositoryId: 'front', command: 'npm', args: ['test', '--silent'] }, { repositoryId: 'back', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9)'] }]
      return front
    }
    const texts = (events: { event: AgentEvent }[]): string[] => events.filter(item => item.event.kind === 'text').map(item => String((item.event as { text: string }).text))

    it('the group check passes but skips the new test: the same group is asked to wire it in, then verify accepts the run', async () => {
      const front = enumeratingTestScript()
      const { fetch, sent } = smallModel({ unreachedTest: true })
      const events: { role: AgentEventRole; event: AgentEvent }[] = []
      const registry = createExecutorRegistry(config, { openai: { fetch } })
      const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
      expect(state.status, state.error).toBe('succeeded')
      expect(JSON.parse(readFileSync(path.join(front, 'package.json'), 'utf8')).scripts.test).toBe('node tests/a.test.cjs && node tests/b.test.cjs')
      expect(texts(events).some(t => t.includes('wrote tests/b.test.cjs but npm test --silent does not run it'))).toBe(true)
      expect(texts(events).some(t => t.includes('tests wired in and the check passed'))).toBe(true)
      // Wired at group altitude, so the host verify never had to bounce the run back.
      expect(texts(events).some(t => t.includes('Verification incomplete'))).toBe(false)
      expect(sent.some(body => system(body).includes('does not execute test files'))).toBe(true)
    }, 180_000)

    it('with verify-per-group off, the host verify itself refuses the green run and sends the developer the exact file', async () => {
      const front = enumeratingTestScript()
      config.guardrails = { 'verify-per-group': false }
      const { fetch } = smallModel({ unreachedTest: true })
      const events: { role: AgentEventRole; event: AgentEvent }[] = []
      const registry = createExecutorRegistry(config, { openai: { fetch } })
      const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
      expect(state.status, state.error).toBe('succeeded')
      expect(texts(events).some(t => t.includes('Verification incomplete: front:tests/b.test.cjs is not run by any verification command'))).toBe(true)
      expect(JSON.parse(readFileSync(path.join(front, 'package.json'), 'utf8')).scripts.test).toBe('node tests/a.test.cjs && node tests/b.test.cjs')
      const verify = state.history.filter(attempt => attempt.stepId === 'verify')
      expect(verify.length).toBeGreaterThanOrEqual(2)
    }, 180_000)

    it('a project can switch it off: the unreached test is never mentioned and the run stays green as before', async () => {
      const front = enumeratingTestScript()
      config.guardrails = { 'test-reachability': false }
      const { fetch, sent } = smallModel({ unreachedTest: true })
      const events: { role: AgentEventRole; event: AgentEvent }[] = []
      const registry = createExecutorRegistry(config, { openai: { fetch } })
      const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
      expect(state.status, state.error).toBe('succeeded')
      expect(JSON.parse(readFileSync(path.join(front, 'package.json'), 'utf8')).scripts.test).toBe('node tests/a.test.cjs')
      expect(texts(events).some(t => t.includes('does not run it') || t.includes('Verification incomplete'))).toBe(false)
      expect(sent.some(body => system(body).includes('does not execute test files'))).toBe(false)
    }, 180_000)
  })

  it('passing TAP tests with failure counts in their names reach review without a fixer loop', async () => {
    const output = '# Subtest: getResourceTranslationJobs rethrows non-404 failures\nok 522 - getResourceTranslationJobs rethrows non-404 failures\n# tests 598\n# pass 598\n# fail 0\n'
    config.verification = context.repositories.map(repository => ({ repositoryId: repository.id, command: process.execPath, args: ['-e', `if(require("./code.cjs")!==2)process.exit(9);process.stdout.write(${JSON.stringify(output)})`] }))
    const { fetch } = smallModel()
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry })
    expect(state.status, state.error).toBe('succeeded')
    expect(state.history.map(attempt => attempt.stepId)).toContain('reviewer')
    expect(state.history.map(attempt => attempt.stepId)).not.toContain('fixer')
  }, 180_000)

  it('a verification command that prints failures but exits 0 is a FAILURE routed to the fixer, naming the harness', async () => {
    const front = context.repositories[0]!.path
    // check.cjs: green when code.cjs is 2 AND a "fixed" marker exists; before that it prints failures and exits 0 (a dishonest harness).
    write(path.join(front, 'check.cjs'), 'const fs=require("fs");if(require("./code.cjs")!==2)process.exit(9);if(!fs.existsSync("fixed.txt")){process.stdout.write("FAIL: icon toggles\\nUI tests: 1 passed, 1 failed\\n");process.exit(0)}process.stdout.write("2 passed, 0 failed")')
    git(front, ['add', '.']); git(front, ['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'harness'])
    config.verification = [{ repositoryId: 'front', command: process.execPath, args: ['check.cjs'] }, { repositoryId: 'back', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9)'] }]
    const { fetch, sent } = smallModel({ dishonestHarness: true })
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
    const texts = events.filter(item => item.event.kind === 'text').map(item => String((item.event as { text: string }).text))
    expect(state.status, texts.join('\n') + '\n---\n' + sent.filter(body => system(body).includes('FIXER')).map(body => last(body, 'user').slice(0, 600)).join('\n===\n')).toBe('succeeded')
    expect(texts.some(t => t.includes('Verification exited 0 but reported failures'))).toBe(true)
    expect(state.history.map(attempt => attempt.stepId)).toContain('fixer')
    expect(existsSync(path.join(front, 'fixed.txt'))).toBe(true)
  }, 180_000)

  describe('wall clock per task group (observed: a three-group developer killed at minute 45 while still patching)', () => {
    it('re-arms the role timeout at every group, so two slow groups that together exceed it still finish', async () => {
      // Group 1 = 3 turns × 4 s, group 2 = 1 turn × 4 s: 16 s of model time against a 15 s budget that is per GROUP (each group stays under it).
      // Budgets are generous on purpose: under a full parallel suite the architect's own (undelayed) steps can take several seconds.
      const { fetch } = smallModel({ delayGroupMs: 4000 })
      const registry = createExecutorRegistry(config, { openai: { fetch, defaultTimeoutMs: 15000 } })
      const state = await runCoreWorkflow({ context, config, change, registry })
      expect(state.status, state.error).toBe('succeeded')
    }, 120_000)
    it('a group that outlives its budget BLOCKS the run with the finished groups ticked, and a resume continues from the open group', async () => {
      const { fetch } = smallModel({ delayGroupTwoOnceMs: 20000 })
      const registry = createExecutorRegistry(config, { openai: { fetch, defaultTimeoutMs: 15000 } })
      const state = await runCoreWorkflow({ context, config, change, registry })
      expect(state.status).toBe('blocked')
      expect(state.error).toMatch(/timed out after \d+ minutes on one task group.*resume to continue from the next open group/)
      expect(state.nextStep).toBe('developer')
      const tasks = readFileSync(path.join(context.artifactRoot, 'openspec', 'changes', change, 'tasks.md'), 'utf8')
      expect(tasks).toMatch(/- \[x\] 1\.1/)
      expect(tasks).toMatch(/- \[ \] 2\.1/)
      const resumed = await runCoreWorkflow({ context, config, change, registry: createExecutorRegistry(config, { openai: { fetch, defaultTimeoutMs: 15000 } }), resume: true })
      expect(resumed.status, resumed.error).toBe('succeeded')
    }, 120_000)
    it('the idle watchdog stops a run that produces nothing for the idle bound, as a resumable block', async () => {
      const { fetch } = smallModel({ delayGroupTwoOnceMs: 12000 })
      const registry = createExecutorRegistry(config, { openai: { fetch, idleTimeoutMs: 6000 } })
      const state = await runCoreWorkflow({ context, config, change, registry })
      expect(state.status).toBe('blocked')
      expect(state.error).toMatch(/idle timeout: no tool call, reply or usage/)
    }, 120_000)
  })

  it('reconstructs a group result from its write calls when the model never returns the JSON object', async () => {
    const { fetch } = smallModel({ proseGroupTwo: true })
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
    // Group 1 landed the verified change; group 2's prose did not sink the step.
    expect(readFileSync(path.join(root, 'back', 'code.cjs'), 'utf8')).toBe('module.exports = 2\n')
    expect(readFileSync(path.join(context.artifactRoot, 'NOTES.md'), 'utf8')).toBe('notes\n')
    expect(events.some(item => item.event.kind === 'text' && String((item.event as { text: string }).text).includes('gave no structured result'))).toBe(true)
    expect(String(state.error ?? '')).not.toContain('did not produce a valid result')
  }, 180_000)

  it('closes a group whose model goes silent after writing files, crediting the writes instead of failing the step', async () => {
    const { fetch } = smallModel({ silentGroupTwo: true })
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
    expect(readFileSync(path.join(root, 'back', 'code.cjs'), 'utf8')).toBe('module.exports = 2\n')
    expect(readFileSync(path.join(context.artifactRoot, 'NOTES.md'), 'utf8')).toBe('notes\n')
    const texts = events.filter(item => item.event.kind === 'text').map(item => String((item.event as { text: string }).text))
    expect(texts.some(t => t.includes('group 2 stopped') && t.includes('empty final result') && t.includes('recorded 1 written file'))).toBe(true)
    expect(String(state.error ?? '')).not.toContain('empty final result')
  }, 180_000)

  it('writtenFiles lists only paths whose write/patch call succeeded', () => {
    const messages = [
      { role: 'assistant' as const, content: '', tool_calls: [
        { id: 'a', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts', content: '' }) } },
        { id: 'b', type: 'function' as const, function: { name: 'apply_patch', arguments: JSON.stringify({ path: 'src/b.ts', oldText: 'x', newText: 'y' }) } },
        { id: 'c', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/c.ts' }) } },
        { id: 'd', type: 'function' as const, function: { name: 'write_file', arguments: '{"path": ' } },
      ] },
      { role: 'tool' as const, tool_call_id: 'a', content: 'written' },
      { role: 'tool' as const, tool_call_id: 'b', content: '{"error":"oldText not found"}' },
      { role: 'tool' as const, tool_call_id: 'c', content: 'contents' },
    ]
    expect(writtenFiles(messages)).toEqual(['src/a.ts'])
  })

  it('sends generic generation controls on planning steps, and reasoning_effort only when the connection declares support', async () => {
    const { fetch, sent } = smallModel()
    // No support declared: planning steps carry temperature/max_tokens, never reasoning_effort.
    await runCoreWorkflow({ context, config, change, registry: createExecutorRegistry(config, { openai: { fetch } }) })
    const planning = sent.filter(body => body.response_format)
    expect(planning.length).toBeGreaterThan(0)
    for (const body of planning) { expect((body as Record<string, unknown>).temperature).toBe(0.2); expect((body as Record<string, unknown>).max_tokens).toBe(16384); expect((body as Record<string, unknown>).reasoning_effort).toBeUndefined() }
    // Developer tool turns keep the server defaults.
    const coding = sent.find(body => body.tools && String(body.messages[0]?.content).includes('Implement the listed tasks'))!
    expect((coding as Record<string, unknown>).temperature).toBeUndefined()
    // Support declared + role effort: the role's effort is the default, planning raises it to high.
    sent.length = 0
    const supported = { ...config, providers: [{ ...config.providers[0]!, supportsReasoningEffort: true }], agents: { ...config.agents, architect: { ...config.agents.architect, effort: 'low' } } } as RuntimeConfig
    rmSync(path.join(context.artifactRoot, 'openspec'), { recursive: true, force: true })
    rmSync(path.join(root, 'workspace'), { recursive: true, force: true }); mkdirSync(path.join(root, 'workspace'))
    await runCoreWorkflow({ context: { ...context, runId: 'compact-fixture-2' }, config: supported, change: change + '-2', registry: createExecutorRegistry(supported, { openai: { fetch } }) })
    const inventory = sent.find(body => String(body.messages[0]?.content).includes('Inventory the repository'))!
    expect((inventory as Record<string, unknown>).reasoning_effort).toBe('low')
    expect((sent.find(body => body.response_format) as Record<string, unknown>).reasoning_effort).toBe('high')
    // The criteria→requirements step is long and mechanical: medium, not high.
    const specsStep = sent.find(body => String(body.messages[0]?.content).includes('Write the requirements of the capability')) as Record<string, unknown>
    expect(specsStep.reasoning_effort).toBe('medium')
  }, 180_000)

  it('retries a planning step at a lower reasoning effort when the reply was cut off by the output budget', async () => {
    const { fetch: base, sent } = smallModel()
    let cut = false
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init!.body as string) as Body & { reasoning_effort?: string }
      if (!cut && String(body.messages[0]?.content).includes('Write the OpenSpec proposal')) {
        cut = true
        sent.push(body)
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"why": "truncated' }, finish_reason: 'length' }], usage }))
      }
      return base(url, init)
    }
    const supported = { ...config, providers: [{ ...config.providers[0]!, supportsReasoningEffort: true }] } as RuntimeConfig
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const state = await runCoreWorkflow({ context, config: supported, change, registry: createExecutorRegistry(supported, { openai: { fetch } }), onAgentEvent: (role, event) => events.push({ role, event }) })
    expect(state.status, state.error).toBe('succeeded')
    const proposals = sent.filter(body => String(body.messages[0]?.content).includes('Write the OpenSpec proposal')) as Array<Body & { reasoning_effort?: string }>
    expect(proposals.map(body => body.reasoning_effort)).toEqual(['high', 'medium'])
    expect(events.some(item => item.event.kind === 'text' && String((item.event as { text: string }).text).includes('retrying at "medium"'))).toBe(true)
  }, 180_000)

  it('rejects a surrender the repository contradicts and retries the group with the real inventory', async () => {
    const { fetch, sent } = smallModel({ surrenderGroupTwoOnce: true })
    const events: { role: AgentEventRole; event: AgentEvent }[] = []
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry, onAgentEvent: (role, event) => events.push({ role, event }) })
    expect(state.status, state.error).toBe('succeeded')
    const retry = sent.find(body => last(body, 'user').includes('The repository is NOT empty'))
    expect(retry).toBeDefined()
    expect(last(retry!, 'user')).toContain('code.cjs')
    expect(readFileSync(path.join(context.artifactRoot, 'NOTES.md'), 'utf8')).toBe('documented\n')
    expect(events.some(item => item.event.kind === 'text' && String((item.event as { text: string }).text).includes('retrying with the inventory'))).toBe(true)
  }, 180_000)

  it('falls back to instruction-only structured output when the endpoint rejects response_format', async () => {
    const { fetch, sent } = smallModel({ rejectResponseFormatOnce: true })
    const registry = createExecutorRegistry(config, { openai: { fetch } })
    const state = await runCoreWorkflow({ context, config, change, registry })
    expect(state.status, state.error).toBe('succeeded')
    const structured = sent.filter(body => body.response_format)
    expect(structured).toHaveLength(1)
    expect(sent.filter(body => last(body, 'user').startsWith('Reply with exactly one JSON object matching this JSON Schema')).length).toBeGreaterThan(3)
  }, 120_000)
})
