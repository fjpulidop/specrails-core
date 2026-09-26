import { createHash } from 'node:crypto'
import { EngineError, type DurableEngineEvent, type JsonObject, type JsonValue, type TransientEngineEvent } from './contracts.js'

export const MAX_EVENT_CHARACTERS = 1_000_000
export const traceIdFor = (runId: string): string => createHash('sha256').update(runId).digest('hex').slice(0, 32)

/** Bound log strings without dropping lifecycle identity or inventing usage. */
export function boundedJsonLine(value: JsonValue, maximum = MAX_EVENT_CHARACTERS): string {
  const trim = (entry: JsonValue, depth = 0): JsonValue => {
    if (depth > 64) throw new EngineError('output_limit', 'Event nesting exceeds 64 levels')
    if (typeof entry === 'string') return entry.length > 64_000 ? entry.slice(0, 63_980) + '\n[output truncated]' : entry
    if (Array.isArray(entry)) return entry.map(item => trim(item, depth + 1))
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, trim(item, depth + 1)]))
    return entry
  }
  const line = JSON.stringify(trim(value))
  if (line.length + 1 > maximum) throw new EngineError('output_limit', 'Event exceeds the JSONL transport limit')
  return line + '\n'
}

export function projectDurableEvent(event: DurableEngineEvent): JsonObject {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {}
  if (event.type === 'efficiency_updated') return {
    type: 'runtime-efficiency-event', schemaVersion: 1, eventId: `${event.runId}:${event.sequence}`,
    sequence: event.sequence, runId: event.runId, timestamp: event.timestamp, ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.nodePath ? { nodePath: event.nodePath } : {}), ...(event.branchId ? { branch: event.branchId } : {}),
    kind: 'role-context', payload: event.payload,
  }
  return { type: 'workflow-event', event: {
    ...payload, id: `${event.runId}:${event.sequence}`, sequence: event.sequence, runId: event.runId, traceId: traceIdFor(event.runId),
    type: event.type, timestamp: event.timestamp,
    ...(event.nodePath ? { nodePath: event.nodePath, stepId: event.nodePath } : {}),
    ...(event.scopeId ? { scopeId: event.scopeId } : {}), ...(event.branchId ? { branch: event.branchId } : {}),
    ...(event.visit === undefined ? {} : { visit: event.visit }), ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
  } }
}

/** The ledger supplies lifecycle truth. Provider progress is explicitly transient. */
export class EngineEventStream {
  private cursor: number
  constructor(private readonly read: (after: number) => DurableEngineEvent[],
    private readonly emit: (value: JsonObject) => void, after = 0,
    private readonly observerError: (error: unknown) => void = () => {},
    private readonly onDurable?: (event: DurableEngineEvent) => void) { this.cursor = after }

  send(value: JsonObject): void {
    try { this.emit(JSON.parse(boundedJsonLine(value)) as JsonObject) }
    catch (error) { try { this.observerError(error) } catch { /* Observers cannot replay committed effects. */ } }
  }

  flush(): void {
    for (const event of this.read(this.cursor)) {
      if (event.sequence <= this.cursor) throw new EngineError('event_sequence_conflict', 'Durable events must advance monotonically')
      try { this.onDurable?.(event) } catch (error) { try { this.observerError(error) } catch { /* Optional telemetry cannot affect committed work. */ } }
      this.send(projectDurableEvent(event))
      this.cursor = event.sequence
    }
  }

  progress(event: TransientEngineEvent): void {
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : { payload: event.payload }
    this.send({ ...payload, type: event.type })
  }
}
