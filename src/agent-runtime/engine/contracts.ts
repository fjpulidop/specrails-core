import type { JsonValue, WorkflowBudget } from '../workflow-types.js'

export type { JsonValue, WorkflowBudget }
export type JsonObject = { [key: string]: JsonValue }
export type EngineEffect = 'read' | 'write'
export type EngineStepStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'paused' | 'interrupted'
export type EngineRunStatus = EngineStepStatus | 'cancelled'

/** Stable public LangGraph execution metadata; never parse private namespace keys. */
export interface TaskIdentity {
  checkpointThreadId: string
  checkpointId: string
  taskCheckpointNs: string
  taskId: string
}

export interface ExecutionScope {
  id: string
  nodePathPrefix: string
  branchId?: string
  /** Nested map limits; the run coordinator acquires them only around physical AI work. */
  limits?: Array<{ id: string; concurrency: number }>
}

export interface ExecutionLease {
  runId: string
  owner: string
  epoch: number
  expiresAt: number
}

export interface AttemptFrame {
  runId: string
  nodePath: string
  scope: ExecutionScope
  task: TaskIdentity
  visitId: string
  visit: number
  transition: number
  attemptId: string
  attempt: number
  leaseEpoch: number
}

export interface NodeRetryPolicy {
  maxAttempts: number
  retrySafe?: boolean
  initialIntervalMs?: number
}

export interface NodeAdmission {
  nodePath: string
  kind: string
  effect: EngineEffect
  requiresAI: boolean
  acceptsSteering?: boolean
  scope: ExecutionScope
  task: TaskIdentity
  retry: NodeRetryPolicy
}

export interface HistoryEntry {
  id: string
  transition: number
  attempt: number
  ordinal: number
  nodePath: string
  text: string
  truncated?: boolean
}

/** Aggregate revision comes from the ledger; checkpoints cannot double-count it. */
export interface EngineUsage {
  revision: number
  invocations: number
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  knownCostUsd: number
  knownInputTokens: number
  knownOutputTokens: number
}

export interface CandidateState {
  hash: string
  atTransition: number
  revision: number
  /** Logical scope and exact metadata exclusions travel with a historical fork. */
  scope?: JsonObject
}

export interface VerifiedState {
  receiptId: string
  candidateHash: string
  atTransition: number
  revision: number
}

/** Evidence stays JSON; the verification adapter owns the legacy receipt format. */
export interface ReceiptEvidence {
  id: string
  candidateHash: string
  valid: boolean
  scope: 'full' | 'scoped'
  evidence: JsonValue
}

export interface EngineCompletion {
  ok: boolean
  reasons: string[]
  verified: boolean
}

export interface EngineAnswer {
  id: string
  transition: number
  attempt: number
  ordinal: number
  nodePath: string
  value: JsonValue
}

export interface BranchResult {
  id: string
  transition: number
  attempt: number
  ordinal: number
  index: number
  outcome: string
  output: JsonValue
}

export interface BranchState {
  total: number
  results: BranchResult[]
  visitId?: string
  transition?: number
  done?: number
}

export interface MapPlan {
  frame: AttemptFrame
  items: JsonValue[]
}

export interface ComponentExit {
  outcome: string
  transition: number
  completion: EngineCompletion
  status: 'succeeded' | 'failed' | 'blocked' | 'interrupted'
  error?: { code: string; message: string }
}

export interface CoreDefinitionState {
  $outputs: Record<string, JsonValue>
  $vars: Record<string, JsonValue>
  $history: HistoryEntry[]
  $sessions: Record<string, { sessionId: string; identity: string }>
  $usage: EngineUsage
  $attempts: Record<string, number>
  $consecutiveFailures: { revision: number; count: number }
  $candidate: CandidateState | null
  $verified: VerifiedState | null
  $answers: EngineAnswer[]
  $branches: Record<string, BranchState>
  $maps: Record<string, MapPlan>
  $transitions: number
  $lastOutcome: Record<string, string>
  $item: { index: number; value: JsonValue } | null
  $scope: ExecutionScope
  $exit: ComponentExit | null
  $commit?: TerminalCommit
}

/** Domain pieces propose results; only the execution adapter can settle them. */
export interface PieceResult {
  /** Native child-graph update, committed with its terminal marker; never a public output field. */
  childUpdate?: JsonObject
  outcome: string
  status?: 'succeeded' | 'failed' | 'blocked' | 'interrupted'
  output?: JsonValue
  history?: HistoryEntry[]
  vars?: Record<string, JsonValue>
  session?: { sessionId: string; identity: string }
  answers?: EngineAnswer[]
  branches?: Record<string, BranchState>
  usage?: EngineUsage
  candidate?: CandidateState
  verified?: VerifiedState | null
  receipt?: ReceiptEvidence
  completion?: EngineCompletion
  /** Compiler-owned: a local component completion must never settle the parent run. */
  completesRun?: boolean
  error?: { code: string; message: string }
}

/** This engine-owned channel is persisted with the matching task's pending writes. */
export interface TerminalCommit {
  schemaVersion: 1
  frame: AttemptFrame
  result: PieceResult
  digest: string
}

export interface TransientEngineEvent {
  type: 'agent-event' | 'verification-output' | 'span' | 'runtime-efficiency-event'
  payload: JsonValue
}

export interface HumanInterrupt {
  kind: 'approval' | 'question' | 'gate'
  prompt: string
  nodePath: string
  scopeId: string
  attemptId: string
}

export interface PieceExecutionContext {
  state: CoreDefinitionState
  frame: AttemptFrame
  signal: AbortSignal
  progress(event: TransientEngineEvent): void
  interrupt(request: HumanInterrupt): JsonValue
}

export interface PieceDescriptor {
  kind: string
  paramsSchema: JsonObject
  outcomes: readonly string[]
  effect: EngineEffect | 'derived'
  requiresAI: boolean
  storeAccess?: 'none' | 'read' | 'write'
}

export interface Piece {
  descriptor: PieceDescriptor
  /** Exact labels can depend on sentinel mode, structured role output or component parameters. */
  getOutcomes?(params: JsonObject): readonly string[]
  getEffect?(params: JsonObject, roles: Readonly<Record<string, { access: EngineEffect }>>): EngineEffect
  execute(params: JsonObject, context: PieceExecutionContext): Promise<PieceResult>
}

/** Runtime coordination port; SQL, provider processes and locks stay out of compilation. */
export interface NodeExecutionPort {
  enter(input: NodeAdmission): Promise<AttemptFrame>
  execute(frame: AttemptFrame, effect: EngineEffect, operation: (signal: AbortSignal) => Promise<PieceResult>): Promise<PieceResult>
  terminal(frame: AttemptFrame, result: PieceResult): TerminalCommit
  interrupted(frame: AttemptFrame, error: unknown): Promise<void>
  /** Only an approved retry settles here; final failure stays running until its marker commits. */
  failed(frame: AttemptFrame, error: unknown, options: { retry: boolean }): Promise<{ retryable: boolean }>
  progress(event: TransientEngineEvent): void
}

export interface DurableEngineEvent {
  sequence: number
  runId: string
  type: string
  timestamp: string
  nodePath?: string
  scopeId?: string
  branchId?: string
  visit?: number
  attempt?: number
  attemptId?: string
  payload: JsonValue
}

/** Shared typed failure without leaking SQLite or LangGraph error objects into JSONL. */
export class EngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: JsonValue) {
    super(message)
    this.name = 'EngineError'
  }
}
