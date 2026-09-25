import { describe, expect, it } from 'vitest'
import { describeFailure, divergence, outcomesSinceResume, unchangedFailure, type VerifyOutcome } from './convergence.js'
import type { WorkflowState } from '../workflow-types.js'

const command = (output: string, exitCode = 1) => ({ repositoryId: 'app', command: 'yarn', args: ['test'], cwd: '/w/app', exitCode, output, key: 'host:0', label: 'yarn test' }) as never
const failed = (signature: string, candidateHash = signature + '-candidate'): VerifyOutcome => ({ at: '2026-09-25T10:00:00.000Z', candidateHash, planHash: 'plan', passed: false, signature, summary: signature })
const passed = (candidateHash: string): VerifyOutcome => ({ at: '2026-09-25T10:00:00.000Z', candidateHash, planHash: 'plan', passed: true })

describe('describeFailure', () => {
  it('ignores timings, temporary paths and hashes, so the same failure keeps one identity', () => {
    const first = describeFailure({ commands: [command('PASS a (12 ms)\nFAIL /w/app/src/nav.spec.ts\n  ✕ collapses at 900px (35 ms)\nTests: 1 failed, 20 passed\nTime: 3.2 s')], reason: 'A verification command failed' }, ['/w/app'])
    const second = describeFailure({ commands: [command('PASS a (9 ms)\nFAIL /w/app/src/nav.spec.ts\n  ✕ collapses at 900px (41 ms)\nTests: 1 failed, 20 passed\nTime: 4.8 s')], reason: 'A verification command failed' }, ['/w/app'])
    const other = describeFailure({ commands: [command('FAIL /w/app/src/nav.spec.ts\n  ✕ expands at 1200px (35 ms)')], reason: 'A verification command failed' }, ['/w/app'])
    expect(first.signature).toBe(second.signature)
    expect(other.signature).not.toBe(first.signature)
    expect(first.summary).toBe('yarn test exited 1: Tests: 1 failed, 20 passed')
    expect(describeFailure({ commands: [], reason: 'Candidate changed during verification' }, []).summary).toBe('Candidate changed during verification')
  })
})

describe('divergence', () => {
  it('lets a changing failure take another round', () => {
    expect(divergence([failed('a')], failed('b'))).toBeUndefined()
    expect(divergence([failed('a')], failed('a', 'new-candidate'))).toBeUndefined()
  })
  it('stops when a round returns to a candidate that already failed', () => {
    expect(divergence([failed('a', 'c1'), passed('c2')], failed('b', 'c1'))).toContain('already failed verification')
  })
  it('stops when the same failure survives two correction rounds', () => {
    expect(divergence([failed('a', 'c1'), failed('a', 'c2')], failed('a', 'c3'))).toContain('survived 2 correction rounds')
    expect(divergence([failed('a', 'c1'), failed('b', 'c2')], failed('a', 'c3'))).toBeUndefined()
  })
  it('stops when a review correction brings back a failure an earlier round had fixed', () => {
    expect(divergence([failed('a', 'c1'), passed('c2')], failed('a', 'c3'))).toContain('review correction brought back')
    expect(divergence([passed('c2')], failed('a', 'c3'))).toBeUndefined()
  })
  it('never stops on a pass', () => {
    expect(divergence([failed('a', 'c1'), failed('a', 'c2')], passed('c1'))).toBeUndefined()
  })
})

describe('history windows', () => {
  it('counts only outcomes since the latest explicit resume and finds an unchanged failed candidate', () => {
    const checkpoint = { events: [{ type: 'workflow_resumed', timestamp: '2026-09-25T11:00:00.000Z' }] } as unknown as WorkflowState
    const old = failed('a', 'c1')
    const fresh = { ...failed('a', 'c2'), at: '2026-09-25T11:05:00.000Z' }
    expect(outcomesSinceResume([old, fresh], checkpoint)).toEqual([fresh])
    expect(outcomesSinceResume([old], { events: [] } as unknown as WorkflowState)).toEqual([old])
    expect(unchangedFailure([old, fresh], 'c2', 'plan')).toBe(fresh)
    expect(unchangedFailure([old, fresh], 'c2', 'other-plan')).toBeUndefined()
    expect(unchangedFailure([passed('c3')], 'c3', 'plan')).toBeUndefined()
  })
})
