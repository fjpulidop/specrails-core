import { expect, it } from 'vitest'
import { budgetError, intersectBudgets, remainingBudget } from './budget.js'
import { emptyUsage } from './state.js'

it('preserves unknown usage while enforcing reported lower bounds and reservations', () => {
  const usage = { ...emptyUsage(), costUsd: null, inputTokens: null, knownCostUsd: 0.25, knownInputTokens: 40, knownOutputTokens: 10 }
  expect(remainingBudget(usage, { maxCostUsd: 1, maxTokens: 100, maxDurationMs: 1000 }, 200, { costUsd: 0.25, tokens: 20 }))
    .toEqual({ maxCostUsd: 0.5, maxTokens: 30, maxDurationMs: 800 })
  expect(budgetError(usage, { maxTokens: 50 }, 0)).toBe('token_budget')
  expect(budgetError(usage, { maxTokens: 50 }, 0, false)).toBeUndefined()
  expect(budgetError(usage, { maxCostUsd: 0.2 }, 0, false)).toBe('cost_budget')
  expect(budgetError(usage, { maxDurationMs: 10 }, 10)).toBe('timeout')
  expect(usage.costUsd).toBeNull()
})
it('definition budgets can lower host caps but cannot raise them', () => {
  expect(intersectBudgets({ maxTokens: 100, maxDurationMs: 200 }, { maxTokens: 200, maxCostUsd: 1 }, { maxDurationMs: 50 }))
    .toEqual({ maxTokens: 100, maxCostUsd: 1, maxDurationMs: 50 })
  expect(remainingBudget(emptyUsage(), {}, 0)).toEqual({})
  for (const maxTokens of [-1, 1.5, Infinity, NaN]) expect(() => intersectBudgets({ maxTokens })).toThrow()
})
