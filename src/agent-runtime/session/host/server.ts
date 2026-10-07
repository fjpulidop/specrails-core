import { StringDecoder } from 'node:string_decoder'

import type { SessionService } from '../application/session-service.js'
import { SessionError, isSessionError } from '../domain/errors.js'
import type { SessionEventEnvelope } from '../domain/events.js'
import {
  MAX_FRAME_BYTES,
  RPC_APPLICATION_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  SESSION_PROTOCOL_VERSIONS,
  validatorFor,
} from './protocol.js'

type Json = Record<string, unknown>
type RpcId = string | number

/** What the composition root hands the host. */
export interface HostRuntime {
  service: SessionService
  scope: string
  identity: Json
  /** Retire providers, record interruptions and release the journal. */
  close(): Promise<void>
}

export interface HostIo {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
}

export interface SessionHostOptions {
  /** Queued notifications before the busiest session is marked lagged. */
  notificationQueueLimit?: number
  /** Default grace for provider shutdown. */
  shutdownGraceMs?: number
}

type Handler = (params: Json) => Promise<unknown>

/**
 * JSON-RPC 2.0 server over NDJSON stdio (session protocol v1).
 * One handler per method (closed table); each validates its params with a
 * closed schema and calls exactly one application use case.
 */
export class SessionHost {
  private initialized = false
  private stopping: Promise<void> | null = null
  private readonly lastSent = new Map<string, number>()
  private readonly notifications: Array<{ sessionId: string; seq: number; line: string }> = []
  private readonly responses: string[] = []
  private writing = false
  private readonly handlers: Readonly<Record<string, Handler>>
  private unsubscribe: (() => void) | null = null
  private finished!: () => void
  readonly done: Promise<void> = new Promise((resolve) => { this.finished = resolve })

  constructor(private readonly runtime: HostRuntime, private readonly io: HostIo, private readonly options: SessionHostOptions = {}) {
    const service = runtime.service
    this.handlers = Object.freeze({
      'initialize': async (params) => this.initialize(params),
      'session.open': async (params) => service.open(params as never),
      'session.send': async (params) => service.send(String(params.sessionId), params.input as never),
      'session.interrupt': async (params) => service.interrupt(String(params.sessionId)),
      'session.delegate': async (params) => service.delegate(String(params.sessionId), {
        description: String(params.description),
        prompt: String(params.prompt),
        ...(typeof params.agentType === 'string' ? { agentType: params.agentType } : {}),
        ...(typeof params.contextTurns === 'number' ? { contextTurns: params.contextTurns } : {}),
      }),
      'session.waitSubagents': async (params) => service.waitSubagents(String(params.sessionId), Array.isArray(params.subagentIds) ? params.subagentIds.map(String) : undefined, Number(params.timeoutMs)),
      'session.stopSubagents': async (params) => service.stopSubagents(String(params.sessionId), params.subagentIds as string[] | undefined),
      'session.update': async (params) => { const { sessionId, ...changes } = params; return service.update(String(sessionId), changes as never) },
      'session.close': async (params) => { await service.close(String(params.sessionId), String(params.reason)); return {} },
      'session.snapshot': async (params) => service.snapshot(String(params.sessionId)),
      'session.events': async (params) => service.events(String(params.sessionId), Number(params.afterSeq), params.limit === undefined ? undefined : Number(params.limit)),
      'session.list': async (params) => ({ sessions: service.list((params.state as 'open' | 'closed' | 'all' | undefined) ?? 'open') }),
      'host.ping': async () => ({ ...service.stats(), uptimeMs: Math.round(process.uptime() * 1000) }),
      'host.shutdown': async () => { setImmediate(() => void this.stop()); return {} },
    })
  }

