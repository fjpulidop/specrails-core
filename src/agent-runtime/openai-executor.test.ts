import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleExecutor } from './openai-executor.js'
import type { AgentRequest } from './executor-types.js'

const temporary: string[] = [], servers: Server[] = []
function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const root = mkdtempSync(path.join(tmpdir(), 'specrails-api-')); temporary.push(root)
  return { role: 'developer', cwd: root, allowedRoots: [root], prompt: 'Implement the requested task', model: 'local-model', maxTurns: 4, ...overrides }
}
const provider = { id: 'local', kind: 'openai-compatible' as const, baseUrl: 'http://localhost:11434/v1' }
function response(message: Record<string, unknown>, usage?: Record<string, unknown>, finishReason = 'stop'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: finishReason }], ...(usage ? { usage } : {}) }), { headers: { 'Content-Type': 'application/json' } })
}
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe('OpenAI-compatible coding executor', () => {
  it('searches, reads a range and patches through API tools while retaining cache usage', async () => {
    const input = request({ maxTurns: 4 }), sent: Record<string, unknown>[] = []
    writeFileSync(path.join(input.cwd, 'code.ts'), 'export const value = 1\n')
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      const body = JSON.parse(options!.body as string)
      sent.push(body)
      const turn = sent.length
      const name = ['search_text', 'read_lines', 'apply_patch'][turn - 1]
      const args = turn === 1 ? { path: '.', query: 'value' } : turn === 2 ? { path: 'code.ts', startLine: 1, endLine: 1 } : { path: 'code.ts', oldText: 'value = 1', newText: 'value = 2', expectedHash: JSON.parse(body.messages.at(-1).content).hash }
      return response(name ? { tool_calls: [{ id: `tool-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: '{"implemented":true}' }, { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } })
    })
    const result = await new OpenAICompatibleExecutor(provider, { fetch }).execute(input)
    expect(readFileSync(path.join(input.cwd, 'code.ts'), 'utf8')).toBe('export const value = 2\n')
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 20, costUsd: null, uncachedInputTokens: 80, cacheReadInputTokens: 320, cacheWriteInputTokens: null })
  })
  it('keeps cache totals unknown when a later response omits cache counters', async () => {
    let turn = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => ++turn === 1
      ? response({ tool_calls: [{ id: 'list', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] }, { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 8 } })
      : response({ content: 'done' }, { prompt_tokens: 20, completion_tokens: 1 }))
    const result = await new OpenAICompatibleExecutor(provider, { fetch }).execute(request())
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 2, cacheReadInputTokens: null, uncachedInputTokens: null })
  })
  it('executes a real file tool loop and sums usage without fabricating USD cost', async () => {
    const input = request(), sent: Record<string, unknown>[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      sent.push(JSON.parse(options!.body as string))
      if (sent.length === 1) return response({ content: null, tool_calls: [{ id: 'write1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/index.ts', content: 'export const value = 42\n' }) } }] }, { prompt_tokens: 12, completion_tokens: 5 }, 'tool_calls')
      return response({ content: '{"implemented":true}' }, { prompt_tokens: 25, completion_tokens: 3 })
    })
    const result = await new OpenAICompatibleExecutor(provider, { fetch }).execute(input)
    expect(readFileSync(path.join(input.cwd, 'src/index.ts'), 'utf8')).toBe('export const value = 42\n')
    expect((sent[1].messages as Record<string, unknown>[]).at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'write1' })
    expect(result.usage).toEqual({ inputTokens: 37, outputTokens: 8, costUsd: null })
    expect(result.structured).toEqual({ implemented: true })
  })
  it('keeps reviewer tools read-only and returns denied tool calls to the model', async () => {
    const sent: Record<string, unknown>[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      sent.push(JSON.parse(options!.body as string))
      return sent.length === 1
        ? response({ tool_calls: [{ id: 'bad', type: 'function', function: { name: 'write_file', arguments: '{"path":"file","content":"bad"}' } }] })
        : response({ content: '{"approved":false}' })
    })
    await new OpenAICompatibleExecutor(provider, { fetch }).execute(request({ role: 'reviewer' }))
    expect(JSON.stringify(sent[0].tools)).not.toContain('write_file')
    expect(JSON.stringify((sent[1].messages as unknown[]).at(-1))).toContain('unavailable')
  })
  it('fails exhausted turns instead of treating a tool result as completion', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ tool_calls: [{ id: 'list', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] }))
    await expect(new OpenAICompatibleExecutor(provider, { fetch }).execute(request({ maxTurns: 1 }))).rejects.toMatchObject({ code: 'max_turns' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    [response({ content: 'partial' }, undefined, 'length'), 'incomplete_response'],
    [response({ content: null, tool_calls: [{ id: 'bad', type: 'function', function: {} }] }), 'invalid_tool_call'],
    [new Response('{"error":{"message":"sensitive-details"}}', { status: 429 }), 'provider_http_error'],
    [new Response('not json'), 'provider_request_error'],
  ])('rejects incomplete, malformed and failed responses without echoing bodies', async (output, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => output)
    await expect(new OpenAICompatibleExecutor(provider, { fetch }).execute(request())).rejects.toMatchObject({ code })
  })
  it('enforces token budgets and fails closed when required usage is absent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ content: 'done' }, { prompt_tokens: 30, completion_tokens: 2 }))
    await expect(new OpenAICompatibleExecutor(provider, { fetch }).execute(request({ maxTokens: 20 }))).rejects.toMatchObject({ code: 'token_budget', usage: { inputTokens: 30, outputTokens: 2 } })
    const absent = vi.fn<typeof globalThis.fetch>(async () => response({ content: 'done' }))
    await expect(new OpenAICompatibleExecutor(provider, { fetch: absent }).execute(request({ maxTokens: 20 }))).rejects.toMatchObject({ code: 'usage_unavailable' })
  })
  it('rejects an unsupported strict dollar cap or missing key before making a request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(new OpenAICompatibleExecutor(provider, { fetch }).execute(request({ maxCostUsd: 1 }))).rejects.toMatchObject({ code: 'cost_limit_unsupported' })
    await expect(new OpenAICompatibleExecutor({ ...provider, apiKeyEnv: 'LOCAL_AI_KEY' }, { fetch, env: {} }).execute(request())).rejects.toMatchObject({ code: 'missing_credential' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('passes credentials only through the authorization header and disables redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer private-key' })
      expect(options?.body).not.toContain('private-key')
      expect(options?.redirect).toBe('error')
      return response({ content: 'done' })
    })
    expect((await new OpenAICompatibleExecutor({ ...provider, apiKeyEnv: 'LOCAL_AI_KEY' }, { fetch, env: { LOCAL_AI_KEY: 'private-key' } }).execute(request())).usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null })
  })
  it('aborts a hung HTTP request on cancellation or timeout', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => new Promise((_resolve, reject) => {
      const signal = options!.signal!
      if (signal.aborted) reject(new Error('aborted'))
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const controller = new AbortController()
    const pending = new OpenAICompatibleExecutor(provider, { fetch }).execute(request({ signal: controller.signal }))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    await expect(new OpenAICompatibleExecutor(provider, { fetch }).execute(request({ timeoutMs: 10 }))).rejects.toMatchObject({ code: 'timeout' })
  })
  it('works against a real offline local HTTP endpoint with no key or proprietary SDK', async () => {
    const server = createServer((incoming, outgoing) => {
      expect(incoming.url).toBe('/v1/chat/completions')
      expect(incoming.headers.authorization).toBeUndefined()
      incoming.resume()
      incoming.on('end', () => outgoing.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })))
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address() as { port: number }
    const result = await new OpenAICompatibleExecutor({ ...provider, baseUrl: `http://127.0.0.1:${address.port}/v1/` }).execute(request())
    expect(result.structured).toEqual({ ok: true })
  })
})
