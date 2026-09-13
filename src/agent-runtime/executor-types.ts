import type { VerificationCommand } from '../installer/runtime/pipeline-state.js'
import type { CacheTokenUsage } from './efficiency-types.js'

export type AgentRole = 'architect' | 'developer' | 'reviewer'
export type CliProvider = 'claude' | 'codex' | 'gemini' | 'kimi'
export type RuntimeProviderConfig =
  | { id: string; kind: 'cli'; cli: CliProvider }
  | { id: string; kind: 'openai-compatible'; baseUrl: string; apiKeyEnv?: string }
export interface RuntimeAgentConfig {
  provider: string
  model?: string
  maxTurns?: number
  effort?: string
  escalation?: { model: string; effort?: string }
}
export interface EfficiencyPolicy {
  schemaVersion: 1
  contextMode?: 'full' | 'incremental'
  reviewMode?: 'full' | 'incremental'
  planning?: 'full' | 'proportional'
  acceptDeveloperChecks?: boolean
  verification?: { maxConcurrency?: number }
}
export interface ExecutorCapabilities {
  transport: string
  continuation: 'supported' | 'unsupported' | 'unknown'
  effortSupport: 'supported' | 'unsupported' | 'unknown'
  supportedEfforts: string[] | null
  observedModel: boolean
  observedEffort: boolean
}
export type ReviewAspectName = 'type_correctness' | 'pattern_adherence' | 'test_coverage' | 'security' | 'architectural_alignment'
export interface RuntimeConfig {
  schemaVersion: 1
  rolePrompts?: Partial<Record<AgentRole, string>>
  efficiency?: EfficiencyPolicy
  enabled: boolean
  providers: RuntimeProviderConfig[]
  agents: Record<AgentRole, RuntimeAgentConfig>
  limits?: { maxAttempts?: number; maxTokens?: number; maxCostUsd?: number; timeoutMs?: number }
  verification: VerificationCommand[]
  approvalBeforeArchive?: boolean
  /** Review gate thresholds (0–100); unset fields keep Core's defaults. */
  review?: { minScore?: number; aspects?: Partial<Record<ReviewAspectName, number>> }
  /** What to do when the architect still reports low confidence after investigating: ask the requester (default) or proceed on stated assumptions. */
  architect?: { onLowConfidence?: 'ask' | 'proceed' }
}
/** Null means unavailable, including when a CLI never reports billing. */
export interface AgentUsage extends CacheTokenUsage { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
export interface AgentEvent {
  kind: 'text' | 'tool-start' | 'tool-end' | 'usage'
  text?: string
  tool?: string
  /** Short human-readable tool target, such as a file path or command. Never a complete transcript. */
  detail?: string
  /** Untruncated tool paths for repository attribution; never file contents. */
  targetPaths?: string[]
  cwd?: string
  usage?: AgentUsage
}
export interface AgentRequest {
  openspec?: import('./openspec.js').OpenSpecRoleContext
  role: AgentRole
  prompt: string
  cwd: string
  allowedRoots: string[]
  model?: string
  effort?: string
  maxTurns?: number
  timeoutMs?: number
  maxTokens?: number
  maxCostUsd?: number
  /** Only send a partial follow-up when capabilities guarantee restored history before inference. */
  resumeSessionId?: string
  /** JSON Schema for the final structured reply. Executors with native structured output enforce it; the prompt remains authoritative elsewhere. */
  outputSchema?: Record<string, unknown>
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
}
export interface AgentResult {
  text: string
  usage: AgentUsage
  sessionId?: string
  structured?: Record<string, unknown>
}
export type AgentLimits = Pick<AgentRequest, 'maxTokens' | 'maxCostUsd'>
export interface AgentExecutor {
  capabilities?(model?: string): ExecutorCapabilities | Promise<ExecutorCapabilities>
  /** Side-effect-free preflight. Custom executors own their limit capabilities. */
  validateOpenSpec?(context: import('./openspec.js').OpenSpecRoleContext): Promise<void>
  validateLimits?(limits: AgentLimits): void
  execute(request: AgentRequest): Promise<AgentResult>
}

export class AgentExecutionError extends Error {
  constructor(message: string, public readonly code: string, public readonly usage: AgentUsage = unknownUsage()) {
    super(message)
    this.name = 'AgentExecutionError'
  }
}
export function unknownUsage(): AgentUsage { return { inputTokens: null, outputTokens: null, costUsd: null } }
export function validateAgentRequest(request: AgentRequest): void {
  if (!['architect', 'developer', 'reviewer'].includes(request.role) || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.includes('\0')) throw new AgentExecutionError('Invalid role request', 'invalid_request')
  if (request.model !== undefined && (typeof request.model !== 'string' || !request.model.trim() || request.model.length > 256 || /^-/.test(request.model) || /[\0\r\n]/.test(request.model))) throw new AgentExecutionError('Invalid model identifier', 'invalid_model')
  for (const key of ['maxTurns', 'timeoutMs', 'maxTokens', 'maxCostUsd'] as const) {
    const value = request[key]
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || (key !== 'maxCostUsd' && !Number.isSafeInteger(value)))) throw new AgentExecutionError(`Invalid ${key}`, 'invalid_limit')
  }
  if (request.resumeSessionId !== undefined && (typeof request.resumeSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(request.resumeSessionId))) throw new AgentExecutionError('Invalid session identifier', 'invalid_request')
  if (request.outputSchema !== undefined && (!request.outputSchema || typeof request.outputSchema !== 'object' || Array.isArray(request.outputSchema))) throw new AgentExecutionError('Invalid output schema', 'invalid_request')
  if (request.signal?.aborted) throw new AgentExecutionError('Agent cancelled', 'aborted')
}
