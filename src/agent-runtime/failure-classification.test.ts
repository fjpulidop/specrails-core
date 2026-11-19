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

  it('carries the ISO reset of a typed usage-limit refusal next to the provider\'s wording', () => {
    const result = classifyFailure({ status: 'failed', error: { code: 'provider_limit', message: "claude usage limit reached (five_hour window, resets 2026-11-18T14:00:00.000Z). You've hit your session limit · resets 3pm (Europe/Madrid)" } })
    expect(result).toMatchObject({ kind: 'provider_limit', confidence: 'high', resetsAt: '2026-11-18T14:00:00.000Z', resetAt: '3pm (Europe/Madrid)' })
    expect(classifyFailure({ status: 'failed', error: { code: 'provider_limit', message: 'claude usage limit reached (five_hour window).' } })).toMatchObject({ kind: 'provider_limit' })
    expect(classifyFailure({ status: 'failed', error: { code: 'provider_limit', message: 'claude usage limit reached (five_hour window).' } })?.resetsAt).toBeUndefined()
  })

  it('classifies a signed-out or expired provider login as an environment problem, not a crash', () => {
    // Recorded from Claude Code when its login expired mid-run.
    const expired = 'claude execution failed (exit 1). Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs'
    expect(classifyFailure({ status: 'failed', error: expired, steps: steps({ reviewer: { status: 'failed', visits: 1 } }) })).toMatchObject({ kind: 'environment', confidence: 'high', phase: 'reviewer' })
    for (const message of ['Invalid API key · Please run /login', 'codex execution failed (exit 1). Not logged in. Run codex login'])
      expect(classifyFailure({ status: 'failed', error: message })?.kind).toBe('environment')
    expect(classifyFailure({ status: 'failed', error: 'claude execution failed (exit 1). The provider did not report a diagnostic.' })?.kind).toBe('crash')
  })
  it('classifies a provider outage as provider_unavailable (contract 5.17), never a crash', () => {
    // The night of 2026-11-19: four codex architect/reviewer turns, all refused within one minute.
    const recorded = classifyFailure({ status: 'failed', recentFailures: [{ nodePath: 'architect', status: 'failed', visit: 3, error: { code: 'provider_execution_error', message: 'codex execution failed (exit 1). workspace routing discovery failed' } }],
      steps: { architect: { status: 'failed', visits: 3 }, failed: { status: 'succeeded', kind: 'end' } }, completion: { reasons: ['unverified'] } })
    expect(recorded).toMatchObject({ kind: 'provider_unavailable', phase: 'architect', resumablePhase: 'architect', confidence: 'high' })
    expect(recorded!.detail).toBe("The provider's service was unavailable for a moment (codex: workspace routing discovery failed); nothing about the work is wrong, and continuing re-runs the same step.")
    for (const message of ['codex execution failed (exit 1). stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
      'codex execution failed (exit 1). exceeded retry limit, last status: 503 Service Unavailable',
      'claude execution failed (exit 1). API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}']) {
      expect(classifyFailure({ status: 'failed', error: { code: 'provider_execution_error', message } })?.kind).toBe('provider_unavailable')
    }
    expect(classifyFailure({ status: 'failed', error: { code: 'provider_unavailable', message: 'codex execution failed (exit 1). workspace routing discovery timed out' } })?.kind).toBe('provider_unavailable')
  })

  it('keeps a limit, a sign-out and a failing test that mentions a network error out of provider_unavailable', () => {
    expect(classifyFailure({ status: 'failed', error: { code: 'provider_execution_error', message: 'codex execution failed (exit 1). exceeded retry limit, last status: 429 Too Many Requests' } })?.kind).toBe('provider_limit')
    expect(classifyFailure({ status: 'failed', error: { code: 'provider_execution_error', message: 'codex execution failed (exit 1). workspace routing discovery unauthorized (401)' } })?.kind).toBe('environment')
    expect(classifyFailure({ status: 'failed', error: { code: 'verification_failed', message: 'Verification failed: npm test exited 1 — Error: connect ECONNRESET 127.0.0.1:5432' } })?.kind).toBe('tests_failed')
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

  it('classifies a verification command stopped by its limits as timeout, not as environment or agent inactivity', () => {
    const silent = 'A verification command failed: Verification command produced no output for 5 min and was stopped: a test is probably hanging'
    expect(classifyFailure({ status: 'failed', error: { code: 'verification_timeout', message: silent } })).toMatchObject({ kind: 'timeout', confidence: 'high', detail: silent })
    expect(classifyFailure({ status: 'failed', error: silent })?.kind).toBe('timeout')
    expect(classifyFailure({ status: 'failed', error: { code: 'verification_timeout', message: 'A verification command failed: Verification command timed out' } })?.kind).toBe('timeout')
    expect(classifyFailure({ status: 'failed', error: { code: 'verification_execution_error', message: 'A verification command failed: Verification command was killed by SIGKILL from outside the runner' } })?.kind).toBe('environment')
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

  it('counts fixer turns as correction rounds, not the recipe bookkeeping nodes around them', () => {
    const result = classifyFailure({ status: 'failed', completion: { reasons: ['Fixer reported a host blocker (environment-variable): export API_TOKEN Evidence: missing'] }, steps: {
      'correction-context': { kind: 'condition', status: 'succeeded', visits: 1 }, 'correction-budget': { kind: 'condition', status: 'succeeded', visits: 1 },
      'begin-correction': { kind: 'assign', status: 'succeeded', visits: 1 }, fixer: { kind: 'role-turn', status: 'succeeded', visits: 1 },
      'correction-blocker': { kind: 'condition', status: 'succeeded', visits: 1 }, 'fixer-blocker-kind': { kind: 'condition', status: 'succeeded', visits: 1 },
      'fixer-blocked': { kind: 'end', status: 'succeeded', visits: 1 } } })
    expect(result).toMatchObject({ kind: 'environment', rounds: 1 })
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
    expect(providerLimitReset('resets in 2 hours.')).toBe('in 2 hours')
    expect(providerLimitReset('no hint here')).toBeUndefined()
  })
})

describe('providerLimitReset', () => {
  it('reads the codex "try again at" wording and keeps the relative "in"', () => {
    expect(providerLimitReset('codex execution failed (exit 1). You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:32 AM.')).toBe('3:32 AM')
    expect(providerLimitReset("You've reached your usage limit. Try again in 2 hours.")).toBe('in 2 hours')
    expect(providerLimitReset("You've hit your session limit · resets 3am (Europe/Madrid)")).toBe('3am (Europe/Madrid)')
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

describe('definition end-node failures (contract 5.15)', () => {
  // The completion a real Implement run (tetrisex #14) ended with: no error, a failure end node.
  const stalled = 'The developer made no changes while approved tasks are still incomplete. Incomplete: ["4.1 README: the visual-review note [manual] needs a browser check"]. Developer summary: 8 of 9 tasks are done.'
  const steps = { developer: { kind: 'role-turn', status: 'succeeded', visits: 2 }, 'implementation-stalled': { kind: 'end', status: 'succeeded', visits: 1 } }
  it('names incomplete tasks with the list the end reason carries and the end node as phase', () => {
    expect(definitionFailure({ status: 'failed', steps }, { ok: false, reasons: [stalled, 'unverified'] })).toEqual({ failure: {
      kind: 'incomplete_tasks', phase: 'implementation-stalled', detail: expect.stringContaining('approved tasks are still incomplete'),
      incompleteTasks: ['4.1 README: the visual-review note [manual] needs a browser check'], confidence: 'high' } })
    const exhausted = 'Implementation attempt limit reached (3/3) with approved tasks still incomplete. Incomplete: not a list. Developer summary: x'
    expect(classifyFailure({ status: 'failed', completion: { reasons: [exhausted] } })).toMatchObject({ kind: 'incomplete_tasks', confidence: 'high' })
    expect(classifyFailure({ status: 'failed', completion: { reasons: [exhausted] } })?.incompleteTasks).toBeUndefined()
  })
  it('maps every documented end reason to a known kind', () => {
    const cases: Array<[string, string]> = [
      ['The plan for change x still fails OpenSpec validation or the plan contract after 2 repair(s), so it was not implemented.', 'spec_invalid'],
      ['OpenSpec could not archive change x. The implementation was verified and reviewed.', 'spec_invalid'],
      ['Not implemented: the person declined this ticket for this repository. Reason: wrong repository', 'spec_invalid'],
      ['Automatic correction made no candidate changes. Host verification is valid: true.', 'blocked'],
      ['Automatic correction limit reached (3/3). Acceptance policy: approved == true', 'blocked'],
      ['Developer reported a host blocker (credential): log in Evidence: 401', 'environment'],
      ['Fixer reported a host blocker (network): allow npm Evidence: ENOTFOUND', 'environment'],
      ['Host blocker (toolchain): docker is missing Required action: install docker', 'environment'],
    ]
    for (const [reason, kind] of cases) expect(classifyFailure({ status: 'failed', completion: { reasons: [reason] } }), reason).toMatchObject({ kind, confidence: 'high' })
    expect(classifyFailure({ status: 'failed', completion: { reasons: ['unverified'], blocker: { kind: 'toolchain' } } })).toMatchObject({ kind: 'environment' })
    expect(classifyFailure({ status: 'failed', completion: { reasons: ['something new'] } })).toMatchObject({ kind: 'unknown', confidence: 'low' })
  })
})

describe('restart-interrupted attempts (owner_lost)', () => {
  const ownerLost = { nodePath: 'reviewer', status: 'interrupted', error: { code: 'owner_lost', message: 'Previous executor did not settle this attempt' } }
  const steps = { reviewer: { kind: 'role-turn', status: 'succeeded', visits: 3 }, 'correction-stalled': { kind: 'end', status: 'succeeded', visits: 1 } }
  it('explains a run that later ended at a failure end node by that end, not the attempt a restart cut off', () => {
    const result = classifyFailure({ status: 'failed', steps, recentFailures: [ownerLost], completion: { reasons: ['Automatic correction made no candidate changes. Host verification is valid: true.', 'unverified'] } })
    expect(result).toMatchObject({ kind: 'blocked', phase: 'correction-stalled', detail: expect.stringContaining('Automatic correction made no candidate changes') })
    expect(result?.detail).not.toMatch(/did not settle/)
  })
  it('prefers a real failed attempt over an older restart interruption', () => {
    const tests = { nodePath: 'fixer', status: 'failed', error: { code: 'tests_failed', message: 'Tests still fail after 3 rounds' } }
    expect(classifyFailure({ status: 'failed', recentFailures: [ownerLost, tests] })).toMatchObject({ phase: 'fixer', detail: expect.stringContaining('Tests still fail') })
  })
  it('still reports the interruption when it is the only signal', () => {
    expect(classifyFailure({ status: 'failed', recentFailures: [ownerLost] })).toMatchObject({ phase: 'reviewer', detail: expect.stringContaining('did not settle') })
  })
})

describe('workflow protocol failures (contract 5.16)', () => {
  // The step error engine 2 records when a role skipped its OpenSpec steps twice (benchmark S16/S17/S18).
  const message = 'Required OpenSpec role workflow was not executed: plan must execute openspec-ff-change (missing instructions tasks); the plan model (claude/haiku) skipped the required OpenSpec steps again after one corrective reminder'
  it('names the role, the model and the skipped steps, and resumes the role', () => {
    const result = classifyFailure({ status: 'failed', nextStep: 'architect', completion: { reasons: ['unverified'] },
      recentFailures: [{ nodePath: 'architect', status: 'failed', error: { code: 'openspec_workflow_omitted', message } }],
      steps: { architect: { kind: 'role-turn', status: 'failed', visits: 1 }, failed: { kind: 'end', status: 'succeeded', visits: 1 } } })
    expect(result).toEqual({ kind: 'workflow_protocol', phase: 'architect', role: 'plan', provider: 'claude', model: 'haiku', missingSteps: ['instructions tasks'],
      detail: 'The plan model (claude/haiku) skipped the required OpenSpec steps (instructions tasks) even after a corrective reminder.', resumablePhase: 'architect', confidence: 'high' })
  })
  it('keeps a provider-qualified model id whole and reads an engine 1 run error without a model clause', () => {
    expect(classifyFailure({ status: 'failed', error: message.replace('claude/haiku', 'router/vendor/small-model') })).toMatchObject({ provider: 'router', model: 'vendor/small-model' })
    const legacy = classifyFailure({ status: 'failed', error: 'Required OpenSpec role workflow was not executed: architect must execute openspec-ff-change (missing load_skill, instructions tasks)', steps: steps({ architect: { status: 'failed', visits: 1 } }) })
    expect(legacy).toMatchObject({ kind: 'workflow_protocol', role: 'architect', missingSteps: ['load_skill', 'instructions tasks'], resumablePhase: 'architect', confidence: 'high' })
    expect(legacy?.provider).toBeUndefined()
    expect(legacy?.detail).toBe('The architect model skipped the required OpenSpec steps (load_skill, instructions tasks) even after a corrective reminder.')
  })
  it('uses the typed code alone when the message is not the documented sentence', () => {
    expect(classifyFailure({ status: 'failed', error: { code: 'openspec_workflow_omitted', message: 'something else' } }))
      .toMatchObject({ kind: 'workflow_protocol', detail: 'The model skipped the required OpenSpec steps even after a corrective reminder.' })
    expect(FAILURE_KINDS).toContain('workflow_protocol')
  })
})
