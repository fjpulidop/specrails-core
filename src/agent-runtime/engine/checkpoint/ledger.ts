import { randomUUID } from 'node:crypto'
import type { ProviderInvocation, PendingProviderInvocation } from '../../efficiency-types.js'
import { canonicalJson, contentDigest } from '../canonical-json.js'
import { EngineError, type AttemptFrame, type DurableEngineEvent, type EngineUsage, type ExecutionLease,
  type JsonValue, type NodeAdmission, type PieceResult, type TaskIdentity, type TerminalCommit, type WorkflowBudget } from '../contracts.js'
import { appendRunEvent, RunDatabase, type DatabaseRow } from './database.js'
import { RunLease } from './lease.js'
import { ControlInbox } from '../steering/inbox.js'

export interface FrozenLedgerInput {
  runId: string; workflowId: string; definitionHash: string; definition: unknown; request: unknown; runtimeIdentity: unknown
  source: 'definition' | 'builtin'; budget?: WorkflowBudget; checkpointThreadId?: string; forkOf?: string
}
const taskParams = (task: TaskIdentity): string[] => [task.checkpointThreadId, task.taskCheckpointNs, task.checkpointId, task.taskId]
const contextOf = (frame: AttemptFrame) => ({ nodePath: frame.nodePath, scopeId: frame.scope.id, ...(frame.scope.branchId ? { branchId: frame.scope.branchId } : {}), visit: frame.visit, attempt: frame.attempt, attemptId: frame.attemptId })

/** The ledger is authoritative for visits, attempts, usage, receipts and durable event cursors. */
export class RunLedger {
  readonly lease: RunLease
  private readonly now: () => number
  constructor(readonly db: RunDatabase, readonly token: ExecutionLease,
    private readonly options: { maxTransitions: number; now?: () => number; failFast?: number }) {
    this.now = options.now ?? Date.now
    this.lease = new RunLease(db, token.runId, this.now)
  }

  static initialize(db: RunDatabase, input: FrozenLedgerInput): void {
    if (db.sqlite.prepare('SELECT run_id FROM runs').get()) throw new EngineError('run_exists', 'This database already contains a run')
    const at = new Date().toISOString()
    for (const value of Object.values(input.budget ?? {})) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new EngineError('invalid_arguments', 'Budget limits must be non-negative finite values')
    db.transaction('run-created', () => {
      db.put('runs', { run_id: input.runId, workflow_id: input.workflowId, definition_hash: input.definitionHash,
        definition_json: canonicalJson(input.definition), request_json: canonicalJson(input.request), source: input.source, engine_version: 2,
        runtime_identity_json: canonicalJson(input.runtimeIdentity), status: 'running', fork_of: input.forkOf ?? null,
        checkpoint_thread_id: input.checkpointThreadId ?? input.runId, created_at: at, updated_at: at, current_revision: db.transactionRevision })
      db.put('budget', { run_id: input.runId, max_cost_usd: input.budget?.maxCostUsd ?? null, max_tokens: input.budget?.maxTokens ?? null,
        max_duration_ms: input.budget?.maxDurationMs ?? null })
      appendRunEvent(db, input.runId, 'workflow_started', {}, {}, at)
    })
  }

  get runId(): string { return this.token.runId }
  run(): DatabaseRow {
    const row = this.db.get('runs', { run_id: this.runId })
    if (!row) throw new EngineError('run_not_found', 'Run does not exist')
    return row
  }
  private assertFrame(frame: AttemptFrame): DatabaseRow {
    this.lease.assert(this.token)
    const attempt = this.db.get('attempts', { attempt_id: frame.attemptId })
    if (!attempt || frame.runId !== this.runId || frame.leaseEpoch !== this.token.epoch || attempt.lease_epoch !== this.token.epoch ||
      contentDigest(JSON.parse(String(attempt.frame_json))) !== contentDigest(frame)) throw new EngineError('attempt_mismatch', 'Attempt does not match the current fenced execution')
    return attempt
  }
  private event(frame: AttemptFrame, type: string, payload: JsonValue = {}): DurableEngineEvent {
    return appendRunEvent(this.db, this.runId, type, payload, contextOf(frame), new Date(this.now()).toISOString())
  }
  /** Public node namespace differs from the parent saver namespace; never parse opaque namespace strings. */
  private bindPendingTask(task: TaskIdentity): DatabaseRow | undefined {
    const matches = this.db.sqlite.prepare('SELECT * FROM visits WHERE thread_id=? AND checkpoint_id=? AND task_id=?')
      .all(task.checkpointThreadId, task.checkpointId, task.taskId)
    if (matches.length > 1) throw new EngineError('task_identity_conflict', 'Pending writes match more than one public task identity')
    const visit = matches[0]
    if (!visit) return undefined
    if (visit.saver_checkpoint_ns !== null && visit.saver_checkpoint_ns !== task.taskCheckpointNs) throw new EngineError('task_identity_conflict', 'A task cannot move to another saver namespace')
    if (visit.saver_checkpoint_ns === null) this.db.put('visits', { ...visit, saver_checkpoint_ns: task.taskCheckpointNs })
    return visit
  }
  private checkAdmission(): void {
    const row = this.run(), budget = this.db.get('budget', { run_id: this.runId })!
    if (this.db.sqlite.prepare("SELECT 1 FROM control_inbox WHERE run_id=? AND kind='cancel' AND consumed_at IS NULL").get(this.runId)) throw new EngineError('aborted', 'Cancellation requested')
    if (this.options.failFast && Number(row.consecutive_failures) >= this.options.failFast) throw new EngineError('fail_fast', 'Consecutive AI failure limit reached')
    const duration = this.activeDurationMs()
    if ((budget.max_tokens !== null && Number(budget.known_tokens) >= Number(budget.max_tokens)) ||
      (budget.max_cost_usd !== null && Number(budget.known_cost_usd) >= Number(budget.max_cost_usd)) ||
      (budget.max_duration_ms !== null && duration >= Number(budget.max_duration_ms))) throw new EngineError('budget_exhausted', 'Run budget is exhausted')
  }

