import { Command, END, START, StateGraph, interrupt, isGraphInterrupt, isInterrupted } from '@langchain/langgraph'
import type { RunnableConfig } from '@langchain/core/runnables'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { acquireWorkflowLease, fingerprint, readWorkflowEnvelope, writeWorkflowEnvelope } from './durable-store.js'
import { FileCheckpointSaver, type SerializedGraphStore } from './graph-checkpointer.js'
import type {
  InterruptRequest, InterruptResume, JsonValue, NodeResult, RunWorkflowOptions, StepAttemptRecord, StepUsage, WorkflowBudget,
  WorkflowDefinition, WorkflowEvent, WorkflowSpan, WorkflowState, WorkflowStatus, WorkflowStepContext,
} from './workflow-types.js'

export * from './workflow-types.js'
export { readWorkflowState, readWorkflowEnvelope, writeWorkflowEnvelope, WorkflowStoreError, type WorkflowEnvelope } from './durable-store.js'

export class WorkflowError extends Error {
  constructor(public readonly code: 'INVALID_WORKFLOW' | 'ALREADY_EXISTS' | 'NOT_FOUND' | 'INCOMPATIBLE_RESUME', message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}
/** Leaves the graph parked at the node whose terminal receipt is already committed, so a resume re-runs it. */
class StepTerminated extends Error {
  constructor(public readonly status: WorkflowStatus) { super(`Workflow ${status}`); this.name = 'StepTerminated' }
}

type EventInput = Omit<WorkflowEvent, 'id' | 'sequence' | 'runId' | 'timestamp' | 'traceId'>
const clone = <T>(value: T): T => structuredClone(value)
const NODE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/
const RESERVED = new Set<string>([START, END, 'next'])
const ANSWER_LIMIT = 20_000

function validateBudget(budget: WorkflowBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (value === undefined && ['maxCostUsd', 'maxTokens', 'maxDurationMs'].includes(name)) continue
    if (!['maxCostUsd', 'maxTokens', 'maxDurationMs'].includes(name) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new WorkflowError('INVALID_WORKFLOW', `Invalid workflow budget ${name}`)
    }
  }
}

function definedBudget(budget: WorkflowBudget): WorkflowBudget {
  return Object.fromEntries(Object.entries(budget).filter(([, value]) => value !== undefined))
}

function validateWorkflow<S extends Record<string, unknown>>(workflow: WorkflowDefinition<S>): string {
  const ids = Object.keys(workflow.nodes ?? {})
  if (typeof workflow.id !== 'string' || !workflow.id || typeof workflow.version !== 'string' || !workflow.version || !ids.length || !workflow.schema) {
    throw new WorkflowError('INVALID_WORKFLOW', 'Workflow requires an id, version, state schema and at least one node')
  }
  for (const id of ids) {
    const node = workflow.nodes[id]!
    if (!NODE_ID.test(id) || RESERVED.has(id) || typeof node.run !== 'function' || !Array.isArray(node.ends) ||
        node.ends.some(end => !ids.includes(end)) || new Set(node.ends).size !== node.ends.length ||
        (node.effect !== undefined && node.effect !== 'read' && node.effect !== 'write') ||
        !Number.isInteger(node.maxAttempts ?? 1) || (node.maxAttempts ?? 1) < 1 || (node.maxAttempts ?? 1) > 100) {
      throw new WorkflowError('INVALID_WORKFLOW', `Invalid workflow node ${id}`)
    }
  }
  if (!ids.includes(workflow.entry)) throw new WorkflowError('INVALID_WORKFLOW', `Unknown entry node ${workflow.entry}`)
  // LangGraph addresses channels and nodes in one namespace.
  const channels = Object.keys((workflow.schema as { spec?: Record<string, unknown> }).spec ?? {})
  for (const id of ids) if (channels.includes(id)) throw new WorkflowError('INVALID_WORKFLOW', `Node ${id} shares its name with a state channel`)
  const maxTransitions = workflow.maxTransitions ?? 100
  if (!Number.isInteger(maxTransitions) || maxTransitions < 1 || maxTransitions > 10_000) {
    throw new WorkflowError('INVALID_WORKFLOW', 'maxTransitions must be an integer from 1 to 10000')
  }
  return fingerprint({
    id: workflow.id, version: workflow.version, maxTransitions, entry: workflow.entry,
    nodes: ids.map(id => ({ id, effect: workflow.nodes[id]!.effect ?? 'read', maxAttempts: workflow.nodes[id]!.maxAttempts ?? 1, retrySafe: workflow.nodes[id]!.retrySafe ?? false, ends: workflow.nodes[id]!.ends })),
  })
}