  /** Serve until input ends or `host.shutdown`; resolves after a clean stop. */
  start(): Promise<void> {
    this.unsubscribe = this.runtime.service.subscribe((envelopes) => this.publish(envelopes))
    const decoder = new StringDecoder('utf8')
    let pending = ''
    this.io.input.on('data', (chunk: Buffer | string) => {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (line.trim()) void this.handleLine(line)
      }
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
        pending = ''
        this.respondError(null, RPC_INVALID_REQUEST, `Request exceeds ${MAX_FRAME_BYTES} bytes`, { code: 'payload_too_large', retryable: false })
      }
    })
    this.io.input.on('end', () => void this.stop())
    return this.done
  }

  /** Another host took the journal: tell the client and stop without further writes. */
  leaseLost(): void {
    this.queueResponse(JSON.stringify({ jsonrpc: '2.0', method: 'host.leaseLost', params: {} }))
    void this.stop()
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.unsubscribe?.()
      try { await this.runtime.close() } catch (error) { process.stderr.write(`session host: shutdown failed: ${(error as Error).message}\n`) }
      await this.flush()
      this.finished()
    })()
    return this.stopping
  }

  // ── requests ──────────────────────────────────────────────────────────────

  private async handleLine(line: string): Promise<void> {
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      this.respondError(null, RPC_INVALID_REQUEST, `Request exceeds ${MAX_FRAME_BYTES} bytes`, { code: 'payload_too_large', retryable: false })
      return
    }
    let request: Json
    try { request = JSON.parse(line) as Json } catch {
      this.respondError(null, RPC_PARSE_ERROR, 'Invalid JSON', { code: 'invalid_params', retryable: false })
      return
    }
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null
    const method = request.method
    if (typeof method !== 'string') { this.respondError(id, RPC_INVALID_REQUEST, 'Missing method', { code: 'invalid_params', retryable: false }); return }
    if (id === null) return // notifications from the client carry no work in protocol v1
    const handler = Object.hasOwn(this.handlers, method) ? this.handlers[method] : undefined
    if (!handler) { this.respondError(id, RPC_METHOD_NOT_FOUND, `Unknown method ${method}`, { code: 'invalid_params', retryable: false }); return }
    if (this.stopping && method !== 'host.ping') { this.respondError(id, RPC_APPLICATION_ERROR, 'The session host is shutting down', { code: 'busy', retryable: true }); return }
    if (!this.initialized && method !== 'initialize' && method !== 'host.ping') {
      this.respondError(id, RPC_APPLICATION_ERROR, 'Call initialize first', { code: 'not_initialized', retryable: false })
      return
    }
    const params = (request.params ?? {}) as Json
    const validate = validatorFor(method)
    if (validate && !validate(params)) {
      const first = validate.errors?.[0]
      this.respondError(id, RPC_INVALID_PARAMS, `Invalid params${first ? ` at ${first.instancePath || '/'}: ${first.message ?? ''}` : ''}`, { code: 'invalid_params', retryable: false, detail: { path: first?.instancePath ?? '' } })
      return
    }
    try {
      const result = await handler(params)
      this.queueResponse(JSON.stringify({ jsonrpc: '2.0', id, result: result ?? {} }))
    } catch (error) {
      if (isSessionError(error)) {
        this.respondError(id, error.code === 'invalid_params' ? RPC_INVALID_PARAMS : RPC_APPLICATION_ERROR, error.message, { code: error.code, retryable: error.retryable, ...(error.detail ? { detail: error.detail } : {}) })
      } else {
        process.stderr.write(`session host: ${method} failed: ${(error as Error).stack ?? String(error)}\n`)
        this.respondError(id, RPC_APPLICATION_ERROR, (error as Error).message || 'Internal error', { code: 'internal', retryable: true })
      }
    }
  }

  private initialize(params: Json): Json {
    const requested = (params.protocolVersions as number[]).filter((version) => SESSION_PROTOCOL_VERSIONS.includes(version))
    if (requested.length === 0) {
      throw new SessionError('protocol_mismatch', `No common session protocol version; this host supports ${SESSION_PROTOCOL_VERSIONS.join(', ')}`, { supported: [...SESSION_PROTOCOL_VERSIONS] })
    }
    if (params.scope !== undefined && params.scope !== this.runtime.scope) {
      throw new SessionError('invalid_params', `This host serves scope "${this.runtime.scope}", not "${String(params.scope)}"`, { path: '/scope' })
    }
    this.initialized = true
    return {
      protocolVersion: Math.max(...requested),
      scope: this.runtime.scope,
      runtime: this.runtime.identity,
      // `delegation`: session.delegate / session.waitSubagents and subagentRuntime.mode 'delegated'.
      capabilities: { sessions: 1, delegation: 1 },
      drivers: this.runtime.service.drivers(),
    }
  }

  // ── output ────────────────────────────────────────────────────────────────

  private publish(envelopes: SessionEventEnvelope[]): void {
    if (!this.initialized) return
    for (const envelope of envelopes) {
      this.notifications.push({
        sessionId: envelope.sessionId,
        seq: envelope.seq,
        line: JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: envelope.sessionId, seq: envelope.seq, event: envelope.event } }),
      })
    }
    this.shed()
    void this.drain()
  }

  /** Keep the live feed bounded: drop the busiest session's queued events after a lag notice. */
  private shed(): void {
    const limit = this.options.notificationQueueLimit ?? 5_000
    while (this.notifications.length > limit) {
      const counts = new Map<string, number>()
      for (const item of this.notifications) counts.set(item.sessionId, (counts.get(item.sessionId) ?? 0) + 1)
      const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
      const kept = this.notifications.filter((item) => item.sessionId !== busiest)
      this.notifications.length = 0
      this.notifications.push(...kept)
      this.queueResponse(JSON.stringify({ jsonrpc: '2.0', method: 'session.lagged', params: { sessionId: busiest, deliveredSeq: this.lastSent.get(busiest) ?? 0 } }))
    }
  }

  private respondError(id: RpcId | null, code: number, message: string, data: Json): void {
    this.queueResponse(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }))
  }

  private queueResponse(line: string): void {
    this.responses.push(line)
    void this.drain()
  }

  /** Responses first (never dropped), then notifications; honours stream backpressure. */
  private async drain(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      for (;;) {
        const response = this.responses.shift()
        const notification = response === undefined ? this.notifications.shift() : undefined
        const line = response ?? notification?.line
        if (line === undefined) break
        if (notification) this.lastSent.set(notification.sessionId, notification.seq)
        if (!this.io.output.write(`${line}\n`)) await new Promise<void>((resolve) => this.io.output.once('drain', () => resolve()))
      }
    } finally {
      this.writing = false
    }
  }

  private async flush(): Promise<void> {
    await this.drain()
    while (this.responses.length > 0 || this.notifications.length > 0) await this.drain()
  }
}