  enter(input: NodeAdmission): AttemptFrame {
    return this.db.transaction('attempt-admitted', () => {
      this.lease.assert(this.token)
      if (!input.nodePath || !input.scope.id || taskParams(input.task).some(value => typeof value !== 'string') || !input.task.taskId || !input.task.checkpointId) throw new EngineError('invalid_arguments', 'Complete task identity is required')
      const run = this.run(), at = new Date(this.now()).toISOString(), beforeRevision = this.db.transactionRevision - 1
      let visit = this.db.sqlite.prepare('SELECT * FROM visits WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? AND task_id=?').get(...taskParams(input.task))
      if (visit && (visit.run_id !== this.runId || visit.node_path !== input.nodePath || visit.scope_id !== input.scope.id || visit.kind !== input.kind || visit.effect !== input.effect)) throw new EngineError('task_identity_conflict', 'A task cannot change node or scope on replay')
      if (!visit) {
        if (Number(run.transitions) >= this.options.maxTransitions) throw new EngineError('recursion_limit', 'Maximum global node visits reached')
        const localVisit = Number(this.db.sqlite.prepare('SELECT COALESCE(MAX(local_visit),0)+1 AS value FROM visits WHERE run_id=? AND node_path=? AND scope_id=?').get(this.runId, input.nodePath, input.scope.id)!.value)
        const visitId = randomUUID(), transition = Number(run.transitions) + 1
        this.db.put('visits', { visit_id: visitId, run_id: this.runId, node_path: input.nodePath, scope_id: input.scope.id, branch_id: input.scope.branchId ?? null,
          kind: input.kind, effect: input.effect, requires_ai: input.requiresAI ? 1 : 0, local_visit: localVisit, global_transition: transition,
          thread_id: input.task.checkpointThreadId, checkpoint_ns: input.task.taskCheckpointNs, checkpoint_id: input.task.checkpointId, task_id: input.task.taskId, before_revision: beforeRevision, created_at: at })
        this.db.put('runs', { ...run, transitions: transition, current_revision: this.db.transactionRevision, updated_at: at })
        visit = this.db.get('visits', { visit_id: visitId })!
      }
      const prior = this.db.sqlite.prepare('SELECT * FROM attempts WHERE visit_id=? ORDER BY attempt DESC LIMIT 1').get(visit.visit_id)
      if (prior?.terminal_digest && prior.status !== 'interrupted') return JSON.parse(String(prior.frame_json)) as AttemptFrame
      // An approval/question continuation keeps its physical attempt and claimed steering.
      if (prior?.status === 'paused') {
        const frame = { ...JSON.parse(String(prior.frame_json)) as AttemptFrame, runId: this.runId, leaseEpoch: this.token.epoch }
        this.db.put('attempts', { ...prior, status: 'running', lease_epoch: this.token.epoch, frame_json: canonicalJson(frame) })
        this.db.put('runs', { ...this.run(), status: 'running', active_started_at: this.run().active_started_at ?? at })
        return frame
      }
      this.checkAdmission()
      if (prior?.status === 'running' && prior.lease_epoch === this.token.epoch && !prior.inherited) throw new EngineError('attempt_running', 'The task is already executing')
      if (prior && (prior.status === 'running' || prior.status === 'interrupted') && input.effect === 'write' && !prior.recovery_authorized) throw new EngineError('recover_required', 'An interrupted write requires explicit recovery')
      if (prior?.status === 'running') {
        this.db.put('attempts', { ...prior, status: 'interrupted', ended_at: at, error_code: 'owner_lost', error_message: 'Previous executor did not settle this attempt' })
        this.event(JSON.parse(String(prior.frame_json)) as AttemptFrame, 'step_interrupted', { code: 'owner_lost' })
      }
      const attempt = Number(prior?.attempt ?? 0) + 1
      if (attempt > input.retry.maxAttempts && !prior?.recovery_authorized) throw new EngineError('retry_exhausted', 'Maximum physical attempts reached for this visit')
      const frame: AttemptFrame = { runId: this.runId, nodePath: input.nodePath, scope: input.scope, task: input.task,
        visitId: String(visit.visit_id), visit: Number(visit.local_visit), transition: Number(visit.global_transition), attemptId: randomUUID(), attempt, leaseEpoch: this.token.epoch }
      this.db.put('attempts', { attempt_id: frame.attemptId, visit_id: frame.visitId, run_id: this.runId, node_path: frame.nodePath, scope_id: frame.scope.id,
        visit: frame.visit, attempt, branch: frame.scope.branchId ?? null, status: 'running', lease_epoch: this.token.epoch, frame_json: canonicalJson(frame), started_at: at })
      this.db.put('steps', { run_id: this.runId, node_path: frame.nodePath, scope_id: frame.scope.id, branch_id: frame.scope.branchId ?? null,
        kind: input.kind, visits: frame.visit, status: 'running', last_attempt_id: frame.attemptId, updated_at: at })
      this.db.put('runs', { ...this.run(), status: 'running', active_started_at: this.run().active_started_at ?? at })
      if (input.effect === 'write') this.db.put('runs', { ...this.run(), verified_json: null, current_revision: this.db.transactionRevision, updated_at: at })
      if (input.acceptsSteering) new ControlInbox(this.db, this.runId).claimForAttempt(frame)
      this.event(frame, 'step_started')
      return frame
    })
  }

