import { EMPTY_USAGE, type Usage, type UsageSemantics } from './types.js'

/** Raw values as a provider reported them for one turn (or one sub-agent thread). */
export interface ReportedUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  totalTokens?: number | null
  costUsd?: number | null
  model?: string | null
}

type Counter = 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
const COUNTERS: readonly Counter[] = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/**
 * Last known cumulative provider totals for one provider session (or thread).
 * `null` means unknown — e.g. a session resumed from history we never observed —
 * which is different from a fresh session whose baseline is 0.
 */
export interface UsageBaseline {
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

export const FRESH_BASELINE: UsageBaseline = Object.freeze({ costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
export const UNKNOWN_BASELINE: UsageBaseline = Object.freeze({ costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null })

export interface TurnUsageResult {
  usage: Usage
  baseline: UsageBaseline
  /** Values that went backwards (provider reset); the reported value was used as the delta. */
  resets: string[]
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Delta of a cumulative counter against its baseline. Unknown baseline → unknown delta. */
function delta(reported: number | null, base: number | null, key: string, resets: string[]): { value: number | null; next: number | null } {
  if (reported === null) return { value: null, next: base }
  if (base === null) return { value: null, next: reported }
  if (reported < base) { resets.push(key); return { value: reported, next: reported } }
  return { value: reported - base, next: reported }
}

/**
 * Convert what the provider reported into this turn's usage, according to the
 * driver's declared semantics. Verified against real CLIs:
 * - Claude reports USD cumulative per session, including across `--resume`,
 *   and tokens per turn.
 * - Codex reports tokens cumulative per thread and no USD.
 * Missing values stay null; nothing is ever coerced to zero.
 */
export function computeTurnUsage(semantics: UsageSemantics, baseline: UsageBaseline, reported: ReportedUsage): TurnUsageResult {
  const resets: string[] = []
  const next: UsageBaseline = { ...baseline }
  const usage: Usage = { ...EMPTY_USAGE, model: reported.model ?? null }

  // A reported total is only meaningful per turn; cumulative totals are not tracked as a baseline.
  if (semantics.tokens === 'per-turn') usage.totalTokens = finite(reported.totalTokens)
  if (semantics.costUsd === 'session-cumulative') {
    const result = delta(finite(reported.costUsd), baseline.costUsd, 'costUsd', resets)
    usage.costUsd = result.value
    next.costUsd = result.next
  } else if (semantics.costUsd === 'per-turn') {
    usage.costUsd = finite(reported.costUsd)
  }

  for (const key of COUNTERS) {
    if (semantics.tokens === 'per-turn') {
      usage[key] = finite(reported[key])
    } else if (semantics.tokens === 'cumulative') {
      const result = delta(finite(reported[key]), baseline[key], key, resets)
      usage[key] = result.value
      next[key] = result.next
    }
  }
  return { usage, baseline: next, resets }
}

/** USD per million tokens; supplied by the host, never guessed by Core. */
export interface RateCard {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok?: number
  cacheWritePerMTok?: number
}

/**
 * Fill a missing cost from a rate card and flag it as an estimate. A billed cost
 * is never overwritten; usage with no billable tokens stays null.
 */
export function withEstimatedCost(usage: Usage, rate: RateCard | null): Usage {
  if (usage.costUsd !== null || !rate) return usage
  const parts: Array<[number | null, number | undefined]> = [
    [usage.inputTokens, rate.inputPerMTok],
    [usage.outputTokens, rate.outputPerMTok],
    [usage.cacheReadTokens, rate.cacheReadPerMTok],
    [usage.cacheWriteTokens, rate.cacheWritePerMTok],
  ]
  if (!parts.some(([tokens]) => (tokens ?? 0) > 0)) return usage
  const cost = parts.reduce((sum, [tokens, price]) => sum + ((tokens ?? 0) * (price ?? 0)) / 1_000_000, 0)
  return { ...usage, costUsd: cost, costEstimated: true }
}

/** Sum usages for display breakdowns; a sum is null only when every part is null. */
export function sumUsage(items: readonly Usage[]): Usage {
  const total: Usage = { ...EMPTY_USAGE }
  for (const item of items) {
    for (const key of [...COUNTERS, 'totalTokens', 'costUsd'] as const) {
      const value = item[key]
      if (value !== null) total[key] = (total[key] ?? 0) + value
    }
    total.costEstimated = total.costEstimated || item.costEstimated
    total.model = total.model ?? item.model
  }
  return total
}
