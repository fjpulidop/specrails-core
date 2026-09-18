import { describe, expect, it } from 'vitest'
import { developerVisitsSinceResume, fixerVisitsSinceResume } from './nodes.js'
import type { WorkflowState } from '../workflow-types.js'

type Attempt = { stepId: string; startedAt: string; output?: unknown }
function checkpoint(history: Attempt[], events: Array<{ type: string; timestamp: string }> = []): WorkflowState {
  return { events, history } as unknown as WorkflowState
}
const verifyFailed = { valid: false, receiptId: 'r1' }
const verifyContinuation = { valid: false, incompleteTasks: ['3.1'] }
const history: Attempt[] = [
  { stepId: 'architect', startedAt: '01' },
  { stepId: 'developer', startedAt: '02' }, // first implementation visit
  { stepId: 'verify', startedAt: '03', output: verifyContinuation },
  { stepId: 'developer', startedAt: '04' }, // continuation of unchecked tasks: developer, not a correction
  { stepId: 'verify', startedAt: '05', output: verifyFailed },
  { stepId: 'fixer', startedAt: '06' }, // correction 1
  { stepId: 'verify', startedAt: '07', output: verifyFailed },
  { stepId: 'fixer', startedAt: '08' }, // correction 2
  { stepId: 'reviewer', startedAt: '09', output: {} },
  { stepId: 'fixer', startedAt: '10' }, // correction 3
]

describe('implementation budgets', () => {
  it('corrections are fixer visits; developer visits are first passes and continuations', () => {
    expect(fixerVisitsSinceResume(checkpoint(history))).toBe(3)
    expect(developerVisitsSinceResume(checkpoint(history))).toBe(2)
  })
  it('an explicit resume grants a fresh budget to both nodes', () => {
    const resumed = checkpoint(history, [{ type: 'workflow_resumed', timestamp: '07' }])
    expect(fixerVisitsSinceResume(resumed)).toBe(2)
    expect(developerVisitsSinceResume(resumed)).toBe(0)
  })
})
