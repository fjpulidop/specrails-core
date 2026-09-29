import { EngineError, type EngineUsage, type WorkflowBudget } from './contracts.js'

export function budgetError(usage: EngineUsage, budget: WorkflowBudget, elapsedMs: number, admission = true): string | undefined {
  const reached = (used: number, limit: number) => admission ? used >= limit : used > limit
  if (budget.maxCostUsd !== undefined && reached(usage.knownCostUsd, budget.maxCostUsd)) return 'cost_budget'
  if (budget.maxTokens !== undefined && reached(usage.knownInputTokens + usage.knownOutputTokens, budget.maxTokens)) return 'token_budget'
  if (budget.maxDurationMs !== undefined && reached(elapsedMs, budget.maxDurationMs)) return 'timeout'
  return undefined
}

/** Missing billing stays unknown; only reported lower bounds reduce headroom. */
export function remainingBudget(usage: EngineUsage, budget: WorkflowBudget, elapsedMs: number,
  reserved: { costUsd: number; tokens: number } = { costUsd: 0, tokens: 0 }): WorkflowBudget {
  return {
    ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: Math.max(0, budget.maxCostUsd - usage.knownCostUsd - reserved.costUsd) }),
    ...(budget.maxTokens === undefined ? {} : { maxTokens: Math.max(0, Math.floor(budget.maxTokens - usage.knownInputTokens - usage.knownOutputTokens - reserved.tokens)) }),
    ...(budget.maxDurationMs === undefined ? {} : { maxDurationMs: Math.max(0, budget.maxDurationMs - elapsedMs) }),
  }
}

/** Graph and host limits intersect: an imported definition cannot raise host caps. */
export function intersectBudgets(...values: Array<WorkflowBudget | undefined>): WorkflowBudget {
  const result: WorkflowBudget = {}
  for (const value of values) for (const key of ['maxCostUsd', 'maxTokens', 'maxDurationMs'] as const) {
    const limit = value?.[key]
    if (limit === undefined) continue
    if (!Number.isFinite(limit) || limit < 0 || (key === 'maxTokens' && !Number.isSafeInteger(limit))) throw new EngineError('invalid_arguments', `Invalid ${key}`)
    result[key] = Math.min(result[key] ?? Infinity, limit)
  }
  return result
}