  resultFor(frame: AttemptFrame): PieceResult | undefined {
    const row = this.db.get('attempts', { attempt_id: frame.attemptId })
    return row?.terminal_digest && row.status !== 'interrupted' && row.output_json ? JSON.parse(String(row.output_json)) as PieceResult : undefined
  }
  terminal(frame: AttemptFrame, result: PieceResult): TerminalCommit {
    this.lease.assert(this.token)
    const value = { schemaVersion: 1 as const, frame, result }
    if (Buffer.byteLength(canonicalJson(value)) > 2 * 1024 * 1024) throw new EngineError('output_limit', 'Terminal marker exceeds 2 MiB')
    const marker = { ...value, digest: contentDigest(value) }, prior = this.db.get('attempts', { attempt_id: frame.attemptId })
    if (prior?.terminal_digest) {
      if (prior.run_id !== this.runId || prior.terminal_digest !== marker.digest) throw new EngineError('terminal_conflict', 'Replay must preserve the original terminal marker')
    } else this.assertFrame(frame)
    return marker
  }

  /** Saver-only synchronous settlement; it shares the already-open pending-write transaction. */
  commitTerminal(marker: TerminalCommit, task: TaskIdentity): DurableEngineEvent[] {
    const { frame, result } = marker
    this.lease.assert(this.token)
    const attempt = this.db.get('attempts', { attempt_id: frame.attemptId })
    if (!attempt || attempt.run_id !== this.runId) throw new EngineError('attempt_mismatch', 'Terminal attempt does not belong to this run')
    const pendingVisit = this.bindPendingTask(task)
    if (marker.schemaVersion !== 1 || contentDigest({ schemaVersion: 1, frame, result }) !== marker.digest || pendingVisit?.visit_id !== frame.visitId ||
      frame.task.checkpointThreadId !== task.checkpointThreadId || frame.task.checkpointId !== task.checkpointId || frame.task.taskId !== task.taskId) throw new EngineError('terminal_mismatch', 'Terminal marker does not match its task or content digest')
    if (attempt.terminal_digest) {
      if (attempt.terminal_digest !== marker.digest) throw new EngineError('terminal_conflict', 'Settled attempt received conflicting terminal content')
      return []
    }
    this.assertFrame(frame)
    if (attempt.status !== 'running' && attempt.status !== 'paused') throw new EngineError('terminal_conflict', 'Only a live attempt may settle')
    const at = new Date(this.now()).toISOString(), status = result.status ?? 'succeeded', run = this.run()
    const completesRun = result.completesRun === true && result.completion !== undefined
    let candidate = run.candidate_json ? JSON.parse(String(run.candidate_json)) as { hash: string; revision: number } : undefined
    if (result.candidate) {
      if (result.candidate.revision <= Number(run.candidate_revision) || result.candidate.atTransition !== frame.transition) throw new EngineError('candidate_conflict', 'Candidate proposal is stale or belongs to another transition')
      candidate = result.candidate
      this.db.put('runs', { ...run, candidate_json: canonicalJson(result.candidate), candidate_revision: result.candidate.revision, verified_json: null })
    }
    const visit = this.db.get('visits', { visit_id: frame.visitId })!
    if (result.receipt) {
      const receipt = result.receipt
      if (receipt.valid && (!candidate || receipt.candidateHash !== candidate.hash)) throw new EngineError('receipt_invalid', 'A valid verification receipt must match the committed candidate')
      this.db.put('receipts', { receipt_id: receipt.id, run_id: this.runId, node_path: frame.nodePath, attempt_id: frame.attemptId,
        kind: 'verification', valid: receipt.valid ? 1 : 0, candidate_hash: receipt.candidateHash, candidate_revision: candidate?.revision ?? Number(run.candidate_revision), receipt_json: canonicalJson(receipt), created_at: at })
    }
    if (result.verified === null) this.db.put('runs', { ...this.run(), verified_json: null })
    else if (result.verified) {
      const receipt = result.receipt, verified = result.verified
      const evidence = receipt?.evidence && typeof receipt.evidence === 'object' && !Array.isArray(receipt.evidence) ? receipt.evidence : undefined
      if (!['verify', 'implementation'].includes(String(visit.kind)) || !receipt?.valid || receipt.scope !== 'full' || !candidate ||
        !Array.isArray(evidence?.commands) || evidence.commands.length === 0 ||
        (evidence.unverifiedRepositories !== undefined && (!Array.isArray(evidence.unverifiedRepositories) || evidence.unverifiedRepositories.length !== 0)) ||
        verified.receiptId !== receipt.id || verified.candidateHash !== candidate.hash || verified.revision !== candidate.revision || verified.atTransition !== frame.transition) {
        throw new EngineError('receipt_invalid', 'Only an authorized full verification of this candidate can certify the run')
      }
      this.db.put('runs', { ...this.run(), verified_json: canonicalJson(verified) })
    }
    this.db.put('attempts', { ...attempt, status, ended_at: at, outcome: result.outcome, output_json: canonicalJson(result), terminal_digest: marker.digest,
      error_code: result.error?.code ?? null, error_message: result.error?.message ?? null })
    const step = this.db.get('steps', { run_id: this.runId, node_path: frame.nodePath, scope_id: frame.scope.id })!
    this.db.put('steps', { ...step, status, updated_at: at })
    this.db.put('runs', { ...this.run(), current_revision: this.db.transactionRevision, updated_at: at,
      consecutive_failures: visit.requires_ai ? (status === 'succeeded' ? 0 : Number(this.run().consecutive_failures) + 1) : this.run().consecutive_failures,
      ...(completesRun ? { completion_json: canonicalJson(result.completion), status: result.completion!.ok ? 'succeeded' : 'failed',
        active_duration_ms: this.activeDurationMs(), active_started_at: null } : {}) })
    return [this.event(frame, `step_${status}`, { outcome: result.outcome, ...(result.error ? { error: result.error } : {}) }),
      ...(completesRun ? [appendRunEvent(this.db, this.runId, result.completion!.ok ? 'workflow_succeeded' : 'workflow_failed', result.completion as unknown as JsonValue, {}, at)] : [])]
  }

