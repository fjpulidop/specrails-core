import type { SessionEvent, SessionEventEnvelope } from '../domain/events.js'
import { emptySnapshot, foldEvents, type SessionSnapshot } from '../domain/snapshot.js'
import type { UsageBaseline } from '../domain/usage.js'
import type { AppendOptions, SessionJournal, SessionRecord, SessionSummary } from '../ports.js'

/**
 * In-memory SessionJournal with the same contract as the SQLite adapter:
 * gap-free sequences, atomic appends, baselines stored with their events.
 * `failNextAppend` simulates a failed transaction (nothing becomes visible).
 */
export class MemoryJournal implements SessionJournal {
  private readonly sessions = new Map<string, { record: SessionRecord; events: SessionEventEnvelope[]; snapshot: SessionSnapshot }>()
  private readonly baselines = new Map<string, UsageBaseline>()
  failNextAppend: Error | null = null

  createSession(record: SessionRecord): void {
    if (this.sessions.has(record.sessionId)) throw new Error(`Session ${record.sessionId} exists`)
    this.sessions.set(record.sessionId, { record: { ...record }, events: [], snapshot: emptySnapshot(record.sessionId) })
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.sessions.get(sessionId)?.record ?? null
  }

  append(sessionId: string, events: SessionEvent[], options?: AppendOptions): SessionEventEnvelope[] {
    const entry = this.require(sessionId)
    if (this.failNextAppend) { const error = this.failNextAppend; this.failNextAppend = null; throw error }
    const envelopes = events.map((event, index) => ({ sessionId, seq: entry.snapshot.lastSeq + index + 1, event: structuredClone(event) }))
    const snapshot = foldEvents(entry.snapshot, envelopes)
    entry.events.push(...envelopes)
    entry.snapshot = snapshot
    if (options?.baseline) this.baselines.set(options.baseline.providerRef, { ...options.baseline.value })
    return envelopes.map((envelope) => structuredClone(envelope))
  }

  read(sessionId: string, afterSeq: number, limit: number): { events: SessionEventEnvelope[]; hasMore: boolean } {
    const all = this.require(sessionId).events.filter((envelope) => envelope.seq > afterSeq)
    return { events: structuredClone(all.slice(0, limit)), hasMore: all.length > limit }
  }

  snapshot(sessionId: string): SessionSnapshot | null {
    const entry = this.sessions.get(sessionId)
    return entry ? structuredClone(entry.snapshot) : null
  }

  list(filter: 'open' | 'closed' | 'all'): SessionSummary[] {
    return [...this.sessions.values()]
      .filter(({ snapshot }) => filter === 'all' || snapshot.status === filter)
      .map(({ record, snapshot }) => ({
        sessionId: record.sessionId,
        driver: record.driver,
        model: snapshot.model,
        status: snapshot.status,
        phase: snapshot.phase,
        lastSeq: snapshot.lastSeq,
        createdAt: record.createdAt,
        metadata: { ...record.metadata },
      }))
  }

  baseline(providerRef: string): UsageBaseline | null {
    const value = this.baselines.get(providerRef)
    return value ? { ...value } : null
  }

  /** Test helper: every committed event of a session. */
  events(sessionId: string): SessionEventEnvelope[] {
    return structuredClone(this.require(sessionId).events)
  }

  private require(sessionId: string) {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`Unknown session ${sessionId}`)
    return entry
  }
}
