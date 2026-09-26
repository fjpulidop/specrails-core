import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Command } from '@langchain/langgraph'
import { pipelineStateDirectory, type PipelineContext } from '../../pipeline/pipeline-state.js'
import { coreRuntimeIdentity } from '../core-host.js'
import { sameRuntimeIdentity, type RuntimeIdentity } from '../runtime-identity.js'
import type { ExecutorRegistry } from '../executors.js'
import { appendRunEvent, RunDatabase } from './checkpoint/database.js'
import { RunLedger } from './checkpoint/ledger.js'
import { RunLease } from './checkpoint/lease.js'
import { EngineError, type JsonObject, type JsonValue } from './contracts.js'
import { EngineEventStream } from './events.js'
import { initialDefinitionState } from './state.js'
import { preflightDefinition, type DefinitionRunInput, type DefinitionRunRequest } from './preflight.js'
import { observeLedger, projectRunStatus } from './run-status.js'
import { ControlInbox } from './steering/inbox.js'
import { ledgerBudget } from './invocation-context.js'
import { composeDefinitionRuntime } from './composition.js'
import { createEngineTelemetry } from './otel.js'
import { describeDefinition } from './graph-description.js'

export const definitionRunDirectory = (context: PipelineContext): string => path.join(pipelineStateDirectory(context), 'agent-workflow')
export interface RunObservers { signal?: AbortSignal; onEvent?: (value: JsonObject) => void; afterEvent?: number }
export interface ResumeDefinitionOptions extends RunObservers {
  registry?: ExecutorRegistry
  answers?: Record<string, JsonValue>
  recover?: string[]
  /** Optional frozen host context assertion prevents attaching another project's run. */
  context?: PipelineContext
}
type Admitted = Awaited<ReturnType<typeof preflightDefinition>>

export async function createRun(input: DefinitionRunInput & RunObservers) {
  const admitted = await preflightDefinition(input)
  const database = await RunDatabase.open(path.join(definitionRunDirectory(admitted.request.context), 'run.sqlite'), { create: true })
  try {
    RunLedger.initialize(database, { runId: admitted.request.context.runId, workflowId: admitted.definition.id,
      definitionHash: admitted.definition.version, definition: admitted.definition, request: admitted.request,
      runtimeIdentity: coreRuntimeIdentity(), source: 'definition', budget: admitted.budget })
    const result = await execute(database, admitted, { ...input, context: admitted.request.context }, false)
    return { ...projectRunStatus(observeLedger(database)), ...('error' in result ? { error: result.error } : {}) }
  } finally { database.close() }
}

export async function resumeRun(directory: string, options: ResumeDefinitionOptions = {}) {
  const database = await RunDatabase.open(path.join(directory, 'run.sqlite'))
  try {
    const view = observeLedger(database), row = view.run()
    if (!sameRuntimeIdentity(JSON.parse(String(row.runtime_identity_json)) as RuntimeIdentity, coreRuntimeIdentity())) throw new EngineError('resume_incompatible', 'Resume requires the retained original Core package')
    const request = JSON.parse(String(row.request_json)) as DefinitionRunRequest
    if (options.answers && Object.keys(options.answers).length) validateAnswers(view, options.answers)
    if (options.context && JSON.stringify(options.context) !== JSON.stringify(request.context)) {
      const { contentDigest } = await import('./canonical-json.js')
      if (contentDigest(options.context) !== contentDigest(request.context)) throw new EngineError('scope_mismatch', 'Host context differs from the frozen run')
    }
    if (row.completion_json || row.status === 'cancelled') {
      new EngineEventStream(cursor => view.events(cursor), options.onEvent ?? (() => {})).send(describeDefinition(view.runId, JSON.parse(String(row.definition_json))))
      return projectRunStatus(view)
    }
    const admitted = await preflightDefinition({ ...request, definition: JSON.parse(String(row.definition_json)), registry: options.registry })
    const result = await execute(database, admitted, options, true)
    return { ...projectRunStatus(observeLedger(database)), ...('error' in result ? { error: result.error } : {}) }
  } finally { database.close() }
}

