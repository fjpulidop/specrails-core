/** Subsets of inputTokens, never added again to the existing token total. */
export interface CacheTokenUsage {
  uncachedInputTokens?: number | null
  cacheReadInputTokens?: number | null
  cacheWriteInputTokens?: number | null
}
export interface ProviderInvocation {
  invocationId?: string
  ordinal?: number
  kind?: import('./role-routing.js').InvocationKind
  tier?: 'base' | 'escalation'
  routeReason?: string
  contextMode?: 'full' | 'incremental'
  promptBytes?: number
  contextBytes?: number
  handoffBytes?: number
  requestedEffort?: string | null
  provider: string
  /** Requested model; absent means the provider selected its default. */
  model?: string
  status: 'succeeded' | 'failed'
  /** Entire executor wall time, including its native tools and process startup. */
  durationMs: number
  toolCalls: number
  usage: CacheTokenUsage & { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
}
export const CACHE_TOKEN_KEYS = ['uncachedInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens'] as const

export function sumCacheUsage(values: CacheTokenUsage[]): CacheTokenUsage {
  if (!values.some(value => CACHE_TOKEN_KEYS.some(key => value[key] !== undefined))) return {}
  return Object.fromEntries(CACHE_TOKEN_KEYS.map(key => [key, values.some(value => value[key] == null)
    ? null : values.reduce((sum, value) => sum + (value[key] ?? 0), 0)]))
}

export interface EfficiencyTotals {
  attempts: number
  measuredAttempts: number
  /** Completed phase wall time; null while an attempt has no end timestamp. */
  durationMs: number | null
  agentDurationMs: number | null
  providerCalls: number | null
  toolCalls: number | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  uncachedInputTokens: number | null
  cacheReadInputTokens: number | null
  cacheWriteInputTokens: number | null
}
export interface RuntimeEfficiency {
  schemaVersion: 1
  total: EfficiencyTotals
  phases: Array<EfficiencyTotals & { stepId: string; providers: string[]; models: string[] }>
}

export type PendingProviderInvocation = Pick<ProviderInvocation, 'provider' | 'model' | 'kind' | 'tier' | 'routeReason' | 'contextMode' | 'promptBytes' | 'contextBytes' | 'handoffBytes' | 'requestedEffort'> & { invocationId: string; ordinal: number }
