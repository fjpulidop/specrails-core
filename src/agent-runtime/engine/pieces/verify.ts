import { contentDigest } from '../canonical-json.js'
import { advisoryMemory } from './project-memory.js'
import { executeVerification, validateVerificationRequest, type VerificationCommand, type VerificationReceipt } from '../../../pipeline/pipeline-state.js'
import { withScopeDefault } from '../../change-scope.js'
import type { Piece, PieceExecutionContext, ReceiptEvidence } from '../contracts.js'
import type { PieceDependencies, PieceDependencyProvider } from './ports.js'
import { json, paramsSchema, positiveInteger } from './shared.js'

export const verificationCommandSchema = paramsSchema({
  repositoryId: { type: 'string', minLength: 1, maxLength: 128 }, command: { type: 'string', minLength: 1, maxLength: 4096 },
  args: { type: 'array', maxItems: 1024, items: { type: 'string', maxLength: 32_000 } }, cwd: { type: 'string', maxLength: 4096 },
  env: { type: 'object', additionalProperties: { type: 'string', maxLength: 32_000 } }, timeoutMs: { ...positiveInteger, maximum: 7_200_000 },
  key: { type: 'string', maxLength: 128 }, label: { type: 'string', minLength: 1, maxLength: 256 }, policy: { type: 'object' },
}, ['repositoryId', 'command', 'args'])

export function receiptEvidence(receipt: VerificationReceipt): ReceiptEvidence {
  return { id: receipt.id, candidateHash: receipt.candidateHash, valid: receipt.valid, scope: receipt.kind, evidence: json(receipt) }
}

export function verificationDeadline(deps: PieceDependencies, context: PieceExecutionContext): number | undefined {
  const budget = deps.stepContext(context).remainingBudget()
  return budget.maxDurationMs === undefined ? undefined : Date.now() + Math.max(0, budget.maxDurationMs)
}

export function verifyPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'verify', paramsSchema: paramsSchema({ commands: { oneOf: [{ const: 'configured' }, { type: 'array', maxItems: 100, items: verificationCommandSchema }] },
      unverified: { type: 'boolean' }, maxConcurrency: { type: 'integer', minimum: 1, maximum: 4 } }, ['commands']), outcomes: ['pass', 'fail', 'failed'], effect: 'write', requiresAI: false, storeAccess: 'write' },
    async execute(params, context) {
      const deps = bindings()
      const commands = (params.commands === 'configured' ? deps.config.verification : params.commands as unknown as VerificationCommand[]).map(command => withScopeDefault(deps.context, command))
      const coversAll = deps.context.repositories.every(repository => commands.some(command => command.repositoryId === repository.id))
      const request = { kind: coversAll || params.unverified === true ? 'full' as const : 'scoped' as const, commands, ...(params.unverified === true ? { unverified: true } : {}) }
      validateVerificationRequest(deps.context, request)
      const identity = { candidateHash: deps.executionSnapshot(context).candidate?.hash ?? null, scopeId: context.frame.scope.id,
        repositories: deps.context.repositories.map(repository => ({ id: repository.id, path: repository.path })),
        planHash: contentDigest(json(request)), concurrency: (params.maxConcurrency as number | undefined) ?? deps.config.efficiency?.verification?.maxConcurrency ?? 1 }
      const memoryKey = contentDigest(identity)
      const known = await advisoryMemory(context, () => deps.memory(context).get(['verification', 'known-commands'], memoryKey))
      const receipt = await executeVerification(deps.context, request, deps.verification(context),
        output => context.progress({ type: 'verification-output', payload: { text: output } }), context.signal, {
          deadline: verificationDeadline(deps, context), maxConcurrency: (params.maxConcurrency as number | undefined) ?? deps.config.efficiency?.verification?.maxConcurrency,
          idleTimeoutMs: deps.config.guardrails?.['verify-idle-timeout'] === false ? 0 : undefined,
          onEvidence: async (kind, payload) => context.progress({ type: 'runtime-efficiency-event', payload: { kind, ...payload } }),
        })
      await advisoryMemory(context, () => deps.memory(context).put(['verification', 'known-commands'], memoryKey, {
        ...identity, observations: Math.min(1_000_000, typeof known?.value.observations === 'number' ? known.value.observations + 1 : 1),
        lastAttemptId: context.frame.attemptId, lastReceiptId: receipt.id, lastValid: receipt.valid,
        commands: receipt.commands.map(command => ({ repositoryId: command.repositoryId, command: command.command, exitCode: command.exitCode })),
      }))
      const infrastructure = receipt.commands.some(command => command.exitCode === -1 && command.outcome !== 'cancelled')
      const outcome = infrastructure ? 'failed' : receipt.valid ? 'pass' : 'fail'
      const verified = receipt.valid && receipt.commands.length > 0 && !receipt.unverifiedRepositories?.length
      return { outcome, ...(infrastructure ? { status: 'failed' as const, error: { code: 'verification_execution_error', message: receipt.reason ?? 'A verification command could not complete' } } : {}),
        output: { receiptId: receipt.id, valid: receipt.valid, ...(receipt.reason ? { reason: receipt.reason } : {}), commands: receipt.commands.map(command => ({ repositoryId: command.repositoryId, command: command.command, exitCode: command.exitCode })) },
        receipt: receiptEvidence(receipt), ...(verified ? { verified: { receiptId: receipt.id, candidateHash: receipt.candidateHash, atTransition: context.frame.transition, revision: context.frame.transition } } : { verified: null }) }
    },
  }
}
