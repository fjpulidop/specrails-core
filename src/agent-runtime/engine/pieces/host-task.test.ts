import { describe, expect, it, vi } from 'vitest'
import type { CandidateState, JsonObject, JsonValue, PieceExecutionContext, VerifiedState } from '../contracts.js'
import { initialDefinitionState } from '../state.js'
import { PieceRegistry } from '../piece-registry.js'
import { HOST_TASK_OUTPUT_LIMIT_BYTES, hostTaskPiece, validateHostTaskResult } from './host-task.js'
import type { PieceDependencies } from './ports.js'

function fixture(snapshot: { candidate: CandidateState | null; verified: VerifiedState | null } = { candidate: { hash: 'h1', atTransition: 1, revision: 1 }, verified: null }) {
  const deps = { executionSnapshot: () => snapshot } as unknown as PieceDependencies
  const piece = hostTaskPiece(() => deps)
  const registry = new PieceRegistry([piece])
  const requests: JsonValue[] = []
  let answer: JsonValue | undefined
  const state = initialDefinitionState()
  const context: PieceExecutionContext = { state, signal: new AbortController().signal, progress: vi.fn(),
    frame: { runId: 'run', nodePath: 'checks', scope: state.$scope, task: { checkpointThreadId: 't', checkpointId: 'c', taskCheckpointNs: '', taskId: 'task' },
      visitId: 'visit', visit: 1, transition: 3, attemptId: 'attempt', attempt: 1, leaseEpoch: 1 },
    interrupt: request => { requests.push(request as unknown as JsonValue); if (answer === undefined) throw new Error('PAUSED'); return answer } }
  const params: JsonObject = { task: 'pr.checks', input: { sha: 'abc' }, outcomes: ['green', 'red'], effect: 'read', timeoutMs: 60_000 }
  return { piece, registry, context, requests, params, answer: (value: JsonValue) => { answer = value } }
}

describe('host-task piece', () => {
  it('rejects invalid parameters', () => {
    const { registry, params } = fixture()
    expect(registry.validateParams('host-task', params, '')).toEqual([])
    for (const invalid of [
      { ...params, outcomes: ['green', 'failed'] },
      { ...params, outcomes: [] },
      { ...params, outcomes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
      { ...params, outcomes: ['green', 'green'] },
      { ...params, task: 'PR checks' },
      { ...params, effect: 'delete' },
      { ...params, unknown: true },
      { task: 'pr.checks', outcomes: ['green'] },
    ]) expect(registry.validateParams('host-task', invalid as JsonObject, '')).not.toEqual([])
  })

  it('derives outcomes and effect from its parameters', () => {
    const { registry, params } = fixture()
    expect(registry.outcomes('host-task', params)).toEqual(['green', 'red', 'failed'])
    expect(registry.effect('host-task', params, {})).toBe('read')
    expect(registry.effect('host-task', { ...params, effect: 'write' }, {})).toBe('write')
  })

  it('pauses with the task, input, outcomes and candidate attestation', async () => {
    const f = fixture({ candidate: { hash: 'h1', atTransition: 1, revision: 1 }, verified: { receiptId: 'r1', candidateHash: 'h1', atTransition: 2, revision: 1 } })
    await expect(f.piece.execute(f.params, f.context)).rejects.toThrow('PAUSED')
    expect(f.requests[0]).toEqual({ kind: 'host-task', task: 'pr.checks', input: { sha: 'abc' }, outcomes: ['green', 'red'], effect: 'read', timeoutMs: 60_000,
      candidate: { hash: 'h1', verified: true, receiptId: 'r1' }, nodePath: 'checks', scopeId: 'root', attemptId: 'attempt' })
  })

  it('commits a declared outcome with a redacted result and a history line', async () => {
    const f = fixture()
    f.answer({ outcome: 'red', output: { failures: [{ job: 'test', log: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 failed' }] } })
    const result = await f.piece.execute(f.params, f.context)
    expect(result.outcome).toBe('red')
    expect(JSON.stringify(result.output)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(result.output).toMatchObject({ task: 'pr.checks', outcome: 'red', result: { failures: [{ job: 'test' }] }, candidateHash: 'h1' })
    expect(result.history?.[0].text).toBe('Host task pr.checks: red')
    expect(f.requests[0]).toMatchObject({ candidate: { hash: 'h1', verified: false } })
  })

  it('fails the node when the host reports failed', async () => {
    const f = fixture()
    f.answer({ outcome: 'failed', output: { detail: 'gh is not authenticated' } })
    expect(await f.piece.execute(f.params, f.context)).toMatchObject({ outcome: 'failed', status: 'failed', error: { code: 'host_task_failed', message: expect.stringContaining('gh is not authenticated') } })
  })

  it('refuses an undeclared outcome, extra fields and an oversized output', async () => {
    const f = fixture()
    f.answer({ outcome: 'purple' })
    await expect(f.piece.execute(f.params, f.context)).rejects.toMatchObject({ code: 'invalid_resume' })
    expect(() => validateHostTaskResult({ outcome: 'green', extra: 1 }, ['green'])).toThrow(/unexpected extra/)
    expect(() => validateHostTaskResult('green', ['green'])).toThrow(/object/)
    expect(() => validateHostTaskResult({ outcome: 'green', output: 'x'.repeat(HOST_TASK_OUTPUT_LIMIT_BYTES + 1) }, ['green'])).toThrow(/exceeds/)
    expect(validateHostTaskResult({ outcome: 'green' }, ['green'])).toEqual({ outcome: 'green' })
  })

  it('ends failed without pausing when a verified candidate is required and missing', async () => {
    const f = fixture({ candidate: { hash: 'h2', atTransition: 1, revision: 2 }, verified: { receiptId: 'r1', candidateHash: 'h1', atTransition: 2, revision: 1 } })
    expect(await f.piece.execute({ ...f.params, requiresVerified: true }, f.context)).toMatchObject({ outcome: 'failed', status: 'failed', error: { code: 'unverified_candidate' } })
    expect(f.requests).toEqual([])
  })
})
