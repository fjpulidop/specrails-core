import { describe, expect, it } from 'vitest'

import { EMPTY_USAGE, type UsageSemantics } from './types.js'
import { FRESH_BASELINE, UNKNOWN_BASELINE, computeTurnUsage, sumUsage, withEstimatedCost } from './usage.js'

const claude: UsageSemantics = { costUsd: 'session-cumulative', tokens: 'per-turn' }
const codex: UsageSemantics = { costUsd: 'none', tokens: 'cumulative' }

describe('turn usage', () => {
  it('turns Claude session-cumulative USD into per-turn deltas (spike values)', () => {
    // Process A: 0.05353345 then 0.0636739; resumed process B: 0.0698117 (claude-kill-bg / claude-resume-after-kill).
    const first = computeTurnUsage(claude, FRESH_BASELINE, { costUsd: 0.05353345, outputTokens: 305, model: 'haiku' })
    expect(first.usage.costUsd).toBeCloseTo(0.05353345, 10)
    expect(first.usage.outputTokens).toBe(305)
    const second = computeTurnUsage(claude, first.baseline, { costUsd: 0.0636739, outputTokens: 185 })
    expect(second.usage.costUsd).toBeCloseTo(0.01014045, 10)
    // The baseline survives the process: a resumed process continues from it.
    const resumed = computeTurnUsage(claude, second.baseline, { costUsd: 0.0698117, outputTokens: 218 })
    expect(resumed.usage.costUsd).toBeCloseTo(0.0061378, 10)
    expect(resumed.usage.outputTokens).toBe(218)
    expect(resumed.resets).toEqual([])
  })

  it('does not invent a delta when the baseline is unknown', () => {
    const result = computeTurnUsage(claude, UNKNOWN_BASELINE, { costUsd: 0.07 })
    expect(result.usage.costUsd).toBeNull()
    expect(result.baseline.costUsd).toBe(0.07)
  })

  it('keeps missing values null and the baseline unchanged', () => {
    const result = computeTurnUsage(claude, { ...FRESH_BASELINE, costUsd: 0.5 }, {})
    expect(result.usage).toEqual(EMPTY_USAGE)
    expect(result.baseline.costUsd).toBe(0.5)
  })

  it('treats a cumulative value that goes backwards as a provider reset', () => {
    const result = computeTurnUsage(claude, { ...FRESH_BASELINE, costUsd: 0.5 }, { costUsd: 0.1 })
    expect(result.usage.costUsd).toBe(0.1)
    expect(result.resets).toEqual(['costUsd'])
  })

  it('turns Codex per-thread cumulative tokens into deltas and reports no USD (spike values)', () => {
    // codex-multi-wait parent thread totals: 13834 → 37261.
    const first = computeTurnUsage(codex, FRESH_BASELINE, { inputTokens: 13_700, outputTokens: 134 })
    const second = computeTurnUsage(codex, first.baseline, { inputTokens: 37_000, outputTokens: 261 })
    expect(second.usage.inputTokens).toBe(23_300)
    expect(second.usage.outputTokens).toBe(127)
    expect(second.usage.costUsd).toBeNull()
  })

  it('ignores negative and non-finite provider values', () => {
    const result = computeTurnUsage(claude, FRESH_BASELINE, { costUsd: Number.NaN, inputTokens: -3, outputTokens: Infinity })
    expect(result.usage.costUsd).toBeNull()
    expect(result.usage.inputTokens).toBeNull()
    expect(result.usage.outputTokens).toBeNull()
  })
})

describe('estimated cost', () => {
  const rate = { inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.1 }

  it('fills a missing cost from the rate card and flags it', () => {
    const usage = withEstimatedCost({ ...EMPTY_USAGE, inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 1_000_000 }, rate)
    expect(usage.costUsd).toBeCloseTo(3.1, 10)
    expect(usage.costEstimated).toBe(true)
  })

  it('never overwrites a billed cost and never estimates empty usage', () => {
    const billed = { ...EMPTY_USAGE, costUsd: 0.2, inputTokens: 10 }
    expect(withEstimatedCost(billed, rate)).toBe(billed)
    expect(withEstimatedCost(EMPTY_USAGE, rate)).toBe(EMPTY_USAGE)
    expect(withEstimatedCost({ ...EMPTY_USAGE, inputTokens: 5 }, null).costUsd).toBeNull()
  })

  it('sums breakdowns preserving null-only parts', () => {
    const total = sumUsage([{ ...EMPTY_USAGE, inputTokens: 2, costUsd: 0.1 }, { ...EMPTY_USAGE, inputTokens: 3, costEstimated: true }])
    expect(total.inputTokens).toBe(5)
    expect(total.costUsd).toBe(0.1)
    expect(total.outputTokens).toBeNull()
    expect(total.costEstimated).toBe(true)
  })
})
