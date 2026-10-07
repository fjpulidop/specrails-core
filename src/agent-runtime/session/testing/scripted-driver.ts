import type { DriverCapabilities, DriverDescriptor } from '../domain/types.js'
import type { CloseReason, DriverCatalog, DriverEvent, DriverEventSink, DriverFactory, DriverInput, DriverOpenSpec, DriverSession } from '../ports.js'

export function descriptor(id: string, capabilities: Partial<DriverCapabilities> = {}): DriverDescriptor {
  return {
    id,
    displayName: id,
    capabilities: {
      resident: true,
      nativeInputQueue: true,
      subagents: 'supported',
      subagentDisable: true,
      autonomousContinuation: true,
      steer: true,
      usage: { costUsd: 'session-cumulative', tokens: 'per-turn' },
      ...capabilities,
    },
  }
}

/** One opened provider process, driven by the test through `emit`. */
export class ScriptedDriverSession implements DriverSession {
  readonly sent: DriverInput[] = []
  readonly calls: string[] = []
  closed: CloseReason | null = null
  /** What `stopSubagents` resolves with. */
  stopResult: string[] | 'process' = 'process'
  /** Events emitted while closing (e.g. Claude's stopped/killed notifications on SIGTERM). */
  onClose: DriverEvent[] = []

  constructor(readonly spec: DriverOpenSpec, private readonly sink: DriverEventSink) {}

  emit(...events: DriverEvent[]): void {
    if (this.closed) throw new Error('scripted driver: emit after close')
    for (const event of events) this.sink(event)
  }

  async send(input: DriverInput): Promise<void> { this.calls.push(`send:${input.inputId}`); this.sent.push(input) }
  async interrupt(): Promise<void> { this.calls.push('interrupt') }
  async stopSubagents(ids?: string[]): Promise<string[] | 'process'> { this.calls.push(`stopSubagents:${ids?.join(',') ?? '*'}`); return this.stopResult }

  async close(reason: CloseReason): Promise<void> {
    if (this.closed) return
    this.calls.push(`close:${reason}`)
    for (const event of this.onClose) this.sink(event)
    this.closed = reason
  }
}

export class ScriptedDriverFactory implements DriverFactory {
  readonly sessions: ScriptedDriverSession[] = []
  openError: Error | null = null

  constructor(readonly descriptor: DriverDescriptor) {}

  async open(spec: DriverOpenSpec, sink: DriverEventSink): Promise<DriverSession> {
    if (this.openError) throw this.openError
    const session = new ScriptedDriverSession(spec, sink)
    this.sessions.push(session)
    return session
  }

  get last(): ScriptedDriverSession {
    const session = this.sessions.at(-1)
    if (!session) throw new Error('scripted driver: no session opened')
    return session
  }
}

export function catalogOf(...factories: DriverFactory[]): DriverCatalog {
  const map = new Map(factories.map((factory) => [factory.descriptor.id, factory]))
  return { get: (id) => map.get(id), descriptors: () => factories.map((factory) => factory.descriptor) }
}
