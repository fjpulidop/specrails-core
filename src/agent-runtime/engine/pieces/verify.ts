import { stripVTControlCharacters } from 'node:util'
import { contentDigest } from '../canonical-json.js'
import { advisoryMemory } from './project-memory.js'
import { executeVerification, validateVerificationRequest, type VerificationCommand, type VerificationReceipt } from '../../../pipeline/pipeline-state.js'
import { withScopeDefault } from '../../change-scope.js'
import type { Piece, PieceExecutionContext, ReceiptEvidence } from '../contracts.js'
import type { PieceDependencies, PieceDependencyProvider } from './ports.js'
import { boundedText, json, paramsSchema, positiveInteger } from './shared.js'

/** Keep real subprocess diagnostics in committed outputs for subsequent agents.
 * The full command evidence remains in the receipt; prioritize failed checks
 * when the output budget is exhausted. */
function verificationDiagnostics(receipt: VerificationReceipt) {
  let remaining = 32_000
  const outputs = new Map<number, string>()
  const priority = receipt.commands.map((command, index) => ({ command, index }))
    .sort((a, b) => Number(b.command.exitCode !== 0) - Number(a.command.exitCode !== 0))
  for (const { command, index } of priority) {
    const limit = Math.min(8_000, remaining)
    const source = stripVTControlCharacters([command.stdout ?? '', command.stderr ?? '', command.output].join('\n'))
    const lines = source.split('\n')
    const failures: string[] = []
    let used = 0
    for (let i = 0; command.exitCode !== 0 && i < lines.length && used < 6_000; i++) {
      if (!/^\s*(?:not ok\b|FAIL\b|Error:|AssertionError\b|error:)/.test(lines[i])) continue
      const excerpt = lines.slice(Math.max(0, i - 2), i + 28).join('\n').slice(0, 6_000 - used)
      failures.push(excerpt)
      used += excerpt.length
      i += 27
    }
    const failureText = failures.join('\n').slice(0, Math.min(6_000, limit))
    const tailBudget = Math.max(0, limit - failureText.length - (failureText ? 1 : 0))
    const output = failureText + (failureText && tailBudget ? '\n' : '') + (tailBudget ? command.output.slice(-tailBudget) : '')
    // slice(-0) would include all the original text.
    outputs.set(index, remaining > 0 ? output : '')
    remaining -= remaining > 0 ? output.length : 0
  }
  let budget = 64_000
  const commands = []
  for (const { index, command } of priority) {
    const output = outputs.get(index) ?? ''
    const args = command.args.slice(0, 16).map(arg => boundedText(arg, 128))
    const diagnostic = { repositoryId: command.repositoryId, command: boundedText(command.command, 512),
      args, cwd: boundedText(command.cwd, 512),
      exitCode: command.exitCode, durationMs: command.durationMs, output,
      truncated: output.length < command.output.length || command.outputTruncated === true
        || command.command.length > 512 || command.cwd.length > 512 || command.args.length > 16 || command.args.some(arg => arg.length > 128) }
    const size = JSON.stringify(diagnostic).length
    if (size > budget) break
    budget -= size
    commands.push(diagnostic)
  }
  return { commands, ...(commands.length < receipt.commands.length ? { omittedCommands: receipt.commands.length - commands.length } : {}) }
}

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
      additionalCommandsFrom: { type: 'string', minLength: 1, maxLength: 128 }, unverified: { type: 'boolean' }, maxConcurrency: { type: 'integer', minimum: 1, maximum: 4 } }, ['commands']), outcomes: ['pass', 'fail', 'failed'], effect: 'write', requiresAI: false, storeAccess: 'write' },
    async execute(params, context) {
      const deps = bindings()
      const commands = (params.commands === 'configured' ? deps.config.verification : params.commands as unknown as VerificationCommand[]).map(command => withScopeDefault(deps.context, command))
      const hostRepositories = new Set(commands.map(command => command.repositoryId))
      if (typeof params.additionalCommandsFrom === 'string') {
        const source = context.state.$outputs[params.additionalCommandsFrom] as { structured?: { verification?: unknown } } | undefined
        const proposals = source?.structured?.verification
        if (!Array.isArray(proposals) || proposals.length > 20) throw new Error('Verification proposals must be a bounded array from a committed agent output')
        // Host checks always stay mandatory. The same scoped command validation
        // applies to these actual subprocesses and to configured checks below.
        for (const proposal of proposals) {
          if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error('Invalid verification proposal')
          const raw = proposal as VerificationCommand
          if (!deps.context.repositories.some(repository => repository.id === raw.repositoryId)) throw new Error('Unknown verification repository')
          if (!hostRepositories.has(raw.repositoryId)) commands.push(withScopeDefault(deps.context, raw))
        }
      }
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
      const progressKey = 'verification-' + contentDigest(context.frame.nodePath).slice(0, 20)
      const fingerprint = contentDigest(json({ candidateHash: identity.candidateHash,
        failures: receipt.commands.filter(command => command.exitCode !== 0).map(command => ({ repositoryId: command.repositoryId, command: command.command, args: command.args, cwd: command.cwd, exitCode: command.exitCode })) }))
      const previous = context.state.$vars[progressKey] as { fingerprint?: string; count?: number } | undefined
      const count = receipt.valid ? 0 : previous?.fingerprint === fingerprint ? (previous.count ?? 0) + 1 : 1
      const stalled = !infrastructure && !receipt.valid && count >= 3
      const verified = receipt.valid && receipt.commands.length > 0 && !receipt.unverifiedRepositories?.length
      return { outcome: stalled ? 'failed' : outcome, vars: { [progressKey]: { fingerprint, count } }, ...(stalled ? { status: 'failed' as const, error: { code: 'verification_no_progress', message: 'Verification failed three times on the same unchanged candidate. Stopping automatic corrections; inspect the failed checks.' } } : {}), ...(infrastructure ? { status: 'failed' as const, error: { code: 'verification_execution_error', message: receipt.reason ?? 'A verification command could not complete' } } : {}),
        output: { receiptId: receipt.id, valid: receipt.valid, candidateHash: identity.candidateHash, noProgressCount: count, ...(receipt.reason ? { reason: receipt.reason } : {}), ...(stalled ? { reason: 'Verification failed three times without candidate changes' } : {}), ...verificationDiagnostics(receipt) },
        receipt: receiptEvidence(receipt), ...(verified ? { verified: { receiptId: receipt.id, candidateHash: receipt.candidateHash, atTransition: context.frame.transition, revision: context.frame.transition } } : { verified: null }) }
    },
  }
}
