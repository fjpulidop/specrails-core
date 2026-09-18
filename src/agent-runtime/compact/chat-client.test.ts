import { describe, expect, it } from 'vitest'
import { ChatClient, readCompletionResponse } from './chat-client.js'
import { compactMessages } from './guarded-loop.js'
import { vi } from 'vitest'

function sse(lines: string[]): Response {
  return new Response(lines.map(line => `data: ${line}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ choices: [{ delta, ...extra }] })

describe('readCompletionResponse', () => {
  it('assembles streamed text, fragmented tool calls by index and the trailing usage into the classic shape', async () => {
    const body = sse([
      chunk({ role: 'assistant', content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_', arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } }] }),
      chunk({}, { finish_reason: 'tool_calls' }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
      '[DONE]',
    ])
    const result = await readCompletionResponse(body) as { choices: Array<{ message: Record<string, unknown>; finish_reason: unknown }>; usage: unknown }
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 7 })
    expect(result.choices[0]!.finish_reason).toBe('tool_calls')
    expect(result.choices[0]!.message).toEqual({ role: 'assistant', content: 'Hello', tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
      { id: 'call_b', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
    ] })
  })
  it('returns null content for a pure tool turn, an empty string for a silent turn, and surfaces stream errors', async () => {
    const tools = await readCompletionResponse(sse([chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'f', arguments: '{}' } }] }), '[DONE]'])) as { choices: Array<{ message: { content: unknown }; finish_reason: unknown }> }
    expect(tools.choices[0]!.message.content).toBeNull()
    expect(tools.choices[0]!.finish_reason).toBe('tool_calls')
    const silent = await readCompletionResponse(sse([chunk({}), '[DONE]'])) as { choices: Array<{ message: { content: unknown }; finish_reason: unknown }> }
    expect(silent.choices[0]!.message.content).toBe('')
    expect(silent.choices[0]!.finish_reason).toBe('stop')
    expect(await readCompletionResponse(sse([JSON.stringify({ error: { message: 'boom' } })]))).toEqual({ error: { message: 'boom' } })
  })
  it('falls back to a plain JSON body when the server ignored stream', async () => {
    const plain = new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
    expect(await readCompletionResponse(plain)).toMatchObject({ choices: [{ message: { content: 'hi' } }] })
  })
  it('tolerates CRLF framing and garbage lines', async () => {
    const body = new Response(`data: ${chunk({ content: 'a' })}\r\n\r\nnot-a-data-line\r\ndata: {broken\r\n\r\ndata: ${chunk({ content: 'b' })}\r\n\r\ndata: [DONE]\r\n`, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
    expect(await readCompletionResponse(body)).toMatchObject({ choices: [{ message: { content: 'ab' } }] })
  })
})


describe('ChatClient transient failures', () => {
  it('retries once after a 5xx and after a network error, then surfaces a persistent failure', async () => {
    const ok = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
    let calls = 0
    const flaky = vi.fn(async () => (++calls === 1 ? new Response('boom', { status: 500 }) : ok())) as unknown as typeof globalThis.fetch
    const client = new ChatClient({ endpoint: new URL('http://h/v1/chat/completions'), headers: {}, fetch: flaky, signal: new AbortController().signal, model: 'm' })
    expect((await client.complete({ messages: [{ role: 'user', content: 'x' }] })).message.content).toBe('hi')
    expect(calls).toBe(2)
    calls = 0
    const reset = vi.fn(async () => { if (++calls === 1) throw new TypeError('fetch failed'); return ok() }) as unknown as typeof globalThis.fetch
    expect((await new ChatClient({ endpoint: new URL('http://h/v1/chat/completions'), headers: {}, fetch: reset, signal: new AbortController().signal, model: 'm' }).complete({ messages: [] })).message.content).toBe('hi')
    const dead = vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof globalThis.fetch
    await expect(new ChatClient({ endpoint: new URL('http://h/v1/chat/completions'), headers: {}, fetch: dead, signal: new AbortController().signal, model: 'm' }).complete({ messages: [] })).rejects.toThrow('HTTP 503')
    expect(dead).toHaveBeenCalledTimes(2)
  }, 20_000)
})

describe('compaction of executed write calls', () => {
  it('replaces large write_file/apply_patch arguments with the path once the file is on disk, never small or read calls', () => {
    const big = 'x'.repeat(2000)
    const messages = [
      { role: 'system' as const, content: 's' }, { role: 'user' as const, content: 'u' },
      { role: 'assistant' as const, content: '', tool_calls: [
        { id: 'w', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts', content: big }) } },
        { id: 'r', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/b.ts' }) } },
      ] },
      { role: 'tool' as const, tool_call_id: 'w', content: 'written' },
      { role: 'tool' as const, tool_call_id: 'r', content: 'y'.repeat(2000) },
      { role: 'assistant' as const, content: 'ok' }, { role: 'user' as const, content: 'next' }, { role: 'assistant' as const, content: 'k' }, { role: 'user' as const, content: 'n2' }, { role: 'assistant' as const, content: 'k2' },
    ]
    const before = JSON.stringify(messages).length
    const compacted = compactMessages(messages, 1024, new Map([['w', { name: 'write_file', args: '{}' }], ['r', { name: 'read_file', args: '{}' }]]))
    expect(compacted).toBeGreaterThan(0)
    const assistant = messages[2] as { tool_calls: Array<{ function: { name: string; arguments: string } }> }
    expect(assistant.tool_calls[0]!.function.arguments).toContain('already applied to src/a.ts')
    expect(assistant.tool_calls[0]!.function.arguments.length).toBeLessThan(200)
    expect(assistant.tool_calls[1]!.function.arguments).toBe(JSON.stringify({ path: 'src/b.ts' }))
    expect(JSON.stringify(messages).length).toBeLessThan(before - 1500)
  })
})


describe('reasoning_effort rejected per model', () => {
  it('drops the field for the session after a 400 "does not support thinking" and resends', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (body.reasoning_effort) return new Response(JSON.stringify({ error: { message: '"qwen2.5:14b" does not support thinking' } }), { status: 400 })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch
    const events: string[] = []
    const client = new ChatClient({ endpoint: new URL('http://h/v1/chat/completions'), headers: {}, fetch, signal: new AbortController().signal, model: 'qwen2.5:14b', effortSupported: true, reasoningEffort: 'low', onEvent: event => { if (event.kind === 'text') events.push(event.text ?? '') } })
    expect((await client.complete({ messages: [] })).message.content).toBe('hi')
    expect((await client.complete({ messages: [] }, { reasoningEffort: 'high' })).message.content).toBe('hi')
    expect(bodies.map(body => body.reasoning_effort)).toEqual(['low', undefined, undefined])
    expect(client.defaultEffort).toBeUndefined()
    expect(events.some(text => text.includes('rejected reasoning_effort'))).toBe(true)
    // An unrelated 400 still surfaces as an HTTP error.
    const other = vi.fn(async () => new Response('bad request', { status: 400 })) as unknown as typeof globalThis.fetch
    await expect(new ChatClient({ endpoint: new URL('http://h/v1/chat/completions'), headers: {}, fetch: other, signal: new AbortController().signal, model: 'm', effortSupported: true, reasoningEffort: 'low' }).complete({ messages: [] })).rejects.toThrow('HTTP 400')
  })
})

describe('patient dispatcher', () => {
  it('materializes the lazily created global undici dispatcher and dispatches with body/headers timeouts off', async () => {
    const { ensurePatientDispatcher, patientFetchInit } = await import('./chat-client.js')
    await ensurePatientDispatcher()
    const init = patientFetchInit()
    expect(init.dispatcher).toBeDefined()
    const dispatcher = init.dispatcher as unknown as Record<symbol, unknown>
    const options = Object.getOwnPropertySymbols(dispatcher).map(symbol => dispatcher[symbol]).find(value => value && typeof value === 'object' && 'bodyTimeout' in (value as object)) as { bodyTimeout?: number; headersTimeout?: number } | undefined
    if (options) { expect(options.bodyTimeout).toBe(0); expect(options.headersTimeout).toBe(0) }
  })
})
