import type { AnnotationRoot } from '@langchain/langgraph'
import type { ProviderInvocation } from './efficiency-types.js'

/** JSON-only contracts keep checkpoints portable and independent of executors. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type StepStatus = 'succeeded' | 'failed' | 'blocked' | 'paused'
export type WorkflowStatus = 'running' | StepStatus | 'cancelled'

export interface StepUsage {
  costUsd?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
}

export interface WorkflowBudget {
  maxCostUsd?: number
  maxTokens?: number
  maxDurationMs?: number
}

/** A node asks the host to pause: the run resumes only with the matching answer. */
export type InterruptRequest =
  | { kind: 'approval'; reason: string }
  | { kind: 'question'; question: string }
export type InterruptResume = { approved: true } | { answer: string }

export interface NodeResult<S extends Record<string, unknown>> {
  /** Nodes pause through `context.interrupt`, never through a result. */
  status: Exclude<StepStatus, 'paused'>
  /** Graph state update, merged through the schema's reducers. */
  update?: Partial<S>
  /** Ledger output: kept in the checkpoint receipt and exposed by `runtime status`. */
  output?: JsonValue
  error?: string
  /** Omit for the node's first declared successor; null completes the workflow. */
  next?: string | null
  /** Usage not already reported through `context.reportUsage`. */
  usage?: StepUsage
  retryable?: boolean
}

export interface WorkflowStepContext {
  runId: string
  stepId: string
  /** Stable identifier for this invocation, suitable for external idempotency keys. */
  attemptId: string
  attempt: number
  input: JsonValue
  signal: AbortSignal
  /** A detached snapshot; modifying it cannot modify the persisted run. */
  checkpoint: WorkflowState
  /** The interrupt this node raised earlier, when the host now resumes it with an answer or approval. */
  pending?: InterruptRequest
  /**
   * Pause the workflow until the host resumes it. Throws on the first call; on
   * a resumed node it returns the host's answer immediately, so collect it
   * before repeating any work.
   */
  interrupt<R extends InterruptResume = InterruptResume>(request: InterruptRequest): R
  /** Account provider spend as soon as it is known; a later pause or failure keeps it. */
  reportUsage(usage: StepUsage): void
  /** Persist a completed provider call with its already-reported usage. Optional for custom hosts. */
  reportInvocation?(invocation: ProviderInvocation): Promise<void>
  /** Budget left for the next provider call, after everything reported so far. */
  remainingBudget(): { maxTokens?: number; maxCostUsd?: number }
}

export interface WorkflowNode<S extends Record<string, unknown>> {
  effect?: 'read' | 'write'
  maxAttempts?: number
  /** Explicitly opt a write step into retries after a reported retryable failure. */
  retrySafe?: boolean
  /** Declared successors; the first is the default when a result omits `next`. */
  ends: string[]
  run(state: S, context: WorkflowStepContext): Promise<NodeResult<S>>
}

export interface WorkflowDefinition<S extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  version: string
  /** LangGraph state schema; every field must be plain JSON. Any `Annotation.Root` is accepted. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AnnotationRoot is invariant in its definition; hosts pass their own concrete schema.
  schema: AnnotationRoot<any>
  entry: string
  /** Declaration order defines "downstream" for invalidation. */
  nodes: Record<string, WorkflowNode<S>>
  /** Maximum visits across conditional loops, independent of per-visit retries. */
  maxTransitions?: number
}

export interface StepRecord {
  id: string
  status: 'pending' | 'running' | 'interrupted' | StepStatus
  effect: 'read' | 'write'
  visits: number
  attempt: number
  attemptId?: string
  output?: JsonValue
  /** The graph state update of the last successful visit, replayed when a lost checkpoint re-runs the node. */
  update?: JsonValue
  /** The successor chosen by the last successful visit; null completed the workflow. */
  next?: string | null
  error?: string
  startedAt?: string
  completedAt?: string
}

export interface StepAttemptRecord {
  id: string
  stepId: string
  attempt: number
  visit: number
  status: 'running' | 'interrupted' | StepStatus
  startedAt: string
  completedAt?: string
  output?: JsonValue
  error?: string
  usage?: StepUsage
  invocations?: ProviderInvocation[]
}

export interface WorkflowEvent {
  id: string
  sequence: number
  runId: string
  /** Trace correlation: the run's trace and the attempt span this event belongs to. */
  traceId: string
  spanId?: string
  type: 'workflow_started' | 'workflow_resumed' | 'workflow_invalidated' |
    'workflow_succeeded' | 'workflow_failed' | 'workflow_blocked' |
    'workflow_paused' | 'workflow_cancelled' | 'step_started' |
    'step_succeeded' | 'step_failed' | 'step_blocked' | 'step_paused' | 'step_interrupted'
  timestamp: string
  stepId?: string
  attemptId?: string
  usage?: StepUsage
  message?: string
}

/** One completed step attempt, shaped for tracing back ends (OpenTelemetry or otherwise). */
export interface WorkflowSpan {
  traceId: string
  spanId: string
  name: string
  stepId: string
  attempt: number
  visit: number
  startedAt: string
  endedAt: string
  status: 'running' | 'interrupted' | StepStatus
  usage?: StepUsage
  error?: string
}

export interface WorkflowState {
  schemaVersion: 2
  runId: string
  /** Stable trace identifier for every event and span of this run. */
  traceId: string
  workflowId: string
  workflowVersion: string
  workflowFingerprint: string
  inputFingerprint: string
  status: WorkflowStatus
  createdAt: string
  updatedAt: string
  nextStep: string | null
  nextAttempt: number
  transitions: number
  executionCount: number
  steps: Record<string, StepRecord>
  history: StepAttemptRecord[]
  events: WorkflowEvent[]
  budget: WorkflowBudget
  usage: {
    costUsd: number | null
    inputTokens: number | null
    outputTokens: number | null
    /** Known lower bounds, even when some providers omit usage. */
    knownCostUsd: number
    knownTokens: number
    durationMs: number
  }
  pendingApproval?: { stepId: string; requestedAt: string; grantedAt?: string; reason?: string }
  pendingQuestion?: { stepId: string; requestedAt: string; question: string; answeredAt?: string; answer?: string }
  error?: string
}

export interface RunWorkflowOptions<S extends Record<string, unknown> = Record<string, unknown>> {
  directory: string
  runId: string
  workflow: WorkflowDefinition<S>
  input: JsonValue
  budget?: WorkflowBudget
  signal?: AbortSignal
  resume?: boolean
  approve?: string[]
  /** Answer to the pending question; resumes the node that asked it. */
  answer?: string
  recoverInterrupted?: string[]
  /** Invalidating a step also invalidates all later declared steps. */
  invalidate?: string[]
  validateCompleted?: (stepId: string, record: StepRecord, state: WorkflowState) => Promise<boolean>
  /** Notification is after durable commit. Observer failures never replay effects. */
  onEvent?: (event: WorkflowEvent) => void | Promise<void>
  /** One span per finished step attempt, after durable commit. */
  onSpan?: (span: WorkflowSpan) => void | Promise<void>
}