function validateUsage(usage: StepUsage | undefined): void {
  if (usage === undefined) return
  for (const key of ['costUsd', 'inputTokens', 'outputTokens'] as const) {
    const value = usage[key]
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'costUsd' && !Number.isInteger(value)))) {
      throw new TypeError(`Invalid step usage ${key}`)
    }
  }
}

function accountUsage(state: WorkflowState, usage?: StepUsage): void {
  for (const key of ['costUsd', 'inputTokens', 'outputTokens'] as const) {
    const value = usage?.[key]
    state.usage[key] = state.usage[key] === null || value == null ? null : state.usage[key] + value
  }
  state.usage.knownCostUsd += usage?.costUsd ?? 0
  state.usage.knownTokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
}

/** Sum of everything an attempt reported; unknown values stay unknown instead of becoming zero. */
function addUsage(total: StepUsage, usage: StepUsage | undefined): StepUsage {
  const add = (a: number | null | undefined, b: number | null | undefined): number | null => a === null || b === null || b === undefined && a === undefined ? null : (a ?? 0) + (b ?? 0)
  return { costUsd: add(total.costUsd, usage?.costUsd), inputTokens: add(total.inputTokens, usage?.inputTokens), outputTokens: add(total.outputTokens, usage?.outputTokens) }
}

function budgetError(state: WorkflowState, currentElapsedMs = 0, completed = false): string | undefined {
  if (state.budget.maxCostUsd !== undefined && (completed ? state.usage.knownCostUsd > state.budget.maxCostUsd : state.usage.knownCostUsd >= state.budget.maxCostUsd)) return 'Workflow cost budget exhausted'
  if (state.budget.maxTokens !== undefined && (completed ? state.usage.knownTokens > state.budget.maxTokens : state.usage.knownTokens >= state.budget.maxTokens)) return 'Workflow token budget exhausted'
  if (state.budget.maxDurationMs !== undefined && state.usage.durationMs + currentElapsedMs >= state.budget.maxDurationMs) return 'Workflow duration budget exhausted'
  return undefined
}

function initialState<S extends Record<string, unknown>>(options: RunWorkflowOptions<S>, workflowFingerprint: string, inputFingerprint: string): WorkflowState {
  const now = new Date().toISOString()
  return {
    schemaVersion: 2, runId: options.runId, traceId: randomUUID(),
    workflowId: options.workflow.id, workflowVersion: options.workflow.version,
    workflowFingerprint, inputFingerprint, status: 'running', createdAt: now, updatedAt: now,
    nextStep: options.workflow.entry, nextAttempt: 1, transitions: 0, executionCount: 0,
    steps: Object.fromEntries(Object.entries(options.workflow.nodes).map(([id, node]) => [id, { id, status: 'pending', effect: node.effect ?? 'read', visits: 0, attempt: 0 }])),
    history: [], events: [], budget: definedBudget(options.budget ?? {}),
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, knownCostUsd: 0, knownTokens: 0, durationMs: 0 },
  }
}

/** The interrupt a step raised earlier, as the host ledger recorded it. */
function pendingRequest(state: WorkflowState, stepId: string): InterruptRequest | undefined {
  if (state.pendingApproval?.stepId === stepId) return { kind: 'approval', reason: state.pendingApproval.reason ?? 'Approval required' }
  if (state.pendingQuestion?.stepId === stepId) return { kind: 'question', question: state.pendingQuestion.question }
  return undefined
}

function resetRecord(state: WorkflowState, id: string): void {
  const record = state.steps[id]!
  record.status = 'pending'
  delete record.output
  delete record.update
  delete record.next
  delete record.error
  delete record.completedAt
}