  fail(frame: AttemptFrame, error: { code: string; message: string }, retryable: boolean): void {
    this.db.transaction('attempt-failed', () => {
      const row = this.assertFrame(frame)
      if (row.status === 'failed') return
      if (row.status !== 'running') throw new EngineError('terminal_conflict', 'Attempt is not running')
      const at = new Date(this.now()).toISOString()
      this.db.put('attempts', { ...row, status: 'failed', ended_at: at, error_code: error.code, error_message: error.message })
      const visit = this.db.get('visits', { visit_id: frame.visitId })!, run = this.run()
      if (visit.requires_ai) this.db.put('runs', { ...run, consecutive_failures: Number(run.consecutive_failures) + 1 })
      this.event(frame, retryable ? 'step_retrying' : 'step_failed', error)
    })
  }

  /** Stages evidence before an error is rethrown; saver owns its terminal __error__ transaction. */
  prepareInterruption(frame: AttemptFrame, error: { code: string; message: string }): void {
    this.db.transaction('interruption-prepared', () => {
      const attempt = this.assertFrame(frame)
      this.db.put('attempts', { ...attempt, interruption_json: canonicalJson(error) })
    })
  }

  commitError(task: TaskIdentity, error: unknown): DurableEngineEvent[] {
    this.lease.assert(this.token)
    const visit = this.bindPendingTask(task)
    if (!visit) return []
    const attempt = this.db.sqlite.prepare('SELECT * FROM attempts WHERE visit_id=? ORDER BY attempt DESC LIMIT 1').get(visit.visit_id)!
    if (attempt.status !== 'running') return []
    const frame = JSON.parse(String(attempt.frame_json)) as AttemptFrame
    this.assertFrame(frame)
    const staged = attempt.interruption_json ? JSON.parse(String(attempt.interruption_json)) as { code: string; message: string } : undefined
    const message = error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
    const failure = staged ?? { code: 'internal', message }, status = staged && visit.effect === 'write' ? 'interrupted' : 'failed', at = new Date(this.now()).toISOString()
    this.db.put('attempts', { ...attempt, status, ended_at: at, error_code: failure.code, error_message: failure.message })
    const step = this.db.get('steps', { run_id: this.runId, node_path: frame.nodePath, scope_id: frame.scope.id })!
    this.db.put('steps', { ...step, status, updated_at: at })
    this.db.put('runs', { ...this.run(), status, active_duration_ms: this.activeDurationMs(), active_started_at: null, updated_at: at })
    return [this.event(frame, `step_${status}`, failure)]
  }

