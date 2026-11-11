import { redactSecrets, redactSecretsDeep } from '../../../shared/secret-redaction.js'
import { canonicalJson } from '../canonical-json.js'
import { EngineError, type EngineEffect, type HostTaskInterrupt, type HostTaskResult, type JsonObject, type JsonValue, type Piece } from '../contracts.js'
import type { PieceDependencyProvider } from './ports.js'
import { historyEntry, json, paramsSchema, positiveInteger, text } from './shared.js'

/** Host task names: lowercase, dot-namespaced (`pr.checks`). */
export const HOST_TASK_PATTERN = '^[a-z0-9][a-z0-9.-]{0,63}$'
/** Largest canonical JSON a host may return as `output`. */
export const HOST_TASK_OUTPUT_LIMIT_BYTES = 256 * 1024
export const HOST_TASK_MAX_OUTCOMES = 8
const OUTCOME = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$', not: { enum: ['failed'] } } satisfies JsonObject

const declaredOutcomes = (params: JsonObject): string[] => Array.isArray(params.outcomes) ? params.outcomes.filter((value): value is string => typeof value === 'string') : []

/**
 * Validate a host's result against the interrupt it answers. Shared by the
 * resume admission (before anything is persisted) and the piece itself.
 */
export function validateHostTaskResult(value: unknown, outcomes: readonly string[]): HostTaskResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EngineError('invalid_resume', 'A host result must be an object { outcome, output? }')
  const record = value as Record<string, unknown>
  const extra = Object.keys(record).filter(key => key !== 'outcome' && key !== 'output')
  if (extra.length) throw new EngineError('invalid_resume', 'A host result accepts only outcome and output; unexpected ' + extra.join(', '))
  if (typeof record.outcome !== 'string' || !(record.outcome === 'failed' || outcomes.includes(record.outcome))) {
    throw new EngineError('invalid_resume', `Host result outcome must be one of ${[...outcomes, 'failed'].join(', ')}`)
  }
  if (record.output !== undefined && Buffer.byteLength(canonicalJson(record.output)) > HOST_TASK_OUTPUT_LIMIT_BYTES) {
    throw new EngineError('invalid_resume', `Host result output exceeds ${HOST_TASK_OUTPUT_LIMIT_BYTES} bytes`)
  }
  return { outcome: record.outcome, ...(record.output !== undefined ? { output: json(record.output) } : {}) }
}

export function hostTaskPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: {
      kind: 'host-task',
      paramsSchema: paramsSchema({
        task: { type: 'string', pattern: HOST_TASK_PATTERN },
        input: { type: 'object' },
        outcomes: { type: 'array', minItems: 1, maxItems: HOST_TASK_MAX_OUTCOMES, uniqueItems: true, items: OUTCOME },
        effect: { enum: ['read', 'write'] },
        timeoutMs: { ...positiveInteger },
        requiresVerified: { type: 'boolean' },
      }, ['task', 'outcomes', 'effect']),
      outcomes: ['failed'],
      effect: 'derived',
      requiresAI: false,
      storeAccess: 'none',
    },
    getOutcomes: params => [...declaredOutcomes(params), 'failed'],
    getEffect: params => params.effect === 'write' ? 'write' : 'read',
    async execute(params, context) {
      const task = text(params.task), outcomes = declaredOutcomes(params)
      const { candidate, verified } = bindings().executionSnapshot(context)
      const current = verified !== null && candidate !== null && verified.candidateHash === candidate.hash
      if (params.requiresVerified === true && !current) {
        return { outcome: 'failed', status: 'failed', output: { task, outcome: 'failed', result: { detail: 'The current candidate has no current verification' } },
          error: { code: 'unverified_candidate', message: `Host task ${task} requires a verified candidate` } }
      }
      const request: HostTaskInterrupt = {
        kind: 'host-task', task,
        input: (params.input && typeof params.input === 'object' && !Array.isArray(params.input) ? params.input : {}) as JsonObject,
        outcomes, effect: (params.effect === 'write' ? 'write' : 'read') as EngineEffect,
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        candidate: { hash: candidate?.hash ?? null, verified: current, ...(current && verified ? { receiptId: verified.receiptId } : {}) },
        nodePath: context.frame.nodePath, scopeId: context.frame.scope.id, attemptId: context.frame.attemptId,
      }
      // Pauses the run (no process, no lease) until the host answers by interrupt id.
      const answer = context.interrupt(request as unknown as Parameters<typeof context.interrupt>[0])
      const result = validateHostTaskResult(answer, outcomes)
      const output: JsonValue = result.output === undefined ? null : redactSecretsDeep(result.output)
      // Re-executed on resume, so this is the candidate AFTER the host's effect:
      // definitions compare it with a later role turn's hash to detect progress.
      const committed = { task, outcome: result.outcome, result: output, candidateHash: candidate?.hash ?? null }
      const history = [historyEntry(context, `Host task ${task}: ${result.outcome}`)]
      if (result.outcome === 'failed') {
        const detail = output && typeof output === 'object' && !Array.isArray(output) && typeof output.detail === 'string' ? output.detail : 'The host reported a failure'
        return { outcome: 'failed', status: 'failed', output: committed, history, error: { code: 'host_task_failed', message: redactSecrets(`Host task ${task} failed: ${detail}`).slice(0, 4000) } }
      }
      return { outcome: result.outcome, output: committed, history }
    },
  }
}
