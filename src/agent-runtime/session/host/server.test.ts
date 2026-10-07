import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createSessionRuntime, type SessionRuntime } from '../index.js'
import { FakeClock, SequentialIds } from '../testing/fake-clock.js'
import { ScriptedDriverFactory, catalogOf, descriptor } from '../testing/scripted-driver.js'
import { SessionHost } from './server.js'

type Json = Record<string, unknown>
const roots: string[] = []
const runtimes: SessionRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const tick = () => new Promise((resolve) => setImmediate(resolve))

class Client {
  private nextId = 1
  private buffer = ''
  readonly messages: Json[] = []
  constructor(private readonly input: PassThrough, output: PassThrough) {
    output.on('data', (chunk) => {
      this.buffer += String(chunk)
      let index
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1)
        this.messages.push(JSON.parse(line) as Json)
      }
    })
  }
  raw(line: string) { this.input.write(`${line}\n`) }
  async call(method: string, params: Json = {}): Promise<Json> {
    const id = this.nextId++
    this.raw(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = this.messages.find((message) => message.id === id)
      if (found) return found
      await tick()
    }
    throw new Error(`no response to ${method}`)
  }
  notifications(method: string) { return this.messages.filter((message) => message.method === method).map((message) => message.params as Json) }
}

async function boot(options: { queueLimit?: number; output?: PassThrough } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'session host ')); roots.push(home)
  const factory = new ScriptedDriverFactory(descriptor('scripted'))
  const runtime = await createSessionRuntime({ scope: 'proj', home, drivers: catalogOf(factory), clock: new FakeClock(), ids: new SequentialIds() })
  runtimes.push(runtime)
  const input = new PassThrough()
  const output = options.output ?? new PassThrough()
  const host = new SessionHost({ service: runtime.service, scope: 'proj', identity: { coreVersion: 'test' }, close: () => runtime.close() }, { input, output }, { notificationQueueLimit: options.queueLimit ?? 5_000 })
  const done = host.start()
  const client = new Client(input, output)
  return { home, factory, runtime, host, done, client, input, output }
}

const policy = { subagents: 'enabled' }

