import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { performance } from 'node:perf_hooks'
import { acquireWorkflowLease, fingerprint, readWorkflowState, writeWorkflowState } from './durable-store.js'
import type {
  JsonValue, RunWorkflowOptions, StepResult, StepUsage, WorkflowBudget,
  WorkflowDefinition, WorkflowEvent, WorkflowState, WorkflowStatus,
} from './workflow-types.js'

export * from './workflow-types.js'
export { readWorkflowState, WorkflowStoreError } from './durable-store.js'

export class WorkflowError extends Error {
  constructor(public readonly code: 'INVALID_WORKFLOW' | 'ALREADY_EXISTS' | 'NOT_FOUND' | 'INCOMPATIBLE_RESUME', message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

type EventInput = Omit<WorkflowEvent, 'id' | 'sequence' | 'runId' | 'timestamp'>
const GraphState = Annotation.Root({ next: Annotation<string | null>() })
const clone = <T>(value: T): T => structuredClone(value)

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

function validateWorkflow(workflow: WorkflowDefinition): string {
  if (typeof workflow.id !== 'string' || !workflow.id || typeof workflow.version !== 'string' || !workflow.version || !workflow.steps.length) {
    throw new WorkflowError('INVALID_WORKFLOW', 'Workflow requires an id, version and at least one step')
  }
  const ids = new Set<string>()
  for (const step of workflow.steps) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(step.id) || step.id === 'next' || ids.has(step.id) || typeof step.execute !== 'function' ||
        (step.effect !== undefined && step.effect !== 'read' && step.effect !== 'write') ||
        !Number.isInteger(step.maxAttempts ?? 1) || (step.maxAttempts ?? 1) < 1 || (step.maxAttempts ?? 1) > 100) {
      throw new WorkflowError('INVALID_WORKFLOW', `Invalid or duplicate workflow step ${step.id}`)
    }
    ids.add(step.id)
  }
  const maxTransitions = workflow.maxTransitions ?? 100
  if (!Number.isInteger(maxTransitions) || maxTransitions < 1 || maxTransitions > 10_000) {
    throw new WorkflowError('INVALID_WORKFLOW', 'maxTransitions must be an integer from 1 to 10000')
  }
  return fingerprint({
    id: workflow.id, version: workflow.version, maxTransitions,
    steps: workflow.steps.map(step => ({ id: step.id, effect: step.effect ?? 'read', maxAttempts: step.maxAttempts ?? 1, retrySafe: step.retrySafe ?? false })),
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

function budgetError(state: WorkflowState, currentElapsedMs = 0, completed = false): string | undefined {
  if (state.budget.maxCostUsd !== undefined && (completed ? state.usage.knownCostUsd > state.budget.maxCostUsd : state.usage.knownCostUsd >= state.budget.maxCostUsd)) return 'Workflow cost budget exhausted'
  if (state.budget.maxTokens !== undefined && (completed ? state.usage.knownTokens > state.budget.maxTokens : state.usage.knownTokens >= state.budget.maxTokens)) return 'Workflow token budget exhausted'
  if (state.budget.maxDurationMs !== undefined && state.usage.durationMs + currentElapsedMs >= state.budget.maxDurationMs) return 'Workflow duration budget exhausted'
  return undefined
}

function initialState(options: RunWorkflowOptions, workflowFingerprint: string, inputFingerprint: string): WorkflowState {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1, runId: options.runId,
    workflowId: options.workflow.id, workflowVersion: options.workflow.version,
    workflowFingerprint, inputFingerprint, status: 'running', createdAt: now, updatedAt: now,
    nextStep: options.workflow.steps[0]!.id, nextAttempt: 1, transitions: 0, executionCount: 0,
    steps: Object.fromEntries(options.workflow.steps.map(step => [step.id, { id: step.id, status: 'pending', effect: step.effect ?? 'read', visits: 0, attempt: 0 }])),
    history: [], events: [], budget: definedBudget(options.budget ?? {}),
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, knownCostUsd: 0, knownTokens: 0, durationMs: 0 },
  }
}

/**
 * Execute an embedded LangGraph with a durable checkpoint at every effect boundary.
 * The checkpoint is authoritative: traversal restarts at its committed nextStep,
 * never at an in-memory LangGraph continuation. Cancellation is cooperative; step
 * callbacks must settle only after their owned subprocesses/tools have stopped.
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowState> {
  const definitionFingerprint = validateWorkflow(options.workflow)
  const inputFingerprint = fingerprint(options.input)
  const input = clone(options.input)
  validateBudget(options.budget ?? {})
  const ids = options.workflow.steps.map(step => step.id)
  for (const id of [...options.approve ?? [], ...options.recoverInterrupted ?? [], ...options.invalidate ?? []]) {
    if (!ids.includes(id)) throw new WorkflowError('INVALID_WORKFLOW', `Unknown recovery/approval/invalidation step ${id}`)
  }
  const release = await acquireWorkflowLease(options.directory, options.runId)
  let timeout: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  let timeoutReached = false
  const abort = (): void => { controller.abort(options.signal?.reason) }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    const existing = await readWorkflowState(options.directory, options.runId)
    if (existing && !options.resume) throw new WorkflowError('ALREADY_EXISTS', `Workflow ${options.runId} already exists; resume explicitly`)
    if (!existing && options.resume) throw new WorkflowError('NOT_FOUND', `Workflow ${options.runId} does not exist`)
    if (existing && (existing.workflowFingerprint !== definitionFingerprint || existing.inputFingerprint !== inputFingerprint)) {
      throw new WorkflowError('INCOMPATIBLE_RESUME', 'Workflow definition/version or input differs from the saved run')
    }
    const state = existing ?? initialState(options, definitionFingerprint, inputFingerprint)
    let elapsedMark = performance.now()
    const commit = async (...events: EventInput[]): Promise<void> => {
      const now = new Date().toISOString()
      const elapsed = performance.now()
      state.usage.durationMs += Math.max(0, elapsed - elapsedMark)
      elapsedMark = elapsed
      state.updatedAt = now
      const committed = events.map(event => {
        const sequence = state.events.length + 1
        const entry: WorkflowEvent = { ...event, id: `${state.runId}:${sequence}`, sequence, runId: state.runId, timestamp: now }
        state.events.push(entry)
        return entry
      })
      await writeWorkflowState(options.directory, state)
      for (const event of committed) {
        try { await options.onEvent?.(clone(event)) } catch { /* Observers cannot invalidate a committed effect. */ }
      }
    }
    const finish = async (status: Exclude<WorkflowStatus, 'running'>, message?: string): Promise<void> => {
      state.status = status
      if (message) state.error = message
      else delete state.error
      await commit({ type: `workflow_${status}`, ...(message ? { message } : {}) })
    }
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
        await commit({ type: 'step_interrupted', stepId: interrupted.id, attemptId: interrupted.attemptId })
      }
      if (interrupted.effect === 'write' && !options.recoverInterrupted?.includes(interrupted.id)) {
        const message = `Interrupted write step ${interrupted.id} requires explicit recovery`
        if (state.status !== 'blocked' || state.error !== message) await finish('blocked', message)
        return clone(state)
      }
    }

    const invalid = new Set(options.invalidate ?? [])
    if (existing && options.validateCompleted) {
      for (const step of options.workflow.steps) {
        const record = state.steps[step.id]!
        if (record.status === 'succeeded' && !await options.validateCompleted(step, clone(record), clone(state))) invalid.add(step.id)
      }
    }
    if (invalid.size) {
      const first = Math.min(...Array.from(invalid, id => ids.indexOf(id)))
      for (const id of ids.slice(first)) {
        const record = state.steps[id]!
        record.status = 'pending'
        delete record.output
        delete record.error
        delete record.completedAt
      }
      state.nextStep = ids[first]!
      state.nextAttempt = 1
      state.status = 'running'
      delete state.error
      delete state.pendingApproval
      await commit({ type: 'workflow_invalidated', stepId: state.nextStep, message: 'Completed evidence was invalidated' })
    }

    const approved = state.pendingApproval !== undefined && (state.pendingApproval.grantedAt !== undefined || options.approve?.includes(state.pendingApproval.stepId) === true)
    if (approved && state.pendingApproval && !state.pendingApproval.grantedAt) state.pendingApproval.grantedAt = new Date().toISOString()
    if (state.pendingApproval && !approved && invalid.size === 0) {
      if (state.status !== 'paused') await finish('paused', state.pendingApproval.reason)
      return clone(state)
    }
    if (state.status === 'succeeded' && invalid.size === 0) return clone(state)
    if (options.budget) state.budget = { ...state.budget, ...definedBudget(options.budget) }
    if (existing) {
      state.status = 'running'
      delete state.error
      // Failed visits begin a fresh bounded attempt series when explicitly resumed.
      if (state.nextStep && state.steps[state.nextStep]?.status === 'failed') state.nextAttempt = 1
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

    const graph = new StateGraph<typeof GraphState.spec, typeof GraphState.State, typeof GraphState.Update, string>(GraphState)
    for (const [index, step] of options.workflow.steps.entries()) {
      graph.addNode(step.id, async () => {
        const exhausted = budgetError(state, performance.now() - elapsedMark)
        if (controller.signal.aborted || exhausted) {
          await finish(timeoutReached || exhausted ? 'blocked' : 'cancelled', exhausted ?? (timeoutReached ? 'Workflow duration budget exhausted' : 'Workflow cancelled'))
          return { next: null }
        }
        if (state.nextAttempt === 1 && state.transitions >= (options.workflow.maxTransitions ?? 100)) {
          await finish('blocked', 'Workflow transition limit exhausted')
          return { next: null }
        }
        const record = state.steps[step.id]!
        if (state.nextAttempt === 1) { state.transitions++; record.visits++ }
        const attemptId = `${state.runId}:attempt:${++state.executionCount}`
        const startedAt = new Date().toISOString()
        record.status = 'running'
        record.attempt = state.nextAttempt
        record.attemptId = attemptId
        record.startedAt = startedAt
        delete record.completedAt
        delete record.error
        const history: WorkflowState['history'][number] = {
          id: attemptId, stepId: step.id, attempt: state.nextAttempt, visit: record.visits, status: 'running', startedAt,
        }
        state.history.push(history)
        await commit({ type: 'step_started', stepId: step.id, attemptId })
        let result: StepResult
        try {
          controller.signal.throwIfAborted()
          const previousOutputs: Record<string, JsonValue> = Object.fromEntries(Object.entries(state.steps)
            .filter(([, receipt]) => receipt.output !== undefined).map(([id, receipt]) => [id, clone(receipt.output!)]))
          result = await step.execute({
            runId: state.runId, stepId: step.id, attemptId, attempt: state.nextAttempt,
            input: clone(input), signal: controller.signal, previousOutputs, checkpoint: clone(state),
            approved: approved && state.pendingApproval?.stepId === step.id,
          })
          if (!result || !['succeeded', 'failed', 'blocked', 'paused'].includes(result.status)) throw new TypeError('Step returned an invalid status')
          if (result.error !== undefined && typeof result.error !== 'string') throw new TypeError('Step error must be a string')
          if (result.retryable !== undefined && typeof result.retryable !== 'boolean') throw new TypeError('Step retryable must be a boolean')
          if (result.usage !== undefined && (result.usage === null || typeof result.usage !== 'object' || Array.isArray(result.usage))) throw new TypeError('Step usage must be an object')
          if (result.output !== undefined) fingerprint(result.output)
          if (result.next !== undefined && result.next !== null && !ids.includes(result.next)) throw new TypeError(`Unknown next step ${result.next}`)
          validateUsage(result.usage)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (controller.signal.aborted && record.effect === 'write') {
            record.status = 'interrupted'
            record.error = message
            history.status = 'interrupted'
            history.error = message
            accountUsage(state)
            await commit({ type: 'step_interrupted', stepId: step.id, attemptId, message })
            await finish('blocked', `Interrupted write step ${step.id} requires explicit recovery`)
            return { next: null }
          }
          result = { status: 'failed', error: message }
        }
        // Executors sometimes report cancellation as a structured failure instead
        // of throwing. A failed write under cancellation is equally ambiguous.
        if (controller.signal.aborted && record.effect === 'write' && result.status !== 'succeeded') {
          record.status = 'interrupted'
          record.error = result.error ?? 'Write interrupted by cancellation'
          history.status = 'interrupted'
          history.error = record.error
          if (result.usage) history.usage = clone(result.usage)
          accountUsage(state, result.usage)
          await commit({ type: 'step_interrupted', stepId: step.id, attemptId, message: record.error, ...(result.usage ? { usage: clone(result.usage) } : {}) })
          await finish('blocked', `Interrupted write step ${step.id} requires explicit recovery`)
          return { next: null }
        }
        record.status = result.status
        record.completedAt = new Date().toISOString()
        history.status = result.status
        history.completedAt = record.completedAt
        if (result.output !== undefined) { record.output = clone(result.output); history.output = clone(result.output) }
        if (result.error !== undefined) { record.error = result.error; history.error = result.error }
        if (result.usage) history.usage = clone(result.usage)
        accountUsage(state, result.usage)
        if (state.pendingApproval?.stepId === step.id) delete state.pendingApproval

        let next: string | null = null
        if (result.status === 'succeeded') {
          next = result.next === undefined ? (ids[index + 1] ?? null) : result.next
          state.nextStep = next
          state.nextAttempt = 1
        } else if (result.status === 'failed' && result.retryable && state.nextAttempt < (step.maxAttempts ?? 1) && (record.effect === 'read' || step.retrySafe)) {
          next = step.id
          state.nextAttempt++
        } else if (result.status === 'paused') {
          state.pendingApproval = { stepId: step.id, requestedAt: record.completedAt, ...(result.error ? { reason: result.error } : {}) }
        }
        // Advancing nextStep, usage and the effect receipt is one durable transaction.
        await commit({ type: `step_${result.status}`, stepId: step.id, attemptId, ...(result.usage ? { usage: clone(result.usage) } : {}), ...(result.error ? { message: result.error } : {}) })
        if (next !== null) return { next }
        const finalBudgetError = budgetError(state, performance.now() - elapsedMark, true)
        if (result.status === 'succeeded' && (timeoutReached || finalBudgetError)) await finish('blocked', finalBudgetError ?? 'Workflow duration budget exhausted')
        else if (controller.signal.aborted && !timeoutReached) await finish('cancelled', 'Workflow cancelled')
        else if (result.status === 'succeeded') await finish('succeeded')
        else await finish(timeoutReached ? 'blocked' : result.status, timeoutReached ? 'Workflow duration budget exhausted' : result.error)
        return { next: null }
      })
    }
    const route = (value: typeof GraphState.State): string => value.next ?? END
    graph.addConditionalEdges(START, route, [...ids, END])
    for (const id of ids) graph.addConditionalEdges(id, route, [...ids, END])
    const compiled = graph.compile()
    // Per-visit retries do not consume maxTransitions. This graph safety ceiling
    // also bounds a malformed host independently from the persisted visit counter.
    const maxAttempts = Math.max(...options.workflow.steps.map(step => step.maxAttempts ?? 1))
    await compiled.invoke({ next: state.nextStep }, { recursionLimit: (options.workflow.maxTransitions ?? 100) * maxAttempts + 2 })
    // A process may die after the final step receipt but before workflow_succeeded.
    if (state.status === 'running' && state.nextStep === null) {
      const exhausted = budgetError(state, performance.now() - elapsedMark, true)
      if (exhausted) await finish('blocked', exhausted)
      else if (controller.signal.aborted) await finish(timeoutReached ? 'blocked' : 'cancelled', timeoutReached ? 'Workflow duration budget exhausted' : 'Workflow cancelled')
      else await finish('succeeded')
    }
    return clone(state)
  } finally {
    if (timeout) clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    await release()
  }
}