/** JSON-only outputs keep the checkpoint portable; a lossy value fails the attempt instead of corrupting the ledger. */
function jsonOrError(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined
  try { fingerprint(value); return undefined } catch (error) { return `Invalid ${what}: ${error instanceof Error ? error.message : String(error)}` }
}

/**
 * Execute a LangGraph state graph with a durable host ledger at every effect
 * boundary. LangGraph owns traversal, state reducers, checkpoints, interrupts
 * and time travel; the ledger owns receipts, usage, budgets, leases and
 * interrupted-write recovery, and it is authoritative for which node runs
 * next. Both are written through one atomic envelope, so they cannot disagree
 * after a crash. Cancellation is cooperative; node callbacks must settle only
 * after their owned subprocesses/tools have stopped.
 */
export async function runWorkflow<S extends Record<string, unknown>>(options: RunWorkflowOptions<S>): Promise<WorkflowState> {
  const definitionFingerprint = validateWorkflow(options.workflow)
  const inputFingerprint = fingerprint(options.input)
  const input = clone(options.input)
  validateBudget(options.budget ?? {})
  const ids = Object.keys(options.workflow.nodes)
  for (const id of [...options.approve ?? [], ...options.recoverInterrupted ?? [], ...options.invalidate ?? []]) {
    if (!ids.includes(id)) throw new WorkflowError('INVALID_WORKFLOW', `Unknown recovery/approval/invalidation step ${id}`)
  }
  if (options.answer !== undefined && (typeof options.answer !== 'string' || !options.answer.trim() || options.answer.length > ANSWER_LIMIT)) {
    throw new WorkflowError('INVALID_WORKFLOW', 'An answer must be a nonempty string of at most 20000 characters')
  }
  const release = await acquireWorkflowLease(options.directory, options.runId)
  let timeout: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  let timeoutReached = false
  const abort = (): void => { controller.abort(options.signal?.reason) }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    const envelope = await readWorkflowEnvelope(options.directory, options.runId)
    const existing = envelope?.state ?? null
    if (existing && !options.resume) throw new WorkflowError('ALREADY_EXISTS', `Workflow ${options.runId} already exists; resume explicitly`)
    if (!existing && options.resume) throw new WorkflowError('NOT_FOUND', `Workflow ${options.runId} does not exist`)
    if (existing && (existing.workflowFingerprint !== definitionFingerprint || existing.inputFingerprint !== inputFingerprint)) {
      throw new WorkflowError('INCOMPATIBLE_RESUME', 'Workflow definition/version or input differs from the saved run')
    }
    const state = existing ?? initialState(options, definitionFingerprint, inputFingerprint)
    let graphStore: SerializedGraphStore | undefined = envelope?.graph
    let elapsedMark = performance.now()
    // Ledger receipts and LangGraph checkpoints share one file; writes are
    // queued so two envelopes never race for the same rename.
    let persistQueue: Promise<void> = Promise.resolve()
    const persist = (): Promise<void> => {
      const next = persistQueue.catch(() => undefined).then(async () => {
        const elapsed = performance.now()
        state.usage.durationMs += Math.max(0, elapsed - elapsedMark)
        elapsedMark = elapsed
        state.updatedAt = new Date().toISOString()
        await writeWorkflowEnvelope(options.directory, { state, ...(graphStore ? { graph: graphStore } : {}) })
      })
      persistQueue = next
      return next
    }
    const commit = async (...events: EventInput[]): Promise<void> => {
      const now = new Date().toISOString()
      const committed = events.map(event => {
        const sequence = state.events.length + 1
        const entry: WorkflowEvent = { ...event, id: `${state.runId}:${sequence}`, sequence, runId: state.runId, traceId: state.traceId, timestamp: now }
        state.events.push(entry)
        return entry
      })
      await persist()
      for (const event of committed) {
        try { await options.onEvent?.(clone(event)) } catch { /* Observers cannot invalidate a committed effect. */ }
      }
    }
    const span = async (attempt: StepAttemptRecord): Promise<void> => {
      if (!options.onSpan || !attempt.completedAt) return
      const record: WorkflowSpan = {
        traceId: state.traceId, spanId: attempt.id, name: `${state.workflowId}.${attempt.stepId}`, stepId: attempt.stepId,
        attempt: attempt.attempt, visit: attempt.visit, startedAt: attempt.startedAt, endedAt: attempt.completedAt, status: attempt.status,
        ...(attempt.usage ? { usage: attempt.usage } : {}), ...(attempt.error ? { error: attempt.error } : {}),
      }
      try { await options.onSpan(clone(record)) } catch { /* Tracing cannot replay a committed effect. */ }
    }
    const finish = async (status: Exclude<WorkflowStatus, 'running'>, message?: string): Promise<void> => {
      state.status = status
      if (message) state.error = message
      else delete state.error
      await commit({ type: `workflow_${status}`, ...(message ? { message } : {}) })
    }
    const stopped = (): 'blocked' | 'cancelled' => timeoutReached ? 'blocked' : 'cancelled'
    const stoppedReason = (): string => timeoutReached ? 'Workflow duration budget exhausted' : 'Workflow cancelled'
    if (!existing) await commit({ type: 'workflow_started' })

    // A write interrupted by process death remains ambiguous even if the caller
    // also asks to invalidate it. Only an explicit recovery decision clears it.
    const interrupted = state.nextStep ? state.steps[state.nextStep] : undefined
    if (existing && interrupted && (interrupted.status === 'running' || interrupted.status === 'interrupted')) {
      if (interrupted.status === 'running') {
        interrupted.status = 'interrupted'
        // The crashed callback may have consumed unreported provider usage.
        accountUsage(state)
        const attempt = state.history.find(item => item.id === interrupted.attemptId)
        if (attempt) { attempt.status = 'interrupted'; attempt.error = 'Process ended before the step receipt was committed' }
        await commit({ type: 'step_interrupted', stepId: interrupted.id, attemptId: interrupted.attemptId, spanId: interrupted.attemptId })
      }
      if (interrupted.effect === 'write' && !options.recoverInterrupted?.includes(interrupted.id)) {
        const message = `Interrupted write step ${interrupted.id} requires explicit recovery`
        if (state.status !== 'blocked' || state.error !== message) await finish('blocked', message)
        return clone(state)
      }
    }

    const invalid = new Set(options.invalidate ?? [])
    if (existing && options.validateCompleted) {
      for (const id of ids) {
        const record = state.steps[id]!
        if (record.status === 'succeeded' && !await options.validateCompleted(id, clone(record), clone(state))) invalid.add(id)
      }
    }
    let forkTarget: string | undefined
    if (invalid.size) {
      const first = Math.min(...Array.from(invalid, id => ids.indexOf(id)))
      for (const id of ids.slice(first)) resetRecord(state, id)
      forkTarget = ids[first]!
      state.nextStep = forkTarget
      state.nextAttempt = 1
      state.status = 'running'
      delete state.error
      delete state.pendingApproval
      delete state.pendingQuestion
      await commit({ type: 'workflow_invalidated', stepId: forkTarget, message: 'Completed evidence was invalidated' })
    }

    // A pending interrupt is answered by the host or the run stays paused.
    let resumeValue: InterruptResume | undefined
    if (!forkTarget) {
      if (state.pendingApproval) {
        const granted = state.pendingApproval.grantedAt !== undefined || options.approve?.includes(state.pendingApproval.stepId) === true
        if (!granted) {
          if (state.status !== 'paused') await finish('paused', state.pendingApproval.reason)
          return clone(state)
        }
        if (!state.pendingApproval.grantedAt) state.pendingApproval.grantedAt = new Date().toISOString()
        resumeValue = { approved: true }
      } else if (state.pendingQuestion) {
        const answer = state.pendingQuestion.answer ?? options.answer
        if (answer === undefined) {
          if (state.status !== 'paused') await finish('paused', state.pendingQuestion.question)
          return clone(state)
        }
        if (state.pendingQuestion.answer === undefined) { state.pendingQuestion.answer = answer; state.pendingQuestion.answeredAt = new Date().toISOString() }
        resumeValue = { answer }
      }
    }
    if (state.status === 'succeeded' && !forkTarget) return clone(state)
    if (options.budget) state.budget = { ...state.budget, ...definedBudget(options.budget) }
    if (existing) {
      state.status = 'running'
      delete state.error
      // Failed visits begin a fresh bounded attempt series when explicitly resumed.
      if (state.nextStep && ['failed', 'blocked'].includes(state.steps[state.nextStep]?.status ?? '')) state.nextAttempt = 1
      // maxTransitions bounds one invocation. An explicit resume is a human
      // decision to continue, so it starts a fresh transition budget; visits and
      // history keep the complete record.
      state.transitions = 0
      await commit({ type: 'workflow_resumed' })
    }
    const remaining = state.budget.maxDurationMs === undefined ? undefined : state.budget.maxDurationMs - state.usage.durationMs
    if (remaining !== undefined) {
      if (remaining <= 0) { timeoutReached = true; controller.abort(new Error('Workflow duration budget exhausted')) }
      else timeout = setTimeout(() => { timeoutReached = true; controller.abort(new Error('Workflow duration budget exhausted')) }, remaining)
    }

    const maxTransitions = options.workflow.maxTransitions ?? 100
    const wrap = (id: string) => async (graphState: S): Promise<Command> => {
      const node = options.workflow.nodes[id]!
      const record = state.steps[id]!
      const exhausted = budgetError(state, performance.now() - elapsedMark)
      if (controller.signal.aborted || exhausted) {
        const status = exhausted ? 'blocked' : stopped()
        await finish(status, exhausted ?? stoppedReason())
        throw new StepTerminated(status)
      }
      if (state.nextAttempt === 1 && state.transitions >= maxTransitions) {
        await finish('blocked', 'Workflow transition limit exhausted')
        throw new StepTerminated('blocked')
      }
      // A lost LangGraph checkpoint re-runs a node whose receipt the ledger already
      // committed: replay its recorded result instead of repeating the effect.
      if (record.status === 'succeeded' && record.next !== undefined && record.next !== id && state.nextStep === record.next) {
        return new Command({ update: (record.update ?? {}) as Partial<S>, goto: record.next ?? END })
      }
      if (state.nextAttempt === 1 && record.status !== 'paused') { state.transitions++; record.visits++ }
      // A granted interrupt stays in the ledger until this node succeeds, so a
      // crash during the resumed attempt never asks the host twice.
      const pending = resumeValue ? pendingRequest(state, id) : undefined
      let attempt = state.nextAttempt
      const maxAttempts = node.maxAttempts ?? 1
      for (;;) {
        const attemptId = randomUUID()
        const startedAt = new Date().toISOString()
        record.status = 'running'
        record.attempt = attempt
        record.attemptId = attemptId
        record.startedAt = startedAt
        delete record.error
        state.nextStep = id
        state.nextAttempt = attempt
        state.executionCount++
        const history: StepAttemptRecord = { id: attemptId, stepId: id, attempt, visit: record.visits, status: 'running', startedAt }
        state.history.push(history)
        await commit({ type: 'step_started', stepId: id, attemptId, spanId: attemptId })
        let reported: StepUsage | undefined
        let raised: InterruptRequest | undefined
        const context: WorkflowStepContext = {
          runId: state.runId, stepId: id, attemptId, attempt, input, signal: controller.signal, checkpoint: clone(state), ...(pending ? { pending } : {}),
          interrupt: <R extends InterruptResume>(request: InterruptRequest): R => {
            // The ledger is authoritative for a granted interrupt: a resumed node
            // gets its answer without depending on LangGraph's replay order.
            if (pending && resumeValue && pending.kind === request.kind) return resumeValue as R
            raised = request
            return interrupt(request) as R
          },
          reportUsage: usage => { validateUsage(usage); accountUsage(state, usage); reported = addUsage(reported ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 }, usage) },
          remainingBudget: () => ({
            ...(state.budget.maxTokens === undefined ? {} : { maxTokens: Math.max(0, state.budget.maxTokens - state.usage.knownTokens) }),
            ...(state.budget.maxCostUsd === undefined ? {} : { maxCostUsd: Math.max(0, state.budget.maxCostUsd - state.usage.knownCostUsd) }),
          }),
        }
        let result: NodeResult<S>
        try {
          result = await node.run(graphState, context)
        } catch (error) {
          if (isGraphInterrupt(error)) {
            const request = raised ?? (error.interrupts[0]?.value as InterruptRequest | undefined)
            const message = request?.kind === 'question' ? request.question : request?.kind === 'approval' ? request.reason : 'Workflow paused'
            const now = new Date().toISOString()
            record.status = 'paused'
            record.completedAt = now
            history.status = 'paused'
            history.completedAt = now
            if (reported) history.usage = reported
            if (request?.kind === 'question') { delete state.pendingApproval; state.pendingQuestion = { stepId: id, requestedAt: now, question: request.question } }
            else { delete state.pendingQuestion; state.pendingApproval = { stepId: id, requestedAt: now, ...(request?.kind === 'approval' ? { reason: request.reason } : {}) } }
            await commit({ type: 'step_paused', stepId: id, attemptId, spanId: attemptId, ...(reported ? { usage: reported } : {}), message })
            await span(history)
            await finish('paused', message)
            throw error
          }
          result = { status: 'failed', error: error instanceof Error ? error.message : String(error), retryable: false }
        }
        // Usage: explicit result usage adds to what the node reported; a node that
        // reported nothing has unknown usage, never a fabricated zero.
        try {
          validateUsage(result.usage)
          if (result.usage) { accountUsage(state, result.usage); reported = addUsage(reported ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 }, result.usage) }
          else if (!reported) accountUsage(state)
        } catch (error) {
          result = { status: 'failed', error: error instanceof Error ? error.message : String(error), retryable: false }
        }
        const invalidJson = jsonOrError(result.output, 'step output') ?? jsonOrError(result.update, 'state update')
        if (invalidJson) result = { status: 'failed', error: invalidJson, retryable: false }
        const now = new Date().toISOString()
        history.completedAt = now
        if (reported) history.usage = reported
        if (result.output !== undefined) history.output = result.output
        if (result.error) history.error = result.error
        record.completedAt = now
        if (controller.signal.aborted) {
          if ((node.effect ?? 'read') === 'write') {
            // A write that settled after cancellation is ambiguous evidence; keep it explicit.
            record.status = 'interrupted'
            record.error = result.status === 'succeeded' ? 'Write interrupted by cancellation' : result.error ?? 'Write interrupted by cancellation'
            history.status = 'interrupted'
            history.error = record.error
            await commit({ type: 'step_interrupted', stepId: id, attemptId, spanId: attemptId, ...(reported ? { usage: reported } : {}), message: record.error })
            await span(history)
            await finish('blocked', `Interrupted write step ${id} requires explicit recovery`)
            throw new StepTerminated('blocked')
          }
          history.status = result.status === 'succeeded' ? 'succeeded' : 'failed'
          record.status = history.status
          if (result.error) record.error = result.error
          await commit({ type: history.status === 'succeeded' ? 'step_succeeded' : 'step_failed', stepId: id, attemptId, spanId: attemptId, ...(reported ? { usage: reported } : {}), ...(result.error ? { message: result.error } : {}) })
          await span(history)
          await finish(stopped(), stoppedReason())
          throw new StepTerminated(stopped())
        }
        if (result.status === 'failed' && result.retryable && attempt < maxAttempts && ((node.effect ?? 'read') === 'read' || node.retrySafe)) {
          history.status = 'failed'
          record.status = 'failed'
          record.error = result.error
          await commit({ type: 'step_failed', stepId: id, attemptId, spanId: attemptId, ...(reported ? { usage: reported } : {}), message: result.error })
          await span(history)
          attempt += 1
          state.nextAttempt = attempt
          continue
        }
        history.status = result.status
        record.status = result.status
        if (result.output !== undefined) record.output = result.output
        else delete record.output
        if (result.error) record.error = result.error
        if (result.status === 'succeeded') {
          const next = result.next === undefined ? (node.ends[0] ?? null) : result.next
          if (next !== null && !node.ends.includes(next)) {
            history.status = 'failed'
            record.status = 'failed'
            record.error = `Node ${id} routed to an undeclared successor ${next}`
            history.error = record.error
            await commit({ type: 'step_failed', stepId: id, attemptId, spanId: attemptId, ...(reported ? { usage: reported } : {}), message: record.error })
            await span(history)
            await finish('failed', record.error)
            throw new StepTerminated('failed')
          }
          record.next = next
          record.update = (result.update ?? {}) as JsonValue
          if (pending) { delete state.pendingApproval; delete state.pendingQuestion }
          state.nextStep = next
          state.nextAttempt = 1
          await commit({ type: 'step_succeeded', stepId: id, attemptId, spanId: attemptId, ...(reported ? { usage: reported } : {}) })
          await span(history)
          return new Command({ update: (result.update ?? {}) as Partial<S>, goto: next ?? END })
        }
        await commit({ type: result.status === 'blocked' ? 'step_blocked' : 'step_failed', stepId: id, attemptId, spanId: attemptId, ...(reported ? { usage: reported } : {}), message: result.error })
        await span(history)
        await finish(result.status, result.error)
        throw new StepTerminated(result.status)
      }
    }

    const saver = new FileCheckpointSaver({ load: () => graphStore, save: async store => { graphStore = store; await persist() } })
    // Node names are only known at run time, so the builder is typed with plain strings.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the schema is host-defined; state typing lives in WorkflowNode<S>.
    const builder = new StateGraph(options.workflow.schema) as unknown as StateGraph<any, any, any, string>
    for (const id of ids) builder.addNode(id, wrap(id), { ends: [...options.workflow.nodes[id]!.ends, END] })
    builder.addEdge(START, options.workflow.entry)
    const graph = builder.compile({ checkpointer: saver })
    const thread: RunnableConfig = { configurable: { thread_id: state.runId } }
    let startConfig: RunnableConfig = thread
    let graphInput: Record<string, never> | Command | null = existing ? null : {}
    if (existing && !forkTarget && state.nextStep !== null) {
      // The ledger names the next node. When LangGraph's own position disagrees
      // (its checkpoint was written before the ledger receipt, or the receipt was
      // reconciled by the host), traversal follows the ledger.
      const snapshot = await graph.getState(thread)
      if (!snapshot.next.includes(state.nextStep)) forkTarget = state.nextStep
      else if (resumeValue && snapshot.tasks.some(task => task.interrupts.length > 0)) graphInput = new Command({ resume: resumeValue })
    }
    if (forkTarget) {
      // Time travel: continue from the checkpoint taken right before the target
      // node last ran, so its predecessors' state is exactly what it saw then and
      // every later checkpoint becomes a discarded branch.
      let fork: RunnableConfig | undefined
      for await (const snapshot of graph.getStateHistory(thread)) {
        if (snapshot.next.includes(forkTarget)) { fork = snapshot.config; break }
      }
      if (fork) { startConfig = fork; graphInput = null }
      else if (forkTarget === options.workflow.entry) {
        await saver.deleteThread(state.runId)
        graphInput = {}
      } else {
        await finish('failed', `No checkpoint precedes step ${forkTarget}; start a new run`)
        return clone(state)
      }
    }
    if (state.nextStep === null && existing && !forkTarget) graphInput = null
    const maxAttempts = Math.max(...ids.map(id => options.workflow.nodes[id]!.maxAttempts ?? 1))
    let output: unknown
    try {
      // Persist each graph checkpoint before starting the next node, including crash recovery.
      output = state.nextStep === null ? {} : await graph.invoke(graphInput, { ...startConfig, durability: 'sync', recursionLimit: maxTransitions * maxAttempts + 2 })
    } catch (error) {
      if (error instanceof StepTerminated || isGraphInterrupt(error)) return clone(state)
      if (state.status === 'running') await finish(controller.signal.aborted ? stopped() : 'failed', controller.signal.aborted ? stoppedReason() : error instanceof Error ? error.message : String(error))
      if (controller.signal.aborted) return clone(state)
      throw error
    }
    if (isInterrupted(output)) return clone(state)
    // A process may die after the final step receipt but before workflow_succeeded.
    if (state.status === 'running') {
      const exhausted = budgetError(state, performance.now() - elapsedMark, true)
      if (exhausted) await finish('blocked', exhausted)
      else if (controller.signal.aborted) await finish(stopped(), stoppedReason())
      else if (state.nextStep === null) await finish('succeeded')
      else await finish('failed', 'Workflow ended without a terminal step receipt')
    }
    return clone(state)
  } finally {
    if (timeout) clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    await release()
  }
}
