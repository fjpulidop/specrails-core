import { SessionError } from '../domain/errors.js'
import type { SessionEventEnvelope } from '../domain/events.js'
import { resolvePolicy, type SessionPolicyInput } from '../domain/policy.js'
import { liveSubagents, type SessionSnapshot } from '../domain/snapshot.js'
import type { Attachment, DriverDescriptor } from '../domain/types.js'
import type { RateCard } from '../domain/usage.js'
import type { Clock, DriverCatalog, Ids, SessionJournal, SessionSummary } from '../ports.js'
import { ActiveSession, type SessionConfig } from './active-session.js'
import { DelegationCoordinator, type DelegateParams, type DelegatedResult } from './delegation.js'
import type { OutputLimits } from './output-buffer.js'

export interface SessionServiceOptions {
  journal: SessionJournal
  drivers: DriverCatalog
  clock: Clock
  ids: Ids
  /** Host-supplied rate cards for estimating cost when a provider reports none. */
  rateCard?: (driver: string, model: string) => RateCard | null
  /** Resident processes kept alive while idle; busy sessions are never evicted. */
  maxResident?: number
  outputLimits?: OutputLimits
  interruptGraceMs?: number
}

export interface OpenParams {
  sessionId?: string
  /** Reattach to an open session of this scope (e.g. after a host restart). */
  resume?: { sessionId: string }
  driver: string
  model: string
  effort?: string
  cwd: string
  systemPrompt?: string
  policy: SessionPolicyInput
  /** Continue an existing provider conversation (e.g. a session created before Core sessions existed). */
  providerSessionRef?: string
  metadata?: Record<string, unknown>
}

export interface SendParams {
  inputId: string
  text: string
  attachments?: Attachment[]
  delivery: 'queue' | 'steer'
}

export type SessionListener = (envelopes: SessionEventEnvelope[]) => void

export const DEFAULT_MAX_RESIDENT = 6

/**
 * Application facade for one scope: the use cases behind every protocol method.
 * Operations on one session are serialized; different sessions run concurrently.
 */
export class SessionService {
  private readonly active = new Map<string, ActiveSession>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<SessionListener>()
  private shuttingDown = false
  private readonly delegation: DelegationCoordinator

  constructor(private readonly options: SessionServiceOptions) {
    this.delegation = new DelegationCoordinator({
      journal: options.journal,
      ids: options.ids,
      parent: (sessionId) => this.session(sessionId),
      open: (params) => this.open(params),
      send: (sessionId, input) => this.send(sessionId, input),
      interrupt: (sessionId) => this.interrupt(sessionId),
      close: (sessionId, reason) => this.close(sessionId, reason),
      snapshot: (sessionId) => this.snapshot(sessionId),
    })
  }

