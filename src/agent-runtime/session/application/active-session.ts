import { SessionError, isSessionError } from '../domain/errors.js'
import type { SessionEvent, SessionEventBody, SessionEventEnvelope } from '../domain/events.js'
import { fingerprint } from '../domain/fingerprint.js'
import { buildInterruptionNotice } from '../domain/interruption.js'
import { subagentsActive } from '../domain/policy.js'
import { applyEvent, liveSubagents, type SessionSnapshot } from '../domain/snapshot.js'
import { EMPTY_USAGE, type DriverDescriptor, type SessionPolicy, type SubagentPhase, type Usage } from '../domain/types.js'
import { FRESH_BASELINE, UNKNOWN_BASELINE, computeTurnUsage, withEstimatedCost, type RateCard, type ReportedUsage, type UsageBaseline } from '../domain/usage.js'
import type { Clock, CloseReason, DriverEvent, DriverFactory, DriverInput, DriverSession, Ids, SessionJournal } from '../ports.js'
import { OutputBuffer, type OutputLimits } from './output-buffer.js'
import { SessionTimers } from './timers.js'

export interface ActiveSessionDeps {
  journal: SessionJournal
  factory: DriverFactory
  clock: Clock
  ids: Ids
  rateCard: (driver: string, model: string) => RateCard | null
  publish: (envelopes: SessionEventEnvelope[]) => void
  /** Called whenever the session's process liveness or recency changes (LRU bookkeeping). */
  touched: (session: ActiveSession) => void
  outputLimits?: OutputLimits
  /** How long `interrupt` waits for the provider before ending the process. */
  interruptGraceMs?: number
  /** Delay before buffered deltas are flushed. */
  flushMs?: number
}

export interface SessionConfig {
  cwd: string
  model: string
  effort: string | null
  systemPrompt: string | null
  policy: SessionPolicy
}

/** How work that was running ends when the process goes away. */
interface Teardown {
  turnStatus: 'stopped' | 'interrupted' | 'failed'
  subagentPhase: SubagentPhase
  reason: string
  error?: string
}

const COLLECT_PROMPT = [
  '[Specrails session] Your sub-agents have finished.',
  'Collect their results (for example with your wait/agent tools), then continue the task or report back to the user.',
].join(' ')

/**
 * Coordinates one session: turns driver facts into journaled events, owns the
 * provider process lifecycle, phases, settlement, limits and teardown.
 * All mutation goes through `commit`, which folds before appending, so the
 * journal never holds an event the domain would reject.
 */
export class ActiveSession {
  state: SessionSnapshot
  private driver: DriverSession | null = null
  private opening: Promise<DriverSession> | null = null
  private generation: number
  /** Generation whose events are accepted (the live or opening process); null when none. */
  private liveGeneration: number | null = null
  private closing = false
  private baseline: UsageBaseline
  private readonly timers: SessionTimers
  private readonly output: OutputBuffer
  private readonly descriptor: DriverDescriptor
  /** Inputs held back for drivers without a native input queue. */
  private readonly heldInputs: DriverInput[] = []
  /** Inputs the application wrote on its own (policy-driven turns). */
  private readonly systemInputIds = new Set<string>()
  private pendingDeferred: Record<string, unknown> | null = null
  private roster: string[] | null = null
  private handoffs = 0
  private finishedSinceLastTurn = new Set<string>()
  private lastUserTurnAt: number | null = null
  lastUsedAt: number

  constructor(readonly sessionId: string, snapshot: SessionSnapshot, private config: SessionConfig, private readonly deps: ActiveSessionDeps) {
    this.state = snapshot
    this.descriptor = deps.factory.descriptor
    this.generation = snapshot.process.generation
    this.timers = new SessionTimers(deps.clock)
    this.output = new OutputBuffer(deps.outputLimits)
    this.lastUsedAt = deps.clock.now()
    const ref = snapshot.providerSessionRef
    this.baseline = ref ? deps.journal.baseline(ref) ?? UNKNOWN_BASELINE : FRESH_BASELINE
  }

  get processAlive(): boolean { return this.driver !== null || this.opening !== null }
  get isBusy(): boolean { return this.state.openTurn !== null || liveSubagents(this.state).length > 0 }
  get policy(): SessionPolicy { return this.config.policy }

