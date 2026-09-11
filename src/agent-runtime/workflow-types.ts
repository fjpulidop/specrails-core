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

export interface StepResult {
  status: StepStatus
  output?: JsonValue
  error?: string
  /** Omit for the following declared step; null completes the workflow. */
  next?: string | null
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
  previousOutputs: Record<string, JsonValue>
  /** A detached snapshot; modifying it cannot modify the persisted run. */
  checkpoint: WorkflowState
  /** True only when this invocation consumes an explicit pending approval. */
  approved: boolean
}

export interface WorkflowStep {
  id: string
  effect?: 'read' | 'write'
  maxAttempts?: number
  /** Explicitly opt a write step into retries after a reported retryable failure. */
  retrySafe?: boolean
  execute(context: WorkflowStepContext): Promise<StepResult>
}

export interface WorkflowDefinition {
  id: string
  version: string
  steps: WorkflowStep[]
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
}

export interface WorkflowEvent {
  id: string
  sequence: number
  runId: string
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

export interface WorkflowState {
  schemaVersion: 1
  runId: string
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
  error?: string
}

export interface RunWorkflowOptions {
  directory: string
  runId: string
  workflow: WorkflowDefinition
  input: JsonValue
  budget?: WorkflowBudget
  signal?: AbortSignal
  resume?: boolean
  approve?: string[]
  recoverInterrupted?: string[]
  /** Invalidating a step also invalidates all later declared steps. */
  invalidate?: string[]
  validateCompleted?: (step: WorkflowStep, record: StepRecord, state: WorkflowState) => Promise<boolean>
  /** Notification is after durable commit. Observer failures never replay effects. */
  onEvent?: (event: WorkflowEvent) => void | Promise<void>
}