  /** Called by saver when LangGraph records the actual public interrupt IDs. */
  commitInterrupts(task: TaskIdentity, values: Array<{ id: string; value: JsonValue }>): DurableEngineEvent[] {
    this.lease.assert(this.token)
    const visit = this.bindPendingTask(task)
    if (!visit) return []
    const attempt = this.db.sqlite.prepare('SELECT * FROM attempts WHERE visit_id=? ORDER BY attempt DESC LIMIT 1').get(visit.visit_id)!
    const frame = JSON.parse(String(attempt.frame_json)) as AttemptFrame
    this.assertFrame(frame)
    const at = new Date(this.now()).toISOString(), events: DurableEngineEvent[] = []
    for (const value of values) {
      if (this.db.get('interrupts', { interrupt_id: value.id })) continue
      const payload = value.value && typeof value.value === 'object' && !Array.isArray(value.value) ? value.value : {}
      this.db.put('interrupts', { interrupt_id: value.id, run_id: this.runId, visit_id: frame.visitId, attempt_id: frame.attemptId,
        node_path: frame.nodePath, scope_id: frame.scope.id, branch_id: frame.scope.branchId ?? null, kind: String(payload.kind ?? 'gate'),
        requested_at: at, payload_json: canonicalJson(value.value) })
      events.push(this.event(frame, 'step_paused', { interruptId: value.id, request: value.value }))
    }
    this.db.put('attempts', { ...attempt, status: 'paused' })
    const step = this.db.get('steps', { run_id: this.runId, node_path: frame.nodePath, scope_id: frame.scope.id })!
    this.db.put('steps', { ...step, status: 'paused', updated_at: at })
    this.db.put('runs', { ...this.run(), status: 'paused', updated_at: at, active_duration_ms: this.activeDurationMs(), active_started_at: null })
    return events
  }

  /** Actual LangGraph interrupt identities, with answers retained across crashes before resume. */
  interrupts(): Array<{ id: string; nodePath: string; scopeId: string; branchId?: string; attemptId: string; kind: string; requestedAt: string; value: JsonValue; answer?: JsonValue }> {
    return this.db.sqlite.prepare('SELECT * FROM interrupts WHERE run_id=? ORDER BY requested_at,interrupt_id').all(this.runId).map(row => ({
      id: String(row.interrupt_id), nodePath: String(row.node_path), scopeId: String(row.scope_id), attemptId: String(row.attempt_id),
      kind: String(row.kind), requestedAt: String(row.requested_at), value: JSON.parse(String(row.payload_json)) as JsonValue,
      ...(row.branch_id ? { branchId: String(row.branch_id) } : {}), ...(row.answer_json !== null ? { answer: JSON.parse(String(row.answer_json)) as JsonValue } : {}),
    }))
  }

  pendingInterrupts(): ReturnType<RunLedger['interrupts']> {
    return this.interrupts().filter(value => value.answer === undefined)
  }

  /** Persist validated answers before invoking Command; a retry must reuse exactly those answers. */
  answerInterrupts(answers: Record<string, JsonValue>): void {
    const entries = Object.entries(answers)
    if (!entries.length || Buffer.byteLength(canonicalJson(answers)) > 2 * 1024 * 1024) throw new EngineError('invalid_arguments', 'Resume requires bounded answers by interrupt ID')
    this.db.transaction('interrupts-answered', () => {
      this.lease.assert(this.token)
      for (const [id, value] of entries) {
        const row = this.db.get('interrupts', { interrupt_id: id }), encoded = canonicalJson(value)
        if (!row || row.run_id !== this.runId) throw new EngineError('interrupt_not_found', 'Resume targets an unknown interrupt')
        if (row.answer_json !== null) {
          if (row.answer_json !== encoded) throw new EngineError('answer_conflict', 'A durable interrupt answer cannot change')
          continue
        }
        const attempt = this.db.get('attempts', { attempt_id: row.attempt_id })!
        if (attempt.status !== 'paused') throw new EngineError('interrupt_not_pending', 'The targeted interrupt is no longer paused')
        this.db.put('interrupts', { ...row, answer_json: encoded, answered_at: new Date(this.now()).toISOString() })
        appendRunEvent(this.db, this.runId, 'interrupt_answered', { interruptId: id })
      }
    })
  }

