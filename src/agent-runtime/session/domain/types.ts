/**
 * Provider-neutral session vocabulary. Every type here is plain data so it can
 * cross the protocol boundary, be journaled and be folded by pure reducers.
 * Provider wire formats never appear in this module (see drivers/).
 */

export type SessionPhase = 'idle' | 'turn' | 'background'
export type SessionStatus = 'open' | 'closed'
export type TurnOrigin = 'user' | 'subagent' | 'system'
export type TurnStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
export type InputDelivery = 'queue' | 'steer'
export type InputState = 'accepted' | 'queued' | 'started' | 'completed' | 'rejected' | 'interrupted'
export type SubagentKind = 'foreground' | 'background'
export type SubagentPhase = 'running' | 'idle' | 'failed' | 'stopped' | 'killed' | 'interrupted'
export type OutputChannel = 'text' | 'thinking'

/** Usage for one turn or one sub-agent. `null` means "not reported", never zero. */
export interface Usage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  /** Provider total when it reports no breakdown (e.g. Claude sub-agent progress). */
  totalTokens: number | null
  /** Per-turn delta in USD. Sub-agent usage is a breakdown and is never added on top. */
  costUsd: number | null
  /** True when the cost was derived from a rate card instead of billed by the provider. */
  costEstimated: boolean
  model: string | null
}

export const EMPTY_USAGE: Usage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  totalTokens: null,
  costUsd: null,
  costEstimated: false,
  model: null,
})

export interface McpServerSpec {
  name: string
  /** stdio server */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http server */
  url?: string
  headers?: Record<string, string>
}

export interface SessionLimits {
  /** Retire a resident process after this long in `idle`. */
  idleMs: number
  /** In `background`, retire when no provider frame arrives for this long. */
  stallMs: number
  /** In `background`, retire this long after the last user turn. */
  backgroundMaxMs: number
  /** Fail a running turn when no provider frame (including sub-agent frames) arrives for this long. */
  turnInactivityMs: number
  /** Maximum policy-driven `resume-agent` turns per settle cycle. */
  maxSettleHandoffs: number
  /** Debounce before an empty sub-agent roster counts as settled. */
  settleDebounceMs: number
}

export interface SessionPolicy {
  subagents: 'enabled' | 'disabled'
  onSubagentsSettled: 'provider-native' | 'resume-agent' | 'notify-only'
  tools: { mode: 'default' | 'read-only' | 'none'; allow?: string[]; deny?: string[] }
  permissions: 'bypass' | 'workspace-write' | 'read-only'
  mcp: { servers: McpServerSpec[]; inheritUserScope: boolean }
  limits: SessionLimits
}

/** Usage semantics a driver declares; the domain computes deltas from them. */
export interface UsageSemantics {
  /** How the provider reports USD. */
  costUsd: 'session-cumulative' | 'per-turn' | 'none'
  /** How the provider reports tokens for a turn. */
  tokens: 'per-turn' | 'cumulative' | 'none'
}

export interface DriverCapabilities {
  /** Multi-turn on one long-lived provider process. */
  resident: boolean
  /** The provider serializes turns itself and reports per-input receipts. */
  nativeInputQueue: boolean
  subagents: 'unsupported' | 'supported'
  /** `policy.subagents = 'disabled'` can be enforced natively. */
  subagentDisable: boolean
  /** The provider starts a turn by itself when a background sub-agent finishes. */
  autonomousContinuation: boolean
  /** Input can be delivered into a running turn. */
  steer: boolean
  /** The tool set can be restricted (`policy.tools` other than the default). */
  toolFiltering: boolean
  usage: UsageSemantics
}

export interface DriverDescriptor {
  id: string
  displayName: string
  capabilities: DriverCapabilities
  /** CLI versions the recorded fixtures cover, informative. */
  testedVersions?: string[]
}

export interface Attachment {
  kind: 'image' | 'file'
  path: string
  mimeType?: string
}
