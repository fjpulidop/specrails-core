import type { StepAttemptRecord, WorkflowState } from './workflow-types.js'
import { CACHE_TOKEN_KEYS, type EfficiencyTotals, type RuntimeEfficiency } from './efficiency-types.js'
export * from './efficiency-types.js'

function sum(values: Array<number | null | undefined>): number | null {
  return values.some(value => value == null || !Number.isFinite(value) || value < 0) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0)
}
const AGENT_PHASES = new Set(['architect', 'developer', 'reviewer'])

function totals(attempts: StepAttemptRecord[]): EfficiencyTotals {
  const invocations = attempts.flatMap(attempt => attempt.invocations ?? [])
  const measured = attempts.filter(attempt => !AGENT_PHASES.has(attempt.stepId) || attempt.invocations !== undefined)
  const complete = measured.length === attempts.length
  const duration = (attempt: StepAttemptRecord) => attempt.completedAt ? Math.max(0, Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)) : null
  const cache = Object.fromEntries(CACHE_TOKEN_KEYS.map(key => [key, complete ? sum(invocations.map(call => call.usage[key])) : null])) as Pick<EfficiencyTotals, typeof CACHE_TOKEN_KEYS[number]>
  return {
    attempts: attempts.length, measuredAttempts: measured.length,
    durationMs: sum(attempts.map(duration)),
    agentDurationMs: complete ? sum(invocations.map(call => call.durationMs)) : null,
    providerCalls: complete ? invocations.length : null,
    toolCalls: complete ? sum(invocations.map(call => call.toolCalls)) : null,
    inputTokens: sum(attempts.map(attempt => attempt.usage?.inputTokens)),
    outputTokens: sum(attempts.map(attempt => attempt.usage?.outputTokens)),
    costUsd: sum(attempts.map(attempt => attempt.usage?.costUsd)),
    ...cache,
  }
}

/** Read-only projection: failed/superseded attempts remain spend, polling never changes it. */
export function runtimeEfficiency(state: WorkflowState): RuntimeEfficiency {
  const phases = [...new Set(state.history.map(attempt => attempt.stepId))].map(stepId => {
    const attempts = state.history.filter(attempt => attempt.stepId === stepId)
    const calls = attempts.flatMap(attempt => attempt.invocations ?? [])
    return { stepId, ...totals(attempts), providers: [...new Set(calls.map(call => call.provider))], models: [...new Set(calls.map(call => call.model).filter((model): model is string => model !== undefined))] }
  })
  return { schemaVersion: 1, total: { ...totals(state.history), durationMs: state.usage.durationMs, inputTokens: state.usage.inputTokens, outputTokens: state.usage.outputTokens, costUsd: state.usage.costUsd }, phases }
}
