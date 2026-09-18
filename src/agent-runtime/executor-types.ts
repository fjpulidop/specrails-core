import type { VerificationCommand } from '../installer/runtime/pipeline-state.js'
import type { CacheTokenUsage } from './efficiency-types.js'
import type { GuardrailSettings } from './guardrails.js'

export const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60_000
export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 15 * 60_000

export type AgentRole = 'architect' | 'developer' | 'reviewer'
/** Who an observer sees acting: a pipeline role, or the FIXER stance the developer step takes on a correction round. */
export type AgentEventRole = AgentRole | 'fixer'
export type CliProvider = 'claude' | 'codex' | 'gemini' | 'kimi'
export type RuntimeProviderConfig =
  | { id: string; kind: 'cli'; cli: CliProvider }
  | { id: string; kind: 'openai-compatible'; baseUrl: string; apiKeyEnv?: string
      /** `compact` (default) runs host-driven pipelines of small structured calls for small local models; `free` keeps one agentic loop per role. */
      agentLoop?: 'compact' | 'free'
      /** The endpoint honours the OpenAI `reasoning_effort` request field (low|medium|high). */
      supportsReasoningEffort?: boolean
      /** Context window the compaction budget is measured against (chars/4 estimate). Default 32768. */
      contextWindowTokens?: number
      /** Output budget (`max_tokens`) of one tool turn; a turn cut off by it is retried once at twice this. Always bounded by what still fits in the context window. Default 8192. */
      maxOutputTokens?: number }
export interface RuntimeAgentConfig {
  provider: string
  model?: string
  maxTurns?: number
  effort?: string
  /** OpenAI-compatible engines only: whether the model may think privately (`chat_template_kwargs.enable_thinking`). Default `off` — hidden reasoning spends the output budget and minutes per turn in a host-driven loop. */
  thinking?: 'on' | 'off'
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
  /** Some native transports may start fresh when a session disappears; send complete instructions. */
  resumeRequiresFullContext?: boolean
  effortSupport: 'supported' | 'unsupported' | 'unknown'
  supportedEfforts: string[] | null
  observedModel: boolean
  observedEffort: boolean
}
export type ReviewAspectName = 'type_correctness' | 'pattern_adherence' | 'test_coverage' | 'security' | 'architectural_alignment'
export interface RuntimeConfig {
  schemaVersion: 1
  rolePrompts?: Partial<Record<AgentRole | 'fixer', string>>
  efficiency?: EfficiencyPolicy
  enabled: boolean
  providers: RuntimeProviderConfig[]
  agents: Record<AgentRole, RuntimeAgentConfig>
  /** Optional engine for correction rounds (after a failed verification or a rejected review); unset ⇒ the developer corrects. */
  fixer?: RuntimeAgentConfig
  limits?: { maxAttempts?: number; maxTokens?: number; maxCostUsd?: number; timeoutMs?: number; idleTimeoutMs?: number }
  verification: VerificationCommand[]
  approvalBeforeArchive?: boolean
  /** Review gate thresholds (0–100); unset fields keep Core's defaults. */
  review?: { minScore?: number; aspects?: Partial<Record<ReviewAspectName, number>> }
  /** What to do when the architect still reports low confidence after investigating: ask the requester (default) or proceed on stated assumptions. */
  architect?: { onLowConfidence?: 'ask' | 'proceed' }
  /** Compact-runtime guardrails switched OFF by the project (`{ id: false }`); unset = every guardrail on. */
  guardrails?: GuardrailSettings
}
/** Null means unavailable, including when a CLI never reports billing. */
export interface AgentUsage extends CacheTokenUsage { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
export interface AgentEvent {
  kind: 'text' | 'tool-start' | 'tool-end' | 'usage' | 'session'
  /** Provider-issued identifier, persisted before further work can be interrupted. */
  sessionId?: string
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
  /** Local engines: private thinking on/off for this invocation (see RuntimeAgentConfig.thinking). */
  thinking?: 'on' | 'off'
  maxTurns?: number
  timeoutMs?: number
  /** Maximum silence from the provider; independent of the total invocation limit. */
  idleTimeoutMs?: number
  maxTokens?: number
  maxCostUsd?: number
  /** Only send a partial follow-up when capabilities guarantee restored history before inference. */
  resumeSessionId?: string
  /** JSON Schema for the final structured reply. Executors with native structured output enforce it; the prompt remains authoritative elsewhere. */
  outputSchema?: Record<string, unknown>
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
  /** Project guardrail switches for the compact runtime (see guardrails.ts). */
  guardrails?: GuardrailSettings
  /** `fixer`: this developer invocation is a correction round on the fixer engine (fixer stance, no plan dump). */
  stance?: 'fixer'
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
  constructor(message: string, public readonly code: string, public readonly usage: AgentUsage = unknownUsage(), public readonly sessionId?: string) {
    super(message)
    this.name = 'AgentExecutionError'
  }
  get interrupted(): boolean { return ['timeout', 'idle_timeout', 'aborted'].includes(this.code) }
}
export function unknownUsage(): AgentUsage { return { inputTokens: null, outputTokens: null, costUsd: null } }
export function validateAgentRequest(request: AgentRequest): void {
  if (!['architect', 'developer', 'reviewer'].includes(request.role) || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.includes('\0')) throw new AgentExecutionError('Invalid role request', 'invalid_request')
  if (request.model !== undefined && (typeof request.model !== 'string' || !request.model.trim() || request.model.length > 256 || /^-/.test(request.model) || /[\0\r\n]/.test(request.model))) throw new AgentExecutionError('Invalid model identifier', 'invalid_model')
  for (const key of ['maxTurns', 'timeoutMs', 'idleTimeoutMs', 'maxTokens', 'maxCostUsd'] as const) {
    const value = request[key]
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || (key !== 'maxCostUsd' && !Number.isSafeInteger(value)))) throw new AgentExecutionError(`Invalid ${key}`, 'invalid_limit')
  }
  if (request.resumeSessionId !== undefined && (typeof request.resumeSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(request.resumeSessionId))) throw new AgentExecutionError('Invalid session identifier', 'invalid_request')
  if (request.outputSchema !== undefined && (!request.outputSchema || typeof request.outputSchema !== 'object' || Array.isArray(request.outputSchema))) throw new AgentExecutionError('Invalid output schema', 'invalid_request')
  if (request.signal?.aborted) throw new AgentExecutionError('Agent cancelled', 'aborted')
}