  drivers(): DriverDescriptor[] {
    return this.options.drivers.descriptors()
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Mark work a previous host left running as interrupted. Called once at
   * startup before serving requests; never starts a provider process.
   */
  recover(reason: 'restart' | 'host_lost' = 'restart'): string[] {
    const recovered: string[] = []
    for (const summary of this.options.journal.list('open')) {
      const snapshot = this.options.journal.snapshot(summary.sessionId)
      if (!snapshot || !needsRecovery(snapshot)) continue
      const factory = this.options.drivers.get(snapshot.driver)
      if (!factory) continue
      new ActiveSession(summary.sessionId, snapshot, this.configFrom(snapshot), this.deps(factory)).recoverAfterHostLoss(reason)
      recovered.push(summary.sessionId)
    }
    // A delegated child cannot outlive the host that ran it: close the orphans.
    for (const summary of this.options.journal.list('open')) {
      if (this.options.journal.getSession(summary.sessionId)?.metadata?.delegated !== true) continue
      const envelopes = this.options.journal.append(summary.sessionId, [{ type: 'session.closed', reason: 'delegation_interrupted', at: this.options.clock.iso() }])
      this.publish(envelopes)
    }
    return recovered
  }

  async open(params: OpenParams): Promise<{ sessionId: string; snapshot: SessionSnapshot }> {
    this.assertRunning()
    if (params.resume) return this.resume(params.resume.sessionId)
    const factory = this.options.drivers.get(params.driver)
    if (!factory) throw new SessionError('driver_unavailable', `Driver "${params.driver}" is not registered`, { driver: params.driver })
    const policy = resolvePolicy(params.policy, factory.descriptor)
    const sessionId = params.sessionId ?? this.options.ids.session()
    if (this.options.journal.getSession(sessionId)) throw new SessionError('invalid_params', `Session ${sessionId} already exists; use resume`, { path: 'sessionId' })
    this.options.journal.createSession({ sessionId, driver: params.driver, cwd: params.cwd, createdAt: this.options.clock.iso(), metadata: { ...(params.metadata ?? {}) } })
    const envelopes = this.options.journal.append(sessionId, [{
      type: 'session.opened',
      driver: params.driver,
      model: params.model,
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      policy,
      resumed: params.providerSessionRef !== undefined,
      providerSessionRef: params.providerSessionRef ?? null,
      at: this.options.clock.iso(),
    }])
    this.publish(envelopes)
    const session = this.activate(sessionId)
    return { sessionId, snapshot: session.state }
  }

  async send(sessionId: string, input: SendParams): Promise<{ inputId: string; state: string }> {
    return this.exclusive(sessionId, () => this.session(sessionId).send(input))
  }

  async interrupt(sessionId: string): Promise<{ turnId: string | null }> {
    return this.exclusive(sessionId, async () => ({ turnId: await this.session(sessionId).interrupt() }))
  }

  async stopSubagents(sessionId: string, subagentIds?: string[]): Promise<{ stopped: string[] }> {
    return this.exclusive(sessionId, async () => {
      const session = this.session(sessionId)
      const native = subagentIds?.filter((id) => !this.delegation.isDelegated(id))
      const delegated = await this.delegation.stop(sessionId, subagentIds)
      const stopped = native?.length === 0 ? [] : await session.stopSubagents(native)
      return { stopped: [...delegated, ...stopped] }
    })
  }

  /** Launch a sub-agent as a child session (delegated runtime). */
  async delegate(sessionId: string, params: DelegateParams): Promise<{ subagentId: string }> {
    return this.exclusive(sessionId, () => this.delegation.delegate(sessionId, params))
  }

  /** Wait for delegated sub-agents; never holds the session lock while waiting. */
  async waitSubagents(sessionId: string, subagentIds: string[] | undefined, timeoutMs: number): Promise<{ results: DelegatedResult[]; running: string[] }> {
    this.session(sessionId)
    return this.delegation.wait(sessionId, subagentIds, timeoutMs)
  }

  async update(sessionId: string, changes: { model?: string; effort?: string; systemPrompt?: string; policy?: SessionPolicyInput }): Promise<{ outcome: 'applied' | 'deferred' }> {
    return this.exclusive(sessionId, async () => {
      const session = this.session(sessionId)
      const factory = this.requireFactory(session.state.driver)
      const { policy, ...rest } = changes
      const resolved = policy ? { ...rest, policy: resolvePolicy(policy, factory.descriptor) } : rest
      return { outcome: await session.update(resolved) }
    })
  }

  async close(sessionId: string, reason: string): Promise<void> {
    await this.exclusive(sessionId, async () => {
      const snapshot = this.options.journal.snapshot(sessionId)
      if (!snapshot) throw new SessionError('session_not_found', `Unknown session ${sessionId}`)
      if (snapshot.status === 'closed') return
      await this.delegation.closeParent(sessionId)
      await this.session(sessionId).close(reason)
      this.active.delete(sessionId)
    })
  }

  snapshot(sessionId: string): SessionSnapshot {
    const active = this.active.get(sessionId)
    if (active) return active.state
    const snapshot = this.options.journal.snapshot(sessionId)
    if (!snapshot) throw new SessionError('session_not_found', `Unknown session ${sessionId}`)
    return snapshot
  }

  events(sessionId: string, afterSeq: number, limit = 500): { events: SessionEventEnvelope[]; nextSeq: number; hasMore: boolean } {
    if (!this.options.journal.getSession(sessionId)) throw new SessionError('session_not_found', `Unknown session ${sessionId}`)
    const page = this.options.journal.read(sessionId, afterSeq, Math.min(Math.max(limit, 1), 5_000))
    return { events: page.events, nextSeq: page.events.at(-1)?.seq ?? afterSeq, hasMore: page.hasMore }
  }

  list(state: 'open' | 'closed' | 'all' = 'open'): SessionSummary[] {
    return this.options.journal.list(state)
  }

  stats(): { sessions: number; residentProcesses: number } {
    return { sessions: this.active.size, residentProcesses: [...this.active.values()].filter((session) => session.processAlive).length }
  }

  /** Retire every provider process; running work is recorded as interrupted. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await Promise.allSettled([...this.active.values()].map((session) =>
      session.retire('shutdown', { turnStatus: 'interrupted', subagentPhase: 'interrupted', reason: 'shutdown' })))
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async resume(sessionId: string): Promise<{ sessionId: string; snapshot: SessionSnapshot }> {
    const snapshot = this.options.journal.snapshot(sessionId)
    if (!snapshot) throw new SessionError('session_not_found', `Unknown session ${sessionId}`)
    if (snapshot.status === 'closed') throw new SessionError('session_closed', `Session ${sessionId} is closed`)
    const session = this.activate(sessionId)
    return { sessionId, snapshot: session.state }
  }

  private activate(sessionId: string): ActiveSession {
    const existing = this.active.get(sessionId)
    if (existing) return existing
    const snapshot = this.options.journal.snapshot(sessionId)
    if (!snapshot) throw new SessionError('session_not_found', `Unknown session ${sessionId}`)
    const session = new ActiveSession(sessionId, snapshot, this.configFrom(snapshot), this.deps(this.requireFactory(snapshot.driver)))
    this.active.set(sessionId, session)
    return session
  }

  private session(sessionId: string): ActiveSession {
    this.assertRunning()
    const snapshot = this.active.get(sessionId)?.state ?? this.options.journal.snapshot(sessionId)
    if (!snapshot) throw new SessionError('session_not_found', `Unknown session ${sessionId}`)
    if (snapshot.status === 'closed') throw new SessionError('session_closed', `Session ${sessionId} is closed`)
    return this.activate(sessionId)
  }

  private configFrom(snapshot: SessionSnapshot): SessionConfig {
    const record = this.options.journal.getSession(snapshot.sessionId)
    if (!snapshot.policy || !record) throw new SessionError('internal', `Session ${snapshot.sessionId} has no opening record`)
    return { cwd: record.cwd, model: snapshot.model, effort: snapshot.effort, systemPrompt: snapshot.systemPrompt, policy: snapshot.policy }
  }

  private deps(factory: NonNullable<ReturnType<DriverCatalog['get']>>) {
    return {
      journal: this.options.journal,
      factory,
      clock: this.options.clock,
      ids: this.options.ids,
      rateCard: this.options.rateCard ?? (() => null),
      publish: (envelopes: SessionEventEnvelope[]) => this.publish(envelopes),
      touched: () => this.enforceResidentCap(),
      ...(this.options.outputLimits ? { outputLimits: this.options.outputLimits } : {}),
      ...(this.options.interruptGraceMs !== undefined ? { interruptGraceMs: this.options.interruptGraceMs } : {}),
    }
  }

  private requireFactory(driverId: string) {
    const factory = this.options.drivers.get(driverId)
    if (!factory) throw new SessionError('driver_unavailable', `Driver "${driverId}" is not registered`, { driver: driverId })
    return factory
  }

  /** Keep-alive cap: retire least-recently-used idle processes; never busy ones. */
  private enforceResidentCap(): void {
    const cap = this.options.maxResident ?? DEFAULT_MAX_RESIDENT
    const alive = [...this.active.values()].filter((session) => session.processAlive)
    if (alive.length <= cap) return
    const evictable = alive.filter((session) => !session.isBusy).sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    for (const session of evictable.slice(0, alive.length - cap)) {
      void this.exclusive(session.sessionId, () => session.retire('evicted', { turnStatus: 'interrupted', subagentPhase: 'interrupted', reason: 'evicted' }))
    }
  }

  private publish(envelopes: SessionEventEnvelope[]): void {
    if (envelopes.length === 0) return
    for (const listener of this.listeners) listener(envelopes)
    // Mirror delegated children into their parents (after hosts saw the child events).
    this.delegation.observe(envelopes)
  }

  /** Serialize operations per session. */
  private exclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const settled = next.catch(() => undefined)
    this.locks.set(sessionId, settled)
    void settled.then(() => { if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId) })
    return next
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new SessionError('busy', 'The session host is shutting down')
  }
}

function needsRecovery(snapshot: SessionSnapshot): boolean {
  return snapshot.openTurn !== null
    || snapshot.process.alive
    || snapshot.phase !== 'idle'
    || liveSubagents(snapshot).length > 0
    || Object.values(snapshot.inputs).some((input) => input.state === 'accepted' || input.state === 'queued' || input.state === 'started')
}
