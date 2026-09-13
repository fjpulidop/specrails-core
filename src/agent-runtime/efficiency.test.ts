import { describe, expect, it } from 'vitest'
import { runtimeEfficiency, sumCacheUsage } from './efficiency.js'
import type { StepAttemptRecord, WorkflowState } from './workflow-types.js'

function state(history: StepAttemptRecord[]): WorkflowState {
  return {
    schemaVersion: 2, runId: 'run', traceId: 'trace', workflowId: 'test', workflowVersion: '1', workflowFingerprint: 'w', inputFingerprint: 'i',
    status: 'succeeded', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z', nextStep: null,
    nextAttempt: 1, transitions: 1, executionCount: history.length, steps: {}, history, events: [], budget: {},
    usage: { costUsd: 0.2, inputTokens: 200, outputTokens: 20, knownCostUsd: 0.2, knownTokens: 220, durationMs: 1500 },
  }
}
function attempt(overrides: Partial<StepAttemptRecord> = {}): StepAttemptRecord {
  return {
    id: 'one', stepId: 'developer', attempt: 1, visit: 1, status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z',
    usage: { costUsd: 0.1, inputTokens: 100, outputTokens: 10 },
    invocations: [{ provider: 'local', model: 'test-model', status: 'succeeded', durationMs: 800, toolCalls: 2, usage: { costUsd: 0.1, inputTokens: 100, outputTokens: 10, uncachedInputTokens: 20, cacheReadInputTokens: 80, cacheWriteInputTokens: 0 } }],
    ...overrides,
  }
}
describe('runtime efficiency projection', () => {
  it('includes failed attempts and cached input exactly once without mutating persisted state', () => {
    const failed = attempt({ status: 'failed' })
    failed.invocations![0]!.status = 'failed'
    const source = state([failed, attempt({ id: 'two', visit: 2 })]), before = structuredClone(source)
    const metrics = runtimeEfficiency(source)
    expect(metrics.total).toEqual({ attempts: 2, measuredAttempts: 2, durationMs: 1500, agentDurationMs: 1600, providerCalls: 2, toolCalls: 4, costUsd: 0.2, inputTokens: 200, outputTokens: 20, uncachedInputTokens: 40, cacheReadInputTokens: 160, cacheWriteInputTokens: 0 })
    expect(metrics.phases[0]).toMatchObject({ stepId: 'developer', durationMs: 2000, providers: ['local'], models: ['test-model'] })
    expect(runtimeEfficiency(source)).toEqual(metrics)
    expect(source).toEqual(before)
  })
  it('reports missing invocation details and unfinished phase durations as unavailable', () => {
    const metrics = runtimeEfficiency(state([attempt({ invocations: undefined, completedAt: undefined, status: 'running' })]))
    expect(metrics.phases[0]).toMatchObject({ attempts: 1, measuredAttempts: 0, durationMs: null, agentDurationMs: null, providerCalls: null, toolCalls: null, cacheReadInputTokens: null })
    expect(metrics.total.inputTokens).toBe(200)
  })
  it('never reports zero billing for a durable call interrupted before its measurement', () => {
    const pending = attempt({ pendingInvocations: [{ invocationId: 'one:call:2', ordinal: 2, provider: 'local', model: 'test-model' }], status: 'interrupted' })
    const metrics = runtimeEfficiency(state([pending]))
    expect(metrics.total).toMatchObject({ costUsd: null, inputTokens: null, outputTokens: null, providerCalls: null, agentDurationMs: null })
    expect(runtimeEfficiency(state([pending]))).toEqual(metrics)
  })
  it('distinguishes deterministic zero spend from missing billing or cache data', () => {
    const deterministic = attempt({ stepId: 'verify', invocations: undefined, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 } })
    const unknown = attempt({ usage: { costUsd: null, inputTokens: 100, outputTokens: 10 } })
    unknown.invocations![0]!.usage = { costUsd: null, inputTokens: 100, outputTokens: 10 }
    const metrics = runtimeEfficiency(state([deterministic, unknown]))
    expect(metrics.phases[0]).toMatchObject({ costUsd: 0, providerCalls: 0, toolCalls: 0, cacheReadInputTokens: 0 })
    expect(metrics.phases[1]).toMatchObject({ costUsd: null, cacheReadInputTokens: null })
    expect(sumCacheUsage([{ cacheReadInputTokens: 10 }, {}]).cacheReadInputTokens).toBeNull()
    expect(sumCacheUsage([{}, {}])).toEqual({})
  })
})
