import { describe, expect, it } from 'vitest'
import { failureField } from './cli.js'
import { definitionFailure } from './engine/cli.js'
import type { WorkflowState } from './workflow-types.js'
import { classifyFailure, FAILURE_KINDS, providerLimitReset } from './failure-classification.js'

const steps = (record: Record<string, { status: string; visits?: number; error?: string }>) => record

describe('classifyFailure', () => {
  it('has nothing to diagnose for runs that did not fail', () => {
    for (const status of ['succeeded', 'paused', 'cancelled', 'running']) expect(classifyFailure({ status, error: 'You\'ve hit your session limit' })).toBeUndefined()
  })

  it('classifies a provider limit with the provider\'s own reset hint and a resumable phase', () => {
    const result = classifyFailure({ status: 'failed', error: 'claude execution failed (exit 1). You\'ve hit your session limit · resets 3am (Europe/Madrid)', steps: steps({ developer: { status: 'failed', visits: 1 } }) })
    expect(result).toMatchObject({ kind: 'provider_limit', confidence: 'high', phase: 'developer', resetAt: '3am (Europe/Madrid)', resumablePhase: 'developer' })
    for (const message of ['Provider answered HTTP 429', 'error type rate_limit, HTTP 429', 'insufficient_quota', 'RESOURCE_EXHAUSTED: quota exceeded'])
      expect(classifyFailure({ status: 'failed', error: message })?.kind).toBe('provider_limit')
    expect(classifyFailure({ status: 'failed', error: 'Usage limit reached' })?.resetAt).toBeUndefined()
  })

  it('classifies tests that kept failing, counting correction rounds', () => {
    const result = classifyFailure({
      status: 'blocked', nextStep: 'fixer',
      error: 'Correction loop stopped: the last correction round left the change exactly as it was when verification failed (npm test)',
      steps: steps({ architect: { status: 'succeeded', visits: 1 }, developer: { status: 'succeeded', visits: 1 }, fixer: { status: 'blocked', visits: 4 }, verify: { status: 'succeeded', visits: 5 } }),
    })
    expect(result).toMatchObject({ kind: 'tests_failed', confidence: 'high', phase: 'fixer', rounds: 4, resumablePhase: 'fixer' })
  })

  it('classifies a failed (not blocked) verification as tests_failed without a resumable phase', () => {
    const result = classifyFailure({ status: 'failed', error: 'Verification failed: 3 failing tests', steps: steps({ verify: { status: 'failed', visits: 1 } }) })
    expect(result).toMatchObject({ kind: 'tests_failed', phase: 'verify' })
    expect(result?.resumablePhase).toBeUndefined()
  })

  it('classifies host environment blockers from codes and messages', () => {
    expect(classifyFailure({ status: 'blocked', error: 'Verification cannot run in this environment: the registry rejected the credentials (`npm ci` in .). This is not a defect in the change' })).toMatchObject({ kind: 'environment', confidence: 'high' })
    expect(classifyFailure({ status: 'blocked', error: { code: 'verification_host_precondition', message: 'the toolchain is missing' } })?.kind).toBe('environment')
    expect(classifyFailure({ status: 'blocked', error: 'Verification output is not deterministic: x (verification_nondeterministic_output)' })?.kind).toBe('environment')
  })

  it('classifies run-limit stops as blocked (baseline, budget, correction limit)', () => {
    expect(classifyFailure({ status: 'blocked', error: 'The characterization tests fail on the unchanged code (baseline_characterization_failed)' })).toMatchObject({ kind: 'blocked', confidence: 'high' })
    expect(classifyFailure({ status: 'blocked', error: 'Implementation correction limit reached; inspect the feedback in the log and resume to grant more attempts' })?.kind).toBe('blocked')
    expect(classifyFailure({ status: 'failed', error: { code: 'budget_exhausted', message: 'Run budget is exhausted' } })?.kind).toBe('blocked')
    expect(classifyFailure({ status: 'blocked', error: 'Correction loop stopped: the reviewer rejected the same change twice and the correction rounds did not change it (verification passed)' })?.kind).toBe('blocked')
  })

  it('separates the total time limit from tool inactivity', () => {
    expect(classifyFailure({ status: 'blocked', error: { code: 'timeout', message: 'Workflow active-duration budget exhausted' } })).toMatchObject({ kind: 'timeout', confidence: 'high' })
    expect(classifyFailure({ status: 'blocked', error: 'Agent reached the total execution limit (3600000 ms)' })?.kind).toBe('timeout')
    expect(classifyFailure({ status: 'failed', error: { code: 'idle_timeout', message: 'Agent idle timeout: no tool call, reply or usage for 15 minutes' } })).toMatchObject({ kind: 'tool_inactivity', confidence: 'high' })
  })

  it('classifies process and lease losses as crash', () => {
    expect(classifyFailure({ status: 'failed', error: { code: 'lease_lost', message: 'Execution lease was lost' } })?.kind).toBe('crash')
    expect(classifyFailure({ status: 'failed', error: 'codex exited without a successful final result' })?.kind).toBe('crash')
  })

  it('never invents a cause: unmatched failures are unknown with low confidence', () => {
    const result = classifyFailure({ status: 'failed', error: 'Something odd happened', steps: steps({ reviewer: { status: 'failed', visits: 1 } }) })
    expect(result).toEqual({ kind: 'unknown', phase: 'reviewer', detail: 'Something odd happened', confidence: 'low' })
    expect(classifyFailure({ status: 'failed' })).toEqual({ kind: 'unknown', confidence: 'low' })
  })

  it('reads the failing node of an engine 2 run from recentFailures', () => {
    const result = classifyFailure({
      status: 'failed',
      steps: { 'implement/fix': { kind: 'agent', status: 'failed', visits: 3 }, 'implement/verify': { kind: 'verify', status: 'succeeded', visits: 3 } },
      recentFailures: [{ nodePath: 'implement/fix', status: 'failed', visit: 3, error: { code: 'provider_request_error', message: 'connection dropped; lost its endpoint' } }],
    })
    expect(result).toMatchObject({ kind: 'crash', phase: 'implement/fix', rounds: 3 })
  })

  it('bounds the detail and only emits documented kinds', () => {
    const result = classifyFailure({ status: 'failed', error: 'x'.repeat(2000) })
    expect(result?.detail?.length).toBeLessThanOrEqual(280)
    expect(FAILURE_KINDS).toContain(result!.kind)
  })

  it('extracts reset hints only when the message carries a time', () => {
    expect(providerLimitReset('resets in 2 hours.')).toBe('2 hours')
    expect(providerLimitReset('no hint here')).toBeUndefined()
  })
})

describe('result fields', () => {
  it('adds the engine 2 classification only for failed or blocked states', () => {
    expect(definitionFailure({ status: 'succeeded' })).toEqual({})
    expect(definitionFailure({ status: 'failed', steps: { verify: { kind: 'verify', status: 'failed', visits: 1 } }, recentFailures: [{ nodePath: 'verify', status: 'failed', error: { code: 'verification_host_precondition', message: 'the toolchain is missing' } }] }))
      .toEqual({ failure: expect.objectContaining({ kind: 'environment', phase: 'verify', confidence: 'high' }) })
  })
  it('adds the engine 1 classification from the workflow state', () => {
    const state = { status: 'blocked', nextStep: 'fixer', error: 'Correction loop stopped: verification failed twice', steps: { fixer: { status: 'blocked', visits: 3 } } } as unknown as WorkflowState
    expect(failureField(state)).toEqual({ failure: expect.objectContaining({ kind: 'tests_failed', rounds: 3, resumablePhase: 'fixer' }) })
    expect(failureField({ ...state, status: 'succeeded' })).toEqual({})
    expect(failureField(null)).toEqual({})
  })
})
