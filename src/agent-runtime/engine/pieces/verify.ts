import { stripVTControlCharacters } from 'node:util'
import { contentDigest } from '../canonical-json.js'
import { advisoryMemory } from './project-memory.js'
import { executeVerification, validateVerificationRequest, type CommandReceipt, type VerificationCommand, type VerificationReceipt } from '../../../pipeline/pipeline-state.js'
import { withScopeDefault } from '../../change-scope.js'
import { verificationDiagnosticPriority, verificationFailureSummary } from '../../verification-diagnostics.js'
import type { HostBlocker, JsonObject, Piece, PieceExecutionContext, PieceResult, ReceiptEvidence } from '../contracts.js'
import type { PieceDependencies, PieceDependencyProvider } from './ports.js'
import { boundedText, json, paramsSchema, positiveInteger } from './shared.js'
import { isEnvironmentFailure } from '../../compact/environment.js'
import { guardrailEnabled } from '../../guardrails.js'
import { checkoutRelative, preconditionBlock, repairEnvironment } from '../../verification-repair.js'

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
    // Reserve the bounded facts before contextual blocks: a source dump or a
    // long warning next to the first failure must not hide later diagnostics.
    const failures = command.exitCode !== 0 ? verificationFailureSummary(command) : []
    let used = failures.reduce((total, line) => total + line.length + 1, 0)
    const anchors = command.exitCode !== 0 ? lines.map((line, index) => ({ line, index, priority: verificationDiagnosticPriority(line) }))
      .filter((anchor): anchor is { line: string; index: number; priority: number } => anchor.priority !== undefined)
      .sort((a, b) => a.priority - b.priority || a.index - b.index) : []
    const selected = new Set<string>()
    for (const { line, index } of anchors) {
      if (used >= 6_000) break
      if (selected.has(line.trim())) continue
      selected.add(line.trim())
      const excerpt = lines.slice(Math.max(0, index - 2), index + 28).join('\n').slice(0, 6_000 - used)
      failures.push(excerpt)
      used += excerpt.length + 1
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
      ...(command.evidenceId ? { evidenceId: boundedText(command.evidenceId, 128) } : {}),
      ...(command.exitCode !== 0 ? { failureSummary: verificationFailureSummary(command) } : {}),
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

const VERIFY_OUTCOMES = ['pass', 'fail', 'failed'] as const
const verificationCommandList = { type: 'array', maxItems: 100, items: verificationCommandSchema } satisfies JsonObject

/**
 * The complete host plan for a `verify` node: configured checks (or the inline
 * list) plus the proposals of the node named in `additionalCommandsFrom` for
 * repositories without a configured check. Role turns show write roles this
 * same list, so the developer never passes a check the host does not run.
 */
export function resolveVerificationPlan(deps: PieceDependencies, context: PieceExecutionContext, params: JsonObject): VerificationCommand[] {
  const configured = params.commands === undefined || params.commands === 'configured' ? deps.config.verification : params.commands as unknown as VerificationCommand[]
  const commands = configured.map(command => withScopeDefault(deps.context, command))
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
  return commands
}

/** A setup command that exited non-zero: the host declared it, so only the host can fix or remove it. */
function setupBlocker(deps: PieceDependencies, command: CommandReceipt): HostBlocker {
  const cwd = checkoutRelative(deps.context, command.cwd)
  return { kind: 'setup', reason: `the setup command \`${[command.command, ...command.args].join(' ')}\` failed in ${cwd} (exit ${command.exitCode})`, command: command.command, args: command.args, cwd,
    requiredAction: `Fix or remove the setup command \`${[command.command, ...command.args].join(' ')}\` in the runtime configuration, then retry the run.`, ...(command.evidenceId ? { evidenceId: command.evidenceId } : {}) }
}

export function verifyPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'verify', paramsSchema: paramsSchema({ commands: { oneOf: [{ const: 'configured' }, verificationCommandList] },
      additionalCommandsFrom: { type: 'string', minLength: 1, maxLength: 128 }, unverified: { type: 'boolean' }, maxConcurrency: { type: 'integer', minimum: 1, maximum: 4 },
      setup: { oneOf: [{ const: 'configured' }, verificationCommandList] }, hostBlockers: { type: 'boolean' } }, ['commands']), outcomes: [...VERIFY_OUTCOMES, 'blocked'], effect: 'write', requiresAI: false, storeAccess: 'write' },
    // `blocked` is opt-in so definitions published before host blockers keep their exact `ends`.
    getOutcomes: params => params.hostBlockers === true ? [...VERIFY_OUTCOMES, 'blocked'] : VERIFY_OUTCOMES,
    async execute(params, context) {
      const deps = bindings()
      const commands = resolveVerificationPlan(deps, context, params)
      const coversAll = deps.context.repositories.every(repository => commands.some(command => command.repositoryId === repository.id))
      const request = { kind: coversAll || params.unverified === true ? 'full' as const : 'scoped' as const, commands, ...(params.unverified === true ? { unverified: true } : {}) }
      validateVerificationRequest(deps.context, request)
      // Setup is validated before anything runs: a setup entry escaping the workspace fails exactly like a check would.
      const setupCommands = (params.setup === 'configured' ? deps.config.setup ?? [] : (params.setup as unknown as VerificationCommand[] | undefined) ?? [])
        .map(({ policy: _policy, ...command }) => withScopeDefault(deps.context, command))
      const setupRequest = { kind: 'scoped' as const, commands: setupCommands }
      if (setupCommands.length) validateVerificationRequest(deps.context, setupRequest)
      const progress = (text: string): void => context.progress({ type: 'verification-output', payload: { text } })
      const concurrency = (params.maxConcurrency as number | undefined) ?? deps.config.efficiency?.verification?.maxConcurrency
      const run = (plan: typeof request | typeof setupRequest, maxConcurrency: number | undefined): Promise<VerificationReceipt> => executeVerification(deps.context, plan, deps.verification(context), progress, context.signal, {
        deadline: verificationDeadline(deps, context), maxConcurrency, idleTimeoutMs: deps.config.guardrails?.['verify-idle-timeout'] === false ? 0 : undefined,
        onEvidence: async (kind, payload) => context.progress({ type: 'runtime-efficiency-event', payload: { kind, ...payload } }),
      })
      const identity = { candidateHash: deps.executionSnapshot(context).candidate?.hash ?? null, scopeId: context.frame.scope.id,
        repositories: deps.context.repositories.map(repository => ({ id: repository.id, path: repository.path })),
        planHash: contentDigest(json(request)), concurrency: concurrency ?? 1 }
      const infrastructureFailure = (receipt: VerificationReceipt): boolean => receipt.commands.some(command => command.exitCode === -1 && command.outcome !== 'cancelled')
      const executionError = (receipt: VerificationReceipt) => ({ status: 'failed' as const, error: { code: 'verification_execution_error', message: receipt.reason ?? 'A verification command could not complete' } })
      const blocked = (blocker: HostBlocker, output: JsonObject): PieceResult => ({
        outcome: params.hostBlockers === true ? 'blocked' : 'fail',
        ...(params.hostBlockers === true ? { status: 'blocked' as const, error: { code: 'verification_host_precondition', message: `${blocker.reason} ${blocker.requiredAction}` } } : {}),
        output: { ...output, valid: false, candidateHash: identity.candidateHash, blocker: json(blocker) }, verified: null,
      })
      // Setup never installs a verified candidate or feeds the no-progress
      // fingerprint: it prepares the workspace, it does not judge the change.
      let setup: ReturnType<typeof verificationDiagnostics> | undefined
      if (setupCommands.length) {
        const receipt = await run(setupRequest, 1)
        setup = verificationDiagnostics(receipt)
        if (infrastructureFailure(receipt)) return { outcome: 'failed', ...executionError(receipt), output: { valid: false, candidateHash: identity.candidateHash, reason: receipt.reason ?? 'A setup command could not complete', setup }, verified: null }
        const failed = receipt.commands.find(command => command.exitCode !== 0)
        if (failed) return blocked(setupBlocker(deps, failed), { reason: 'A setup command failed', setup })
      }
      const memoryKey = contentDigest(identity)
      const known = await advisoryMemory(context, () => deps.memory(context).get(['verification', 'known-commands'], memoryKey))
      let receipt = await run(request, concurrency)
      let blocker = receipt.valid ? undefined : preconditionBlock(deps.context, receipt)
      // A missing toolchain or dependency (exit 127, "command not found", a
      // Playwright browser build) is the host's to fix, not the fixer's: a
      // fresh worktree has no node_modules whatever wrote the code. Install
      // once where the failing command runs and verify again; only the second
      // receipt becomes feedback.
      let environmentRepair: { attempted: true; installs: Array<{ command: string; args: string[]; root: string; ok: boolean; detail: string }>; reverified: boolean } | undefined
      if (!blocker && !receipt.valid && guardrailEnabled(deps.config.guardrails, 'environment-repair') && receipt.commands.some(command => isEnvironmentFailure(command.exitCode, command.output))) {
        const repair = repairEnvironment(deps.context, receipt, deps.config.guardrails, progress)
        environmentRepair = { attempted: true, reverified: false, installs: repair.installs.map(install => ({ command: install.command, args: install.args, root: checkoutRelative(deps.context, install.root), ok: install.ok, detail: boundedText(install.detail, 1_000) })) }
        if (repair.refused) blocker = repair.refused
        else if (repair.installs.some(install => install.ok)) {
          progress('[environment] Verification failed on the environment (missing dependencies or tools); the host installed them and is verifying again.')
          receipt = await run(request, concurrency)
          environmentRepair.reverified = true
          blocker = receipt.valid ? undefined : preconditionBlock(deps.context, receipt)
        }
      }
      await advisoryMemory(context, () => deps.memory(context).put(['verification', 'known-commands'], memoryKey, {
        ...identity, observations: Math.min(1_000_000, typeof known?.value.observations === 'number' ? known.value.observations + 1 : 1),
        lastAttemptId: context.frame.attemptId, lastReceiptId: receipt.id, lastValid: receipt.valid,
        commands: receipt.commands.map(command => ({ repositoryId: command.repositoryId, command: command.command, exitCode: command.exitCode })),
      }))
      const infrastructure = infrastructureFailure(receipt)
      const outcome = infrastructure ? 'failed' : receipt.valid ? 'pass' : 'fail'
      const progressKey = 'verification-' + contentDigest(context.frame.nodePath).slice(0, 20)
      const fingerprint = contentDigest(json({ candidateHash: identity.candidateHash,
        failures: receipt.commands.filter(command => command.exitCode !== 0).map(command => ({ repositoryId: command.repositoryId, command: command.command, args: command.args, cwd: command.cwd, exitCode: command.exitCode })) }))
      const previous = context.state.$vars[progressKey] as { fingerprint?: string; count?: number } | undefined
      const count = receipt.valid ? 0 : previous?.fingerprint === fingerprint ? (previous.count ?? 0) + 1 : 1
      const stalled = !infrastructure && !receipt.valid && count >= 3
      const verified = receipt.valid && receipt.commands.length > 0 && !receipt.unverifiedRepositories?.length
      const output = { receiptId: receipt.id, valid: receipt.valid, candidateHash: identity.candidateHash, noProgressCount: count, ...(receipt.reason ? { reason: receipt.reason } : {}), ...(stalled ? { reason: 'Verification failed three times without candidate changes' } : {}),
        ...(setup ? { setup } : {}), ...(environmentRepair ? { environmentRepair } : {}), ...verificationDiagnostics(receipt) }
      const vars = { [progressKey]: { fingerprint, count } }
      // Without the opt-in outcome a blocker still travels in the output, and the no-progress stop keeps bounding the loop.
      if (blocker && (params.hostBlockers === true || !stalled)) return { ...blocked(blocker, output), vars, receipt: receiptEvidence(receipt) }
      return { outcome: stalled ? 'failed' : outcome, vars, ...(stalled ? { status: 'failed' as const, error: { code: 'verification_no_progress', message: 'Verification failed three times on the same unchanged candidate. Stopping automatic corrections; inspect the failed checks.' } } : {}), ...(infrastructure ? executionError(receipt) : {}),
        output: { ...output, ...(blocker ? { blocker: json(blocker) } : {}) },
        receipt: receiptEvidence(receipt), ...(verified ? { verified: { receiptId: receipt.id, candidateHash: receipt.candidateHash, atTransition: context.frame.transition, revision: context.frame.transition } } : { verified: null }) }
    },
  }
}