  // ── Use cases ─────────────────────────────────────────────────────────────

  async send(input: { inputId: string; text: string; attachments?: DriverInput['attachments']; delivery: 'queue' | 'steer' }): Promise<{ inputId: string; state: string }> {
    this.assertOpen()
    const existing = this.state.inputs[input.inputId]
    if (existing) {
      if (existing.fingerprint !== fingerprint(input.text)) {
        throw new SessionError('input_conflict', `Input ${input.inputId} was already sent with different content`, { inputId: input.inputId })
      }
      return { inputId: input.inputId, state: existing.state }
    }
    const notice = buildInterruptionNotice(this.state)
    this.commit([
      { type: 'input.accepted', inputId: input.inputId, delivery: input.delivery, text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}) },
      ...(notice ? [{ type: 'notice.interruption' as const, subagentIds: notice.subagentIds, inputIds: notice.inputIds }] : []),
    ])
    this.touch()
    const text = notice ? `${notice.text}\n\n${input.text}` : input.text
    await this.deliver({ inputId: input.inputId, text, delivery: input.delivery, origin: 'user', ...(input.attachments ? { attachments: input.attachments } : {}) })
    return { inputId: input.inputId, state: this.state.inputs[input.inputId]?.state ?? 'accepted' }
  }

  async interrupt(): Promise<string | null> {
    this.assertOpen()
    const turn = this.state.openTurn
    if (!turn || !this.driver) return null
    await this.driver.interrupt()
    this.timers.arm('interruptGrace', this.deps.interruptGraceMs ?? 5_000, () => {
      if (this.state.openTurn?.turnId === turn.turnId) void this.retire('user_stop', { turnStatus: 'stopped', subagentPhase: 'stopped', reason: 'user_stop' })
    })
    return turn.turnId
  }

  async stopSubagents(ids?: string[]): Promise<string[]> {
    this.assertOpen()
    const live = liveSubagents(this.state).map((node) => node.subagentId)
    const targets = ids ? live.filter((id) => ids.includes(id)) : live
    if (targets.length === 0 || !this.driver) return []
    const result = await this.driver.stopSubagents(ids ? targets : undefined)
    if (result === 'process') {
      await this.retire('host_request', { turnStatus: 'stopped', subagentPhase: 'stopped', reason: 'host_request' })
      return targets
    }
    for (const id of result) {
      if (this.state.subagents[id]?.phase === 'running' || this.state.subagents[id]?.phase === 'idle') {
        this.commit([{ type: 'subagent.phase', subagentId: id, phase: 'stopped', reason: 'host_request' }, ...this.output.drainSubagent(id)])
      }
    }
    this.afterSubagentChange()
    return result
  }

  /**
   * Policy says no sub-agents, yet the provider started one (a provider switch
   * can be ignored by a model or CLI version). Stop it and say so: the policy
   * holds whatever the provider's own switch does.
   */
  private async blockSubagent(subagentId: string): Promise<void> {
    this.commit([{ type: 'provider.diagnostic', level: 'warning', code: 'policy.subagent_blocked', message: `The provider started sub-agent ${subagentId} although sub-agents are disabled; it was stopped.` }])
    try {
      const result = this.driver ? await this.driver.stopSubagents([subagentId]) : []
      if (result === 'process') {
        await this.retire('host_request', { turnStatus: 'stopped', subagentPhase: 'stopped', reason: 'policy' })
        return
      }
    } catch (error) {
      this.commit([{ type: 'provider.diagnostic', level: 'warning', code: 'provider.stop_failed', message: `${subagentId}: ${(error as Error).message}` }])
    }
    if (this.state.subagents[subagentId]?.phase === 'running') {
      this.commit([{ type: 'subagent.phase', subagentId, phase: 'stopped', reason: 'policy' }, ...this.output.drainSubagent(subagentId)])
      this.afterSubagentChange()
    }
  }

  /** Apply now when nothing is running; otherwise defer to the next idle point. */
  async update(changes: { model?: string; effort?: string; systemPrompt?: string; policy?: SessionPolicy }): Promise<'applied' | 'deferred'> {
    this.assertOpen()
    const recorded: Record<string, unknown> = { ...changes }
    if (this.isBusy) {
      this.pendingDeferred = { ...(this.pendingDeferred ?? {}), ...recorded }
      this.commit([{ type: 'session.updated', changes: recorded, outcome: 'deferred' }])
      return 'deferred'
    }
    await this.applyChanges(recorded)
    return 'applied'
  }

  async close(reason: string): Promise<void> {
    if (this.state.status === 'closed') return
    await this.retire('session_closed', { turnStatus: 'stopped', subagentPhase: 'stopped', reason: 'host_request' })
    this.commit([{ type: 'session.closed', reason }])
    this.timers.cancelAll()
  }

  /**
   * Record work a previous host left running as interrupted. Nothing is
   * restarted: the next user input carries the interruption notice instead.
   */
  recoverAfterHostLoss(reason: 'restart' | 'host_lost'): void {
    const hadProcess = this.state.process.alive
    this.endRunningWork({ turnStatus: 'interrupted', subagentPhase: 'interrupted', reason })
    if (hadProcess) this.commit([{ type: 'session.process', state: 'exited', generation: this.state.process.generation, reason, exitCode: null }])
  }

  /** Retire the provider process; running work ends as described by `teardown`. */
  async retire(reason: CloseReason, teardown: Teardown): Promise<void> {
    this.timers.cancel('idle', 'stall', 'backgroundMax', 'turnInactivity', 'settle', 'interruptGrace')
    const driver = this.driver ?? (this.opening ? await this.opening.catch(() => null) : null)
    if (!driver) return
    this.closing = true
    try {
      await driver.close(reason)
    } finally {
      this.closing = false
      this.driver = null
      this.liveGeneration = null
      this.endRunningWork(teardown)
      this.commit([{ type: 'session.process', state: 'retired', generation: this.generation, reason }])
      this.deps.touched(this)
    }
  }

  // ── Delivery and process lifecycle ────────────────────────────────────────

  private async deliver(input: DriverInput): Promise<void> {
    const caps = this.descriptor.capabilities
    const turnRunning = this.state.openTurn !== null
    if (!caps.nativeInputQueue && turnRunning && !(input.delivery === 'steer' && caps.steer)) {
      this.heldInputs.push(input)
      return
    }
    try {
      const driver = await this.ensureDriver()
      await driver.send(input)
    } catch (error) {
      const current = this.state.inputs[input.inputId]?.state
      if (current === 'accepted' || current === 'queued') {
        this.commit([{ type: 'input.state', inputId: input.inputId, state: 'interrupted', reason: 'delivery_failed' }])
      }
      throw isSessionError(error) ? error : new SessionError('internal', `Could not deliver input: ${(error as Error).message}`)
    }
  }

  private async ensureDriver(): Promise<DriverSession> {
    if (this.driver) return this.driver
    if (this.opening) return this.opening
    const generation = this.generation + 1
    this.liveGeneration = generation
    this.opening = this.deps.factory.open({
      sessionId: this.sessionId,
      generation,
      cwd: this.config.cwd,
      model: this.config.model,
      effort: this.config.effort,
      systemPrompt: this.config.systemPrompt,
      policy: this.config.policy,
      providerSessionRef: this.state.providerSessionRef,
    }, (event) => this.onDriverEvent(generation, event))
    try {
      const driver = await this.opening
      this.driver = driver
      this.generation = generation
      this.commit([{ type: 'session.process', state: 'started', generation }])
      this.touch()
      return driver
    } catch (error) {
      this.liveGeneration = null
      throw new SessionError('driver_unavailable', `Could not start ${this.descriptor.id}: ${(error as Error).message}`)
    } finally {
      this.opening = null
    }
  }

  // ── Driver events ─────────────────────────────────────────────────────────

  private onDriverEvent(generation: number, event: DriverEvent): void {
    // Events of a retired process are ignored; a closing process may still report (e.g. stopped tasks).
    if (generation !== this.liveGeneration) return
    if (this.state.status === 'closed') return
    try {
      this.handleDriverEvent(event)
    } catch (error) {
      if (isSessionError(error) && (error.code === 'illegal_transition' || error.code === 'input_conflict')) {
        this.commit([{ type: 'provider.diagnostic', level: 'warning', code: error.code, message: `${event.kind}: ${error.message}` }])
        return
      }
      throw error
    }
  }

  private handleDriverEvent(event: DriverEvent): void {
    this.markActivity()
    switch (event.kind) {
      case 'process.started':
        if (event.version) this.commit([{ type: 'provider.diagnostic', level: 'info', code: 'provider_version', message: event.version }])
        return
      case 'process.exited':
        if (this.closing) return
        this.driver = null
        this.liveGeneration = null
        this.timers.cancel('idle', 'stall', 'backgroundMax', 'turnInactivity', 'settle', 'interruptGrace')
        this.endRunningWork({ turnStatus: 'failed', subagentPhase: 'interrupted', reason: 'crashed', error: `Provider process exited (code ${event.exitCode ?? 'none'}${event.signal ? `, signal ${event.signal}` : ''})` })
        this.commit([{ type: 'session.process', state: 'exited', generation: this.generation, exitCode: event.exitCode, reason: 'crashed' }])
        this.deps.touched(this)
        return
      case 'provider.ref':
        if (event.providerSessionRef !== this.state.providerSessionRef) {
          const known = this.deps.journal.baseline(event.providerSessionRef)
          if (known) this.baseline = known
          this.commit([{ type: 'session.provider-ref', providerSessionRef: event.providerSessionRef }])
        }
        return
      case 'input.receipt': {
        const input = this.state.inputs[event.inputId]
        if (!input || input.state === event.state) return
        this.commit([{ type: 'input.state', inputId: event.inputId, state: event.state, ...(this.state.openTurn && event.state !== 'queued' ? { turnId: this.state.openTurn.turnId } : {}), ...(event.reason ? { reason: event.reason } : {}) }])
        return
      }
      case 'turn.started':
        return this.startTurn(event.trigger, event.inputIds)
      case 'turn.output': {
        const turn = this.requireTurn()
        this.commitBuffered(this.output.add({ type: 'turn.output', turnId: turn.turnId, channel: event.channel, delta: event.delta }))
        return
      }
      case 'turn.tool': {
        const turn = this.requireTurn()
        const { kind: _kind, ...tool } = event
        this.commit([{ type: 'turn.tool', turnId: turn.turnId, ...tool }])
        return
      }
      case 'turn.completed':
        return this.completeTurn(event.status, event.text, event.usage, event.error)
      case 'subagent.started':
        this.finishedSinceLastTurn.delete(event.subagentId)
        this.commit([{ type: 'subagent.started', subagentId: event.subagentId, parentId: event.parentId, kind: event.agentKind, description: event.description, ...(event.agentType ? { agentType: event.agentType } : {}), ...(event.prompt ? { prompt: event.prompt.slice(0, 8_000) } : {}) }])
        this.afterSubagentChange()
        if (this.config.policy.subagents === 'disabled') void this.blockSubagent(event.subagentId)
        return
      case 'subagent.phase':
        // Only work that finished while the agent was not in a turn is news to it (it saw the rest via its own tools).
        if (event.phase !== 'running' && !this.state.openTurn) this.finishedSinceLastTurn.add(event.subagentId)
        this.commit([
          { type: 'subagent.phase', subagentId: event.subagentId, phase: event.phase, ...(event.reason ? { reason: event.reason } : {}) },
          ...(event.phase === 'running' ? [] : this.output.drainSubagent(event.subagentId)),
        ])
        this.afterSubagentChange()
        return
      case 'subagent.output':
        if (event.channel === 'text' && event.delta !== undefined) {
          this.commitBuffered(this.output.add({ type: 'subagent.output', subagentId: event.subagentId, channel: 'text', delta: event.delta }))
        } else {
          this.commit([{ type: 'subagent.output', subagentId: event.subagentId, channel: event.channel, ...(event.delta !== undefined ? { delta: event.delta } : {}), ...(event.tool ? { tool: event.tool } : {}) }])
        }
        return
      case 'subagent.usage':
        this.commit([{ type: 'subagent.usage', subagentId: event.subagentId, usage: this.subagentUsage(event.usage), ...(event.toolUses !== undefined ? { toolUses: event.toolUses } : {}), ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) }])
        return
      case 'subagent.result':
        this.commit([{ type: 'subagent.result', subagentId: event.subagentId, summary: event.summary.slice(0, 4_096) }])
        return
      case 'roster':
        this.roster = [...event.liveSubagentIds]
        this.afterSubagentChange()
        return
      case 'diagnostic':
        this.commit([{ type: 'provider.diagnostic', level: event.level, code: event.code, message: event.message.slice(0, 2_000) }])
        return
    }
  }

  private startTurn(trigger: 'input' | 'continuation', inputIds: string[]): void {
    if (this.state.openTurn) throw new SessionError('illegal_transition', `Turn ${this.state.openTurn.turnId} is still running`)
    const system = inputIds.length > 0 && inputIds.every((id) => this.systemInputIds.has(id))
    const origin = trigger === 'continuation' ? 'subagent' : system ? 'system' : 'user'
    const triggeredBy = origin === 'user' ? undefined : [...this.finishedSinceLastTurn]
    if (origin === 'user') this.lastUserTurnAt = this.deps.clock.now()
    this.finishedSinceLastTurn.clear()
    this.timers.cancel('idle', 'stall')
    this.commit([
      ...(this.state.phase === 'turn' ? [] : [{ type: 'session.phase' as const, phase: 'turn' as const }]),
      { type: 'turn.started', turnId: this.deps.ids.turn(), origin, inputIds: [...inputIds], ...(triggeredBy && triggeredBy.length > 0 ? { trigger: { subagentIds: triggeredBy } } : {}) },
    ])
    this.armTurnInactivity()
  }

  private completeTurn(status: 'completed' | 'failed' | 'stopped', text: string, reported: ReportedUsage, error?: string): void {
    const turn = this.requireTurn()
    this.timers.cancel('turnInactivity', 'interruptGrace')
    const { usage, baselineOption } = this.turnUsage(reported)
    this.commit(
      [
        ...this.output.flush(),
        ...this.output.drainTurn(turn.turnId),
        { type: 'turn.completed', turnId: turn.turnId, status, text, usage, ...(error ? { error } : {}) },
        ...this.completeTurnInputs(turn.inputIds, turn.turnId),
      ],
      baselineOption,
    )
    this.settlePhaseAfterTurn()
    void this.releaseHeldInput()
  }

  /**
   * Inputs whose receipts never reported completion are completed with their
   * turn: the ones that opened it and the ones steered into it.
   */
  private completeTurnInputs(inputIds: string[], turnId: string): SessionEventBody[] {
    return Object.values(this.state.inputs)
      .filter((input) => input.state === 'started' && (inputIds.includes(input.inputId) || input.turnId === turnId))
      .map((input) => ({ type: 'input.state' as const, inputId: input.inputId, state: 'completed' as const, turnId }))
  }

  private settlePhaseAfterTurn(): void {
    const live = liveSubagents(this.state).length
    this.commit([{ type: 'session.phase', phase: live > 0 ? 'background' : 'idle' }])
    if (live > 0) this.enterBackground()
    else this.enterIdle()
    // Sub-agents that finished during the turn still need their settle point.
    if (!this.state.settled.settled && !this.timers.isArmed('settle')) this.afterSubagentChange()
  }

  // ── Sub-agent settlement ──────────────────────────────────────────────────

  private afterSubagentChange(): void {
    const live = this.liveCount()
    if (live > 0) {
      this.timers.cancel('settle', 'idle')
      if (this.state.settled.settled || this.state.settled.live !== live) this.commit([{ type: 'subagents.settled', settled: false, live }])
      if (this.state.phase === 'idle' && !this.state.openTurn) {
        // The provider restarted a sub-agent after the session went idle.
        this.commit([{ type: 'session.phase', phase: 'background' }])
        this.enterBackground()
      }
      return
    }
    if (this.state.settled.settled) return
    this.timers.arm('settle', this.config.policy.limits.settleDebounceMs, () => this.onSettled())
  }

  private onSettled(): void {
    if (this.liveCount() > 0 || this.state.status === 'closed') return
    this.commit([{ type: 'subagents.settled', settled: true, live: 0 }])
    if (this.state.openTurn) return
    if (this.state.phase === 'background') {
      this.commit([{ type: 'session.phase', phase: 'idle' }])
      this.enterIdle()
    }
    this.maybeResumeAgent()
  }

  /** Live = running in our tree and, when the provider reports a roster, still on it. */
  private liveCount(): number {
    const running = liveSubagents(this.state).map((node) => node.subagentId)
    if (this.roster === null) return running.length
    return new Set([...running, ...this.roster.filter((id) => this.state.subagents[id]?.phase !== 'idle')]).size
  }

  private maybeResumeAgent(): void {
    const policy = this.config.policy
    if (!subagentsActive(policy, this.descriptor) || policy.onSubagentsSettled !== 'resume-agent') return
    if (this.finishedSinceLastTurn.size === 0 || this.handoffs >= policy.limits.maxSettleHandoffs || !this.driver) return
    this.handoffs += 1
    const inputId = this.deps.ids.input()
    this.systemInputIds.add(inputId)
    this.commit([{ type: 'input.accepted', inputId, delivery: 'queue', text: COLLECT_PROMPT }])
    void this.deliver({ inputId, text: COLLECT_PROMPT, delivery: 'queue', origin: 'system' }).catch(() => undefined)
  }

  // ── Phases and limits ─────────────────────────────────────────────────────

  private enterIdle(): void {
    this.timers.cancel('stall', 'backgroundMax')
    if (this.pendingDeferred) {
      const changes = this.pendingDeferred
      this.pendingDeferred = null
      void this.applyChanges(changes)
      return
    }
    if (this.processAlive) this.timers.arm('idle', this.config.policy.limits.idleMs, () => void this.retire('idle', this.idleTeardown('idle')))
    this.deps.touched(this)
  }

  private enterBackground(): void {
    const limits = this.config.policy.limits
    this.timers.arm('stall', limits.stallMs, () => void this.retire('stalled', { turnStatus: 'interrupted', subagentPhase: 'interrupted', reason: 'stalled' }))
    const since = this.lastUserTurnAt ?? this.deps.clock.now()
    const remaining = Math.max(0, limits.backgroundMaxMs - (this.deps.clock.now() - since))
    this.timers.ensure('backgroundMax', remaining, () => void this.retire('limit', { turnStatus: 'stopped', subagentPhase: 'stopped', reason: 'limit' }))
  }

  private idleTeardown(reason: string): Teardown {
    return { turnStatus: 'interrupted', subagentPhase: 'interrupted', reason }
  }

  private armTurnInactivity(): void {
    this.timers.arm('turnInactivity', this.config.policy.limits.turnInactivityMs, () => {
      void this.retire('stalled', { turnStatus: 'failed', subagentPhase: 'interrupted', reason: 'stalled', error: 'No provider activity before the inactivity limit' })
    })
  }

  private markActivity(): void {
    this.lastUsedAt = this.deps.clock.now()
    if (this.state.openTurn) this.armTurnInactivity()
    if (this.state.phase === 'background') this.timers.arm('stall', this.config.policy.limits.stallMs, () => void this.retire('stalled', { turnStatus: 'interrupted', subagentPhase: 'interrupted', reason: 'stalled' }))
  }

  private async applyChanges(changes: Record<string, unknown>): Promise<void> {
    const next = changes as { model?: string; effort?: string; systemPrompt?: string; policy?: SessionPolicy }
    this.config = {
      ...this.config,
      ...(next.model !== undefined ? { model: next.model } : {}),
      ...(next.effort !== undefined ? { effort: next.effort } : {}),
      ...(next.systemPrompt !== undefined ? { systemPrompt: next.systemPrompt } : {}),
      ...(next.policy !== undefined ? { policy: next.policy } : {}),
    }
    this.commit([{ type: 'session.updated', changes, outcome: 'applied' }])
    // Provider flags are fixed at spawn: the next turn starts a new process with the new config.
    if (this.processAlive) await this.retire('config_change', this.idleTeardown('config_change'))
  }

  private async releaseHeldInput(): Promise<void> {
    if (this.state.openTurn) return
    const next = this.heldInputs.shift()
    if (next) await this.deliver(next).catch(() => undefined)
  }

  /** End whatever was running; used by retire and unexpected exits. */
  private endRunningWork(teardown: Teardown): void {
    // Commit buffered deltas first so the closed turn keeps its partial text.
    if (this.output.hasPending()) { this.timers.cancel('flush'); this.commit(this.output.flush()) }
    const bodies: SessionEventBody[] = []
    const turn = this.state.openTurn
    if (turn) {
      bodies.push(...this.output.drainTurn(turn.turnId))
      bodies.push({ type: 'turn.completed', turnId: turn.turnId, status: teardown.turnStatus, text: turn.text, usage: EMPTY_USAGE, ...(teardown.error ? { error: teardown.error } : {}) })
    }
    for (const node of Object.values(this.state.subagents)) {
      if (node.phase === 'running' || node.phase === 'idle') {
        // Idle sub-agents are finished for the provider; only running ones were cut short.
        if (node.phase === 'running') bodies.push({ type: 'subagent.phase', subagentId: node.subagentId, phase: teardown.subagentPhase, reason: teardown.reason })
        bodies.push(...this.output.drainSubagent(node.subagentId))
      }
    }
    for (const input of Object.values(this.state.inputs)) {
      if (input.state === 'accepted' || input.state === 'queued' || input.state === 'started') {
        bodies.push({ type: 'input.state', inputId: input.inputId, state: 'interrupted', reason: teardown.reason })
      }
    }
    this.heldInputs.length = 0
    if (this.state.phase !== 'idle' || turn) bodies.push({ type: 'session.phase', phase: 'idle' })
    if (!this.state.settled.settled) bodies.push({ type: 'subagents.settled', settled: true, live: 0 })
    this.roster = null
    if (bodies.length > 0) this.commit(bodies)
  }

  // ── Usage ─────────────────────────────────────────────────────────────────

  private turnUsage(reported: ReportedUsage): { usage: Usage; baselineOption?: { baseline: { providerRef: string; value: UsageBaseline } } } {
    const result = computeTurnUsage(this.descriptor.capabilities.usage, this.baseline, reported)
    this.baseline = result.baseline
    const usage = withEstimatedCost(result.usage, this.deps.rateCard(this.descriptor.id, result.usage.model ?? this.config.model))
    const ref = this.state.providerSessionRef
    return ref ? { usage, baselineOption: { baseline: { providerRef: ref, value: result.baseline } } } : { usage }
  }

  private subagentUsage(reported: ReportedUsage): Usage {
    const usage: Usage = {
      inputTokens: reported.inputTokens ?? null,
      outputTokens: reported.outputTokens ?? null,
      cacheReadTokens: reported.cacheReadTokens ?? null,
      cacheWriteTokens: reported.cacheWriteTokens ?? null,
      totalTokens: reported.totalTokens ?? null,
      costUsd: reported.costUsd ?? null,
      costEstimated: false,
      model: reported.model ?? null,
    }
    return withEstimatedCost(usage, this.deps.rateCard(this.descriptor.id, usage.model ?? this.config.model))
  }

  // ── Commit ────────────────────────────────────────────────────────────────

  private commitBuffered(ready: SessionEventBody[]): void {
    if (ready.length > 0) this.commit(ready)
    if (this.output.hasPending()) this.timers.ensure('flush', this.deps.flushMs ?? 50, () => this.commit(this.output.flush()))
    else this.timers.cancel('flush')
  }

  /**
   * Validate (fold) then append atomically, then publish. Buffered deltas are
   * flushed first so ordering is preserved.
   */
  private commit(bodies: SessionEventBody[], options?: { baseline: { providerRef: string; value: UsageBaseline } }): void {
    const isDelta = (body: SessionEventBody) => body.type === 'turn.output' || (body.type === 'subagent.output' && body.channel === 'text')
    const leading = bodies.some((body) => !isDelta(body)) && this.output.hasPending() ? this.output.flush() : []
    if (leading.length > 0) this.timers.cancel('flush')
    const all = [...leading, ...bodies]
    if (all.length === 0) return
    const at = this.deps.clock.iso()
    const events = all.map((body) => ({ ...body, at }) as SessionEvent)
    let next = this.state
    for (const event of events) next = applyEvent(next, event)
    const envelopes = this.deps.journal.append(this.sessionId, events, options)
    this.state = { ...next, lastSeq: envelopes.at(-1)?.seq ?? this.state.lastSeq }
    this.deps.publish(envelopes)
  }

  private requireTurn() {
    const turn = this.state.openTurn
    if (!turn) throw new SessionError('illegal_transition', 'No turn is running')
    return turn
  }

  private assertOpen(): void {
    if (this.state.status === 'closed') throw new SessionError('session_closed', `Session ${this.sessionId} is closed`)
  }

  private touch(): void {
    this.lastUsedAt = this.deps.clock.now()
    this.deps.touched(this)
  }
}