  /** The run owner calls this only after graph.invoke has reached an idle interrupt barrier. */
  settlePause(): void {
    if (!this.pendingInterrupts().length || this.run().completion_json) return
    this.db.transaction('workflow-paused', () => {
      this.lease.assert(this.token)
      const run = this.run()
      if (run.completion_json || !this.pendingInterrupts().length) return
      const duration = this.activeDurationMs()
      this.db.put('runs', { ...run, status: 'paused', active_duration_ms: duration, active_started_at: null, updated_at: new Date(this.now()).toISOString() })
      const last = this.db.sqlite.prepare("SELECT type FROM events WHERE run_id=? AND type IN ('workflow_paused','workflow_resumed') ORDER BY sequence DESC LIMIT 1").get(this.runId)
      if (last?.type !== 'workflow_paused') appendRunEvent(this.db, this.runId, 'workflow_paused', { interruptIds: this.pendingInterrupts().map(value => value.id) })
    })
  }

  authorizeRecovery(attemptId: string): void {
    this.db.transaction('recovery-authorized', () => {
      this.lease.assert(this.token)
      const attempt = this.db.get('attempts', { attempt_id: attemptId })
      if (!attempt || attempt.run_id !== this.runId || !['running', 'interrupted'].includes(String(attempt.status))) throw new EngineError('invalid_arguments', 'Attempt does not require recovery')
      this.db.put('attempts', { ...attempt, recovery_authorized: 1 })
      appendRunEvent(this.db, this.runId, 'recovery_authorized', { attemptId })
    })
  }

  startInvocation(frame: AttemptFrame, input: Omit<PendingProviderInvocation, 'ordinal'> & { role?: string },
    reservation: { maxTokens?: number; maxCostUsd?: number } = {}): number {
    return this.db.transaction('invocation-started', () => {
      this.assertFrame(frame); this.checkAdmission()
      for (const [key, value] of Object.entries(reservation)) if (value !== undefined && (!Number.isFinite(value) || value < 0 || (key === 'maxTokens' && !Number.isSafeInteger(value)))) throw new EngineError('invalid_arguments', 'Invocation reservations must be non-negative finite bounds')
      if (this.db.get('invocations', { invocation_id: input.invocationId })) throw new EngineError('invocation_exists', 'A physical invocation ID cannot be reused')
      const budget = this.db.get('budget', { run_id: this.runId })!, live = this.db.sqlite.prepare('SELECT COALESCE(SUM(max_tokens),0) tokens,COALESCE(SUM(max_cost_usd),0) cost FROM reservations WHERE run_id=?').get(this.runId)!
      if (budget.max_tokens !== null && (reservation.maxTokens === undefined || Number(budget.known_tokens) + Number(live.tokens) + reservation.maxTokens > Number(budget.max_tokens))) throw new EngineError('budget_exhausted', 'Invocation token reservation exceeds the shared budget')
      if (budget.max_cost_usd !== null && (reservation.maxCostUsd === undefined || Number(budget.known_cost_usd) + Number(live.cost) + reservation.maxCostUsd > Number(budget.max_cost_usd))) throw new EngineError('budget_exhausted', 'Invocation cost reservation requires a known upper bound within the shared budget')
      const at = new Date(this.now()).toISOString()
      const ordinal = Number(this.db.sqlite.prepare('SELECT COALESCE(MAX(ordinal),0)+1 value FROM invocations WHERE attempt_id=?').get(frame.attemptId)!.value)
      this.db.put('reservations', { reservation_id: input.invocationId, run_id: this.runId, attempt_id: frame.attemptId,
        max_tokens: reservation.maxTokens ?? null, max_cost_usd: reservation.maxCostUsd ?? null, created_at: at })
      this.db.put('invocations', { invocation_id: input.invocationId, run_id: this.runId, attempt_id: frame.attemptId, node_path: frame.nodePath,
        role: input.role ?? null, provider: input.provider, model: input.model ?? null, kind: input.kind ?? null, status: 'running', started_at: at,
        usage_json: '{}', prompt_bytes: input.promptBytes ?? null, context_bytes: input.contextBytes ?? null, ordinal })
      return ordinal
    })
  }