describe('SessionHost protocol', () => {
  it('requires initialize, negotiates the version and checks the scope', async () => {
    const { client } = await boot()
    expect(((await client.call('session.list')).error as Json).data).toMatchObject({ code: 'not_initialized' })
    expect(((await client.call('initialize', { protocolVersions: [99], host: { name: 't', version: '1' } })).error as Json).data).toMatchObject({ code: 'protocol_mismatch', detail: { supported: [1] } })
    expect(((await client.call('initialize', { protocolVersions: [1], host: { name: 't', version: '1' }, scope: 'other' })).error as Json).data).toMatchObject({ code: 'invalid_params' })
    const ok = (await client.call('initialize', { protocolVersions: [1, 2], host: { name: 't', version: '1' }, scope: 'proj' })).result as Json
    expect(ok).toMatchObject({ protocolVersion: 1, scope: 'proj', capabilities: { sessions: 1 }, runtime: { coreVersion: 'test' } })
    expect((ok.drivers as Json[]).map((driver) => driver.id)).toEqual(['scripted'])
  })

  it('maps malformed input, unknown methods, schema violations and domain errors to stable errors', async () => {
    const { client } = await boot()
    await client.call('initialize', { protocolVersions: [1], host: { name: 't', version: '1' } })
    client.raw('{not json')
    await tick()
    expect(client.messages.find((message) => (message.error as Json | undefined)?.code === -32700)).toBeTruthy()
    expect(((await client.call('session.explode')).error as Json).code).toBe(-32601)
    const invalid = (await client.call('session.send', { sessionId: 's', input: { inputId: 'i', text: 'x', delivery: 'shout' } })).error as Json
    expect(invalid.code).toBe(-32602)
    expect((invalid.data as Json).detail).toMatchObject({ path: expect.stringContaining('/input') })
    expect(((await client.call('session.open', { driver: 'scripted', model: 'm', cwd: '/r', policy: { subagents: 'enabled' }, extra: 1 })).error as Json).code).toBe(-32602)
    expect(((await client.call('session.snapshot', { sessionId: 'ghost' })).error as Json).data).toMatchObject({ code: 'session_not_found', retryable: false })
    expect(((await client.call('session.open', { driver: 'nope', model: 'm', cwd: '/r', policy })).error as Json).data).toMatchObject({ code: 'driver_unavailable' })
  })

  it('streams committed events as gap-free notifications that equal the journal replay', async () => {
    const { client, factory } = await boot()
    await client.call('initialize', { protocolVersions: [1], host: { name: 't', version: '1' } })
    const opened = (await client.call('session.open', { driver: 'scripted', model: 'm', cwd: '/repo', policy, metadata: { conversationId: 'c1' } })).result as Json
    const sessionId = String(opened.sessionId)
    expect((await client.call('session.send', { sessionId, input: { inputId: 'u1', text: 'hi', delivery: 'queue' } })).result).toEqual({ inputId: 'u1', state: 'accepted' })
    factory.last.emit(
      { kind: 'input.receipt', inputId: 'u1', state: 'started' },
      { kind: 'turn.started', trigger: 'input', inputIds: ['u1'] },
      { kind: 'turn.completed', status: 'completed', text: 'hello', usage: { costUsd: 0.01 } },
    )
    await tick(); await tick()
    const live = client.notifications('session.event')
    expect(live.map((params) => params.seq)).toEqual(live.map((_, index) => index + 1))
    const replay = (await client.call('session.events', { sessionId, afterSeq: 0 })).result as Json
    expect((replay.events as Json[]).map((envelope) => envelope.event)).toEqual(live.map((params) => params.event))
    expect(((await client.call('session.snapshot', { sessionId })).result as Json)).toMatchObject({ phase: 'idle', turnCount: 1 })
    expect(((await client.call('session.list')).result as Json).sessions).toMatchObject([{ sessionId, metadata: { conversationId: 'c1' } }])
    expect(((await client.call('host.ping')).result as Json)).toMatchObject({ sessions: 1, residentProcesses: 1 })
  })

  it('marks a session lagged instead of growing the queue, without losing events', async () => {
    const { client, factory, output } = await boot({ queueLimit: 3, output: new PassThrough({ highWaterMark: 16 }) })
    await client.call('initialize', { protocolVersions: [1], host: { name: 't', version: '1' } })
    const sessionId = String(((await client.call('session.open', { driver: 'scripted', model: 'm', cwd: '/r', policy })).result as Json).sessionId)
    await client.call('session.send', { sessionId, input: { inputId: 'u1', text: 'hi', delivery: 'queue' } })
    // A consumer that stops reading creates real backpressure on the host's output.
    output.pause()
    for (let index = 0; index < 20; index++) factory.last.emit({ kind: 'diagnostic', level: 'info', code: `d${index}`, message: 'x' })
    await tick(); await tick()
    output.resume()
    await tick(); await tick()
    const lagged = client.notifications('session.lagged')
    expect(lagged.length).toBeGreaterThan(0)
    expect(lagged[0]).toMatchObject({ sessionId, deliveredSeq: expect.any(Number) })
    expect(client.notifications("session.event").length).toBeLessThan(23)
    const replay = (await client.call('session.events', { sessionId, afterSeq: 0, limit: 5000 })).result as Json
    expect((replay.events as Json[]).map((envelope) => envelope.seq)).toEqual(Array.from({ length: (replay.events as Json[]).length }, (_, index) => index + 1))
    expect((replay.events as Json[]).length).toBe(23)
  })

  it('shuts down on request: interrupts running work, releases the journal and resolves', async () => {
    const { client, factory, done, home } = await boot()
    await client.call('initialize', { protocolVersions: [1], host: { name: 't', version: '1' } })
    const sessionId = String(((await client.call('session.open', { driver: 'scripted', model: 'm', cwd: '/r', policy })).result as Json).sessionId)
    await client.call('session.send', { sessionId, input: { inputId: 'u1', text: 'hi', delivery: 'queue' } })
    factory.last.emit({ kind: 'turn.started', trigger: 'input', inputIds: ['u1'] })
    expect((await client.call('host.shutdown')).result).toEqual({})
    await done
    expect(factory.last.closed).toBe('shutdown')
    const successor = await createSessionRuntime({ scope: 'proj', home, drivers: catalogOf(new ScriptedDriverFactory(descriptor('scripted'))) })
    runtimes.push(successor)
    expect(successor.journal.lease.previous).toBe('released')
    expect(successor.service.snapshot(sessionId).turns.at(-1)?.status).toBe('interrupted')
  })

  it('stops when its input closes and rejects oversized frames', async () => {
    const { input, done, client } = await boot()
    client.raw('x'.repeat(2 * 1024 * 1024 + 10))
    await tick()
    expect(client.messages.some((message) => ((message.error as Json | undefined)?.data as Json | undefined)?.code === 'payload_too_large')).toBe(true)
    input.end()
    await done
  })

  it('tells the client when another host takes the scope over', async () => {
    const { client, host, done } = await boot()
    await client.call('initialize', { protocolVersions: [1], host: { name: 't', version: '1' } })
    host.leaseLost()
    await done
    expect(client.notifications('host.leaseLost')).toHaveLength(1)
  })
})

describe('runtime host binary', () => {
  const cli = fileURLToPath(new URL('../../../../dist/agent-runtime/cli.js', import.meta.url))

  it.skipIf(!existsSync(cli))('serves the protocol over stdio and stops cleanly', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'session host bin ')); roots.push(home)
    const child = spawn(process.execPath, [cli, 'host', '--stdio', '--scope', 'smoke'], { env: { ...process.env, SPECRAILS_REGISTRY_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: Json[] = []
    let buffer = ''
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    // Subscribe before any request: the host exits quickly after host.shutdown.
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      let index
      while ((index = buffer.indexOf('\n')) >= 0) { lines.push(JSON.parse(buffer.slice(0, index)) as Json); buffer = buffer.slice(index + 1) }
    })
    const call = async (id: number, method: string, params: Json = {}) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      for (let attempt = 0; attempt < 400; attempt++) {
        const found = lines.find((line) => line.id === id)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`no response to ${method}; stderr: ${stderr.slice(0, 2000)}; stdout: ${buffer.slice(0, 500)}`)
    }
    const init = (await call(1, 'initialize', { protocolVersions: [1], host: { name: 'smoke', version: '1' }, scope: 'smoke' })).result as Json
    expect(init).toMatchObject({ protocolVersion: 1, scope: 'smoke', capabilities: { sessions: 1 } })
    expect((init.drivers as Json[]).map((driver) => driver.id)).toEqual(['claude', 'codex', 'gemini', 'kimi'])
    expect((await call(2, 'session.list')).result).toEqual({ sessions: [] })
    expect(existsSync(path.join(home, '.specrails', 'sessions', 'smoke', 'sessions.sqlite'))).toBe(true)
    await call(3, 'host.shutdown')
    expect(await exited, stderr).toBe(0)
  })
})
