import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createEngineTelemetry } from './otel.js'
import { traceIdFor } from './events.js'
import type { DurableEngineEvent } from './contracts.js'

afterEach(() => vi.unstubAllEnvs())
const event = (sequence: number): DurableEngineEvent => ({ runId: 'run', sequence, type: 'step_succeeded', timestamp: '2026-09-26T00:00:00.000Z', nodePath: 'review', attemptId: 'attempt', payload: { secret: 'provider output must stay local' } })

describe('optional OTLP event spans', () => {
  it('stays disabled without an endpoint and isolates invalid configuration errors', () => {
    vi.stubEnv('SPECRAILS_OTEL_ENDPOINT', '')
    expect(createEngineTelemetry()).toBeUndefined()
    const errors: unknown[] = []
    expect(createEngineTelemetry({ endpoint: 'file:///tmp/traces', onError: error => errors.push(error) })).toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(() => createEngineTelemetry({ endpoint: 'bad', onError: () => { throw Error('observer') } })).not.toThrow()
  })

  it('exports bounded OTLP JSON to a real fake collector with stable IDs and no private payloads', async () => {
    const requests: Array<{ url?: string; contentType?: string; body: string }> = []
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += String(chunk)
      requests.push({ url: request.url, contentType: request.headers['content-type'], body })
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}')
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const telemetry = createEngineTelemetry({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/collector`, maxQueue: 2 })!
    try {
      telemetry.observe(event(1)); telemetry.observe(event(1)); telemetry.observe(event(2))
      await telemetry.close()
      telemetry.observe(event(3))
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ url: '/collector/v1/traces', contentType: 'application/json' })
      expect(requests[0].body).not.toContain('must stay local')
      const spans = JSON.parse(requests[0].body).resourceSpans[0].scopeSpans[0].spans
      expect(spans).toHaveLength(2)
      expect(spans[0]).toMatchObject({ traceId: traceIdFor('run'), spanId: expect.stringMatching(/^[0-9a-f]{16}$/), kind: 1, startTimeUnixNano: '1790380800000000000', endTimeUnixNano: '1790380800000000000' })
      expect(spans[0].spanId).not.toBe(spans[1].spanId)
    } finally { await telemetry.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('bounds queues and collector failures without rejecting execution observers', async () => {
    const errors: unknown[] = [], fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('collector unavailable'))
    const telemetry = createEngineTelemetry({ endpoint: 'http://127.0.0.1:4318/v1/traces', maxQueue: 2, onError: error => errors.push(error) })!
    try {
      for (let i = 1; i <= 10; i++) telemetry.observe(event(i))
      await expect(telemetry.close()).resolves.toBeUndefined()
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(errors.map(String)).toEqual(['Error: collector unavailable', 'Error: Telemetry queue discarded 8 events'])
    } finally { fetch.mockRestore() }
  })
})