  settleInvocation(frame: AttemptFrame, rawInvocation: ProviderInvocation & { invocationId: string }, memo?: { key: string; value: JsonValue }): void {
    this.db.transaction('invocation-settled', () => {
      this.assertFrame(frame)
      const invocation = { ...rawInvocation, usage: { ...rawInvocation.usage, costUsd: rawInvocation.usage.costUsd ?? null,
        inputTokens: rawInvocation.usage.inputTokens ?? null, outputTokens: rawInvocation.usage.outputTokens ?? null } }
      const row = this.db.get('invocations', { invocation_id: invocation.invocationId })
      if (!row || row.attempt_id !== frame.attemptId) throw new EngineError('invocation_mismatch', 'Invocation must belong to its physical attempt')
      const serialized = canonicalJson(invocation)
      if (row.status !== 'running') {
        if (row.result_json !== serialized) throw new EngineError('invocation_conflict', 'Invocation settlement cannot change')
        return
      }
      for (const value of [invocation.durationMs, invocation.toolCalls, ...Object.values(invocation.usage)]) if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) throw new EngineError('invalid_usage', 'Invocation usage must be non-negative or unknown')
      const usage = invocation.usage, budget = this.db.get('budget', { run_id: this.runId })!, at = new Date(this.now()).toISOString()
      this.db.put('invocations', { ...row, status: invocation.status, ended_at: at, duration_ms: invocation.durationMs,
        tool_calls: invocation.toolCalls, usage_json: canonicalJson(usage), result_json: serialized })
      const reservation = this.db.get('reservations', { reservation_id: invocation.invocationId })
      // Settlement with missing usage does not prove the unused reservation is free.
      // Retain only the unreported dimensions, without relabeling a bound as billed usage.
      if (reservation && (usage.costUsd === null || usage.inputTokens === null || usage.outputTokens === null)) {
        this.db.put('reservations', { ...reservation,
          max_cost_usd: usage.costUsd === null ? reservation.max_cost_usd : 0,
          max_tokens: usage.inputTokens === null || usage.outputTokens === null
            ? reservation.max_tokens === null ? null : Math.max(0, Number(reservation.max_tokens) - (usage.inputTokens ?? 0) - (usage.outputTokens ?? 0)) : 0 })
      } else this.db.delete('reservations', { reservation_id: invocation.invocationId })
      this.db.put('budget', { ...budget, known_cost_usd: Number(budget.known_cost_usd) + (usage.costUsd ?? 0),
        known_tokens: Number(budget.known_tokens) + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        input_tokens: Number(budget.input_tokens) + (usage.inputTokens ?? 0), output_tokens: Number(budget.output_tokens) + (usage.outputTokens ?? 0),
        cost_unknown: budget.cost_unknown || usage.costUsd === null ? 1 : 0, input_unknown: budget.input_unknown || usage.inputTokens === null ? 1 : 0,
        output_unknown: budget.output_unknown || usage.outputTokens === null ? 1 : 0, duration_ms: Number(budget.duration_ms) + invocation.durationMs })
      if (memo) this.storePieceState(frame, memo.key, memo.value)
      this.event(frame, 'efficiency_updated', { ...invocation, startedAt: String(row.started_at), finishedAt: at } as unknown as JsonValue)
    })
  }

  readPieceState(frame: AttemptFrame, key: string): JsonValue | undefined {
    const row = this.db.get('piece_state', { run_id: this.runId, scope_id: frame.scope.id, node_path: frame.nodePath, key })
    return row ? JSON.parse(String(row.value_json)) as JsonValue : undefined
  }
  private storePieceState(frame: AttemptFrame, key: string, value: JsonValue, ownerNodePath = frame.nodePath): void {
    if (!key || key.length > 1024) throw new EngineError('invalid_arguments', 'Piece state key must contain 1–1024 characters')
    const serialized = canonicalJson(value)
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new EngineError('output_limit', 'Piece state exceeds 2 MiB')
    const previous = this.db.get('piece_state', { run_id: this.runId, scope_id: frame.scope.id, node_path: ownerNodePath, key })
    if (key.startsWith('memo:') && previous && previous.value_json !== serialized) throw new EngineError('piece_state_conflict', 'A memoized physical result cannot change')
    this.db.put('piece_state', { run_id: this.runId, scope_id: frame.scope.id, node_path: ownerNodePath, key, visit_id: frame.visitId,
      value_json: serialized, updated_at: new Date(this.now()).toISOString() })
  }
  writePieceState(frame: AttemptFrame, key: string, value: JsonValue): void {
    this.db.transaction('piece-state-updated', () => { this.assertFrame(frame); this.storePieceState(frame, key, value) })
  }

  private sessionOwner(frame: AttemptFrame, ownerNodePath: string, key: string): string {
    const owner = ownerNodePath.replace(/\/$/, '')
    if (!key.startsWith('session:') || (owner !== '' && owner !== frame.nodePath && !frame.nodePath.startsWith(owner + '/'))) {
      throw new EngineError('piece_state_scope', 'Shared sessions require an ancestor node owner in this execution scope')
    }
    return owner
  }

  readScopedPieceState(frame: AttemptFrame, ownerNodePath: string, key: string): JsonValue | undefined {
    this.assertFrame(frame)
    const owner = this.sessionOwner(frame, ownerNodePath, key)
    const row = this.db.get('piece_state', { run_id: this.runId, scope_id: frame.scope.id, node_path: owner, key })
    return row ? JSON.parse(String(row.value_json)) as JsonValue : undefined
  }

  writeScopedPieceState(frame: AttemptFrame, ownerNodePath: string, key: string, value: JsonValue): void {
    const owner = this.sessionOwner(frame, ownerNodePath, key)
    this.db.transaction('scoped-session-updated', () => { this.assertFrame(frame); this.storePieceState(frame, key, value, owner) })
  }

  usage(): EngineUsage {
    const row = this.db.get('budget', { run_id: this.runId })!, pending = this.reservationStatus().pendingInvocations > 0
    return { revision: this.db.revision, invocations: Number(this.db.sqlite.prepare("SELECT COUNT(*) AS count FROM invocations WHERE run_id=? AND status!='running'").get(this.runId)!.count),
      costUsd: pending || row.cost_unknown ? null : Number(row.known_cost_usd), inputTokens: pending || row.input_unknown ? null : Number(row.input_tokens), outputTokens: pending || row.output_unknown ? null : Number(row.output_tokens),
      knownCostUsd: Number(row.known_cost_usd), knownInputTokens: Number(row.input_tokens), knownOutputTokens: Number(row.output_tokens) }
  }

  /** Unreported spend keeps its reservation through recovery; bounds remain distinct from known usage. */
  reservationStatus(): { pendingInvocations: number; knownTokens: number; knownCostUsd: number; tokensUnknown: boolean; costUnknown: boolean } {
    const pending = Number(this.db.sqlite.prepare("SELECT COUNT(*) count FROM invocations WHERE run_id=? AND status='running'").get(this.runId)!.count)
    const row = this.db.sqlite.prepare('SELECT COALESCE(SUM(max_tokens),0) tokens,COALESCE(SUM(max_cost_usd),0) cost,COUNT(*)-COUNT(max_tokens) unknown_tokens,COUNT(*)-COUNT(max_cost_usd) unknown_cost FROM reservations WHERE run_id=?').get(this.runId)!
    return { pendingInvocations: pending, knownTokens: Number(row.tokens), knownCostUsd: Number(row.cost), tokensUnknown: Number(row.unknown_tokens) > 0, costUnknown: Number(row.unknown_cost) > 0 }
  }

  activeDurationMs(): number {
    const run = this.run()
    return Number(run.active_duration_ms) + (run.active_started_at ? Math.max(0, Math.min(this.now(), this.lease.current()?.expiresAt ?? this.now()) - Date.parse(String(run.active_started_at))) : 0)
  }

  scopeSnapshot(scopeId = '*'): {
    runId: string; scopeId: string; status: string; transitions: number; usage: EngineUsage;
    candidate: import('../contracts.js').CandidateState | null; verified: import('../contracts.js').VerifiedState | null;
    consecutiveFailures: { revision: number; count: number };
    attempts: Array<{ frame: AttemptFrame; status: string; result?: PieceResult; error?: { code: string; message: string } }>;
  } {
    const run = this.run()
    return { runId: this.runId, scopeId, status: String(run.status), transitions: Number(run.transitions), usage: this.usage(),
      candidate: run.candidate_json ? JSON.parse(String(run.candidate_json)) : null, verified: run.verified_json ? JSON.parse(String(run.verified_json)) : null,
      consecutiveFailures: { revision: this.db.revision, count: Number(run.consecutive_failures) },
      attempts: this.db.sqlite.prepare("SELECT a.* FROM attempts a JOIN visits v ON a.visit_id=v.visit_id WHERE a.run_id=? AND (?='*' OR a.scope_id=?) ORDER BY v.global_transition,a.attempt").all(this.runId, scopeId, scopeId).map(row => ({
        frame: JSON.parse(String(row.frame_json)) as AttemptFrame, status: String(row.status),
        ...(row.output_json ? { result: JSON.parse(String(row.output_json)) as PieceResult } : {}),
        ...(row.error_code ? { error: { code: String(row.error_code), message: String(row.error_message ?? '') } } : {}),
      })) }
  }

  events(after = 0): DurableEngineEvent[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new EngineError('invalid_arguments', 'Event cursor must be a non-negative integer')
    return this.db.sqlite.prepare('SELECT payload_json FROM events WHERE run_id=? AND sequence>? AND inherited=0 ORDER BY sequence').all(this.runId, after).map(row => JSON.parse(String(row.payload_json)) as DurableEngineEvent)
  }
}
