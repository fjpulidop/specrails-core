import { createHash } from 'node:crypto'
import { EngineError, type DurableEngineEvent, type JsonObject } from './contracts.js'
import { traceIdFor } from './events.js'

export interface EngineTelemetry {
  observe(event: DurableEngineEvent): void
  flush(): Promise<void>
  close(): Promise<void>
}
interface TelemetryOptions {
  endpoint?: string
  onError?: (error: unknown) => void
  timeoutMs?: number
  maxQueue?: number
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** Explicitly enabled OTLP/HTTP observer. Lifecycle metadata only; never a source of execution truth. */
export function createEngineTelemetry(options: TelemetryOptions = {}): EngineTelemetry | undefined {
  const configured = options.endpoint ?? process.env.SPECRAILS_OTEL_ENDPOINT
  if (!configured) return undefined
  const report = (error: unknown) => { try { options.onError?.(error) } catch { /* Optional diagnostics cannot fail a run. */ } }
  let endpoint: URL
  try {
    endpoint = new URL(configured)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Telemetry endpoint must be an HTTP(S) URL without credentials, query or fragment')
    endpoint.pathname = endpoint.pathname.replace(/\/$/, '').endsWith('/v1/traces') ? endpoint.pathname.replace(/\/$/, '') : endpoint.pathname.replace(/\/$/, '') + '/v1/traces'
  } catch (error) { report(error); return undefined }
  const maximum = options.maxQueue ?? 512, timeoutMs = options.timeoutMs ?? 3000
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    report(new EngineError('invalid_arguments', 'Telemetry queue or timeout exceeds its bound')); return undefined
  }
  const queue: JsonObject[] = []
  // Every observer belongs to one running stream. Cursor storage stays bounded across long executions.
  const cursors = new Map<string, number>()
  let closed = false, draining: Promise<void> | undefined, timer: NodeJS.Timeout | undefined, dropped = 0

  async function send(spans: JsonObject[]): Promise<void> {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'specrails-core' } }] }, scopeSpans: [{ scope: { name: 'specrails.agent-engine', version: '2' }, spans }] }] }) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Telemetry collector returned HTTP ${response.status}`) }
    const reader = response.body?.getReader()
    if (!reader) return
    let bytes = 0; const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 64 * 1024) throw new Error('Telemetry collector response exceeds 64 KiB')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (bytes) {
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { partialSuccess?: { rejectedSpans?: number | string; errorMessage?: string } }
      if (Number(result.partialSuccess?.rejectedSpans ?? 0) > 0) throw new Error('Telemetry collector rejected spans')
    }
  }

  const flush = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = undefined }
    if (draining) return draining
    const work = async () => {
      while (queue.length) {
        const batch = queue.splice(0, 64)
        try { await send(batch) } catch (error) { report(error) }
      }
      if (dropped) { report(new Error(`Telemetry queue discarded ${dropped} events`)); dropped = 0 }
    }
    draining = work().finally(() => { draining = undefined })
    return draining
  }
  return {
    observe(event) {
      if (closed) return
      try {
        if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error('Telemetry event sequence is invalid')
        if ((cursors.get(event.runId) ?? 0) >= event.sequence) return
        if (!cursors.has(event.runId) && cursors.size >= 16) throw new Error('Telemetry observer exceeds its run bound')
        cursors.set(event.runId, event.sequence)
        if (queue.length >= maximum) { dropped++; return }
        const millis = Date.parse(event.timestamp)
        if (!Number.isFinite(millis) || millis < 0) throw new Error('Telemetry event timestamp is invalid')
        const nano = (BigInt(millis) * 1_000_000n).toString()
        const attributes = Object.entries({ 'specrails.run.id': event.runId, 'specrails.event.type': event.type,
          ...(event.nodePath ? { 'specrails.node.path': event.nodePath } : {}), ...(event.scopeId ? { 'specrails.scope.id': event.scopeId } : {}),
          ...(event.attemptId ? { 'specrails.attempt.id': event.attemptId } : {}), ...(event.branchId ? { 'specrails.branch.id': event.branchId } : {}),
        }).map(([key, value]) => ({ key, value: { stringValue: value.slice(0, 512) } }))
        // Event spans are points in durable history, so no provider duration is inferred from them.
        queue.push({ traceId: traceIdFor(event.runId), spanId: hash(`${event.runId}:${event.sequence}`).slice(0, 16), name: event.type.slice(0, 128), kind: 1,
          startTimeUnixNano: nano, endTimeUnixNano: nano, attributes: [...attributes, { key: 'specrails.event.sequence', value: { intValue: String(event.sequence) } }],
          status: { code: /_(failed|interrupted|blocked)$/.test(event.type) ? 2 : 0 },
        })
        if (queue.length >= 64) void flush()
        else if (!timer && !draining) { timer = setTimeout(() => { void flush() }, 1000); timer.unref() }
      } catch (error) { report(error) }
    }, flush,
    async close() { closed = true; await flush() },
  }
}