/** Every effect runs under one lease and cancellation domain; the saver owns settlement. */
async function execute(database: RunDatabase, admitted: Admitted, options: ResumeDefinitionOptions, resume: boolean) {
  const runId = admitted.request.context.runId, lease = new RunLease(database, runId), token = lease.acquire(randomUUID())
  const ledger = new RunLedger(database, token, { maxTransitions: admitted.definition.maxTransitions, failFast: admitted.definition.policies?.failFast })
  const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason ?? new EngineError('aborted', 'Execution cancelled'))
  if (options.signal?.aborted) abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const stopHeartbeat = lease.heartbeat(token, error => controller.abort(error)), inbox = new ControlInbox(database, runId)
  const telemetry = createEngineTelemetry()
  const stream = new EngineEventStream(cursor => ledger.events(cursor), options.onEvent ?? (() => {}), options.afterEvent, undefined, event => telemetry?.observe(event))
  let runtime: Awaited<ReturnType<typeof composeDefinitionRuntime>> | undefined
  const config = { configurable: { thread_id: String(ledger.run().checkpoint_thread_id) }, durability: 'sync' as const,
    recursionLimit: admitted.definition.maxTransitions * 4 + 20 }
  const controlTimer = setInterval(() => {
    try {
      if (inbox.cancellationRequested()) controller.abort(new EngineError('aborted', 'Cancellation requested'))
      const limit = ledgerBudget(ledger).maxDurationMs
      if (limit !== undefined && ledger.activeDurationMs() >= limit) controller.abort(new EngineError('timeout', 'Workflow active-duration budget exhausted'))
    } catch (error) { controller.abort(error) }
  }, 250)
  controlTimer.unref()
  try {
    stream.send(describeDefinition(runId, admitted.definition))
    runtime = await composeDefinitionRuntime(database, ledger, admitted, stream, controller.signal)
    const { graph, saver, deps } = runtime
    deps.initializeCandidate()
    if (options.answers && Object.keys(options.answers).length) {
      validateAnswers(ledger, options.answers)
      ledger.answerInterrupts(options.answers)
    }
    for (const target of options.recover ?? []) {
      const rows = database.sqlite.prepare("SELECT a.attempt_id FROM attempts a JOIN visits v ON a.visit_id=v.visit_id JOIN steps s ON s.last_attempt_id=a.attempt_id WHERE a.run_id=? AND (a.attempt_id=? OR a.node_path=?) AND a.terminal_digest IS NULL AND a.status IN ('running','interrupted') AND v.effect='write'").all(runId, target, target)
      if (rows.length !== 1) throw new EngineError('recovery_ambiguous', 'Recovery must identify exactly one interrupted write attempt')
      ledger.authorizeRecovery(String(rows[0].attempt_id))
    }
    if (resume) database.transaction('workflow-resumed', () => {
      lease.assert(token)
      appendRunEvent(database, runId, 'workflow_resumed', {})
    })
    stream.flush()
    const snapshot = await graph.getState(config, { subgraphs: true })
    const activeInterrupts = new Set(snapshot.tasks.flatMap(task => task.interrupts).map(value => value.id))
    const answers = Object.fromEntries(ledger.interrupts().filter(value => value.answer !== undefined && activeInterrupts.has(value.id)).map(value => [value.id, value.answer!]))
    const checkpoint = await saver.getTuple(config)
    const hasInterrupts = snapshot.tasks.some(task => task.interrupts.length > 0)
    if (hasInterrupts && !Object.keys(answers).length) return projectRunStatus(ledger)
    await graph.invoke(!checkpoint ? initialDefinitionState(admitted.request.change ? { changeId: admitted.request.change } : {}) : Object.keys(answers).length && hasInterrupts ? new Command({ resume: answers }) : null,
      { ...config, signal: controller.signal })
    ledger.settlePause()
    const row = ledger.run()
    if (!row.completion_json && !ledger.pendingInterrupts().length && !['interrupted', 'failed', 'blocked'].includes(String(row.status))) {
      throw new EngineError('completion_missing', 'Graph stopped without a durable completion or pending interruption')
    }
    return projectRunStatus(ledger)
  } catch (error) {
    // A lost owner may observe, but can never settle effects after a newer epoch.
    if (controller.signal.reason instanceof EngineError && controller.signal.reason.code === 'lease_lost') throw controller.signal.reason
    const reason = controller.signal.aborted ? controller.signal.reason : error
    const code = reason instanceof EngineError || reason && typeof reason === 'object' && 'code' in reason ? String((reason as { code: unknown }).code) : 'execution_failed'
    const message = reason instanceof Error ? reason.message : String(reason)
    database.transaction('execution-stopped', () => {
      lease.assert(token)
      const row = ledger.run()
      if (row.completion_json) return
      const status = code === 'aborted' ? 'cancelled' : row.status === 'interrupted' || code === 'recover_required' ? 'interrupted' : 'failed'
      database.put('runs', { ...row, status, active_duration_ms: ledger.activeDurationMs(), active_started_at: null, updated_at: new Date().toISOString() })
      appendRunEvent(database, runId, status === 'cancelled' ? 'workflow_cancelled' : 'workflow_failed', { error: { code, message } })
    })
    if (inbox.cancellationRequested()) inbox.acknowledgeCancellation(token)
    const status = projectRunStatus(ledger)
    return { ...status, error: { code, message } }
  } finally {
    clearInterval(controlTimer); stopHeartbeat(); options.signal?.removeEventListener('abort', abort)
    runtime?.close(); stream.flush(); lease.release(token); await telemetry?.close()
  }
}

function validateAnswers(ledger: RunLedger, answers: Record<string, JsonValue>): void {
  const known = new Map(ledger.interrupts().map(value => [value.id, value]))
  for (const [id, value] of Object.entries(answers)) {
    const request = known.get(id)
    if (!request) throw new EngineError('interrupt_not_found', 'Unknown interrupt ID')
    const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    if (request.kind === 'question' ? typeof object.answer !== 'string' || !object.answer.trim() : object.approved !== true) throw new EngineError('invalid_resume', 'Resume requires a matching nonempty answer or explicit approval')
  }
}

export async function signalRun(directory: string, text: string, requestId?: string) {
  const database = await RunDatabase.open(path.join(directory, 'run.sqlite'))
  try { return new ControlInbox(database, observeLedger(database).runId).append(text, { requestId }) } finally { database.close() }
}

export async function cancelRun(directory: string, requestId?: string) {
  const database = await RunDatabase.open(path.join(directory, 'run.sqlite'))
  try {
    const runId = observeLedger(database).runId, inbox = new ControlInbox(database, runId), accepted = inbox.cancel(requestId)
    const lease = new RunLease(database, runId)
    if ((lease.current()?.expiresAt ?? 0) > Date.now()) return accepted
    const token = lease.acquire(randomUUID())
    try {
      const ledger = new RunLedger(database, token, { maxTransitions: 1 })
      database.transaction('workflow-cancelled', () => {
        lease.assert(token)
        database.put('runs', { ...ledger.run(), status: 'cancelled', active_duration_ms: ledger.activeDurationMs(), active_started_at: null })
        appendRunEvent(database, runId, 'workflow_cancelled', {})
      })
      inbox.acknowledgeCancellation(token)
    } finally { lease.release(token) }
    return accepted
  } finally { database.close() }
}
