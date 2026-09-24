import { guardrailEnabled } from '../guardrails.js'
import { addDeveloperChecks, bindPlan, expandedPlanCommands, initializeVerificationPlan, readVerificationPlan, validateProposedChecks } from '../verification-plan.js'
import path from 'node:path'
import { OpenSpecTools, type OpenSpecRoleContext } from '../openspec.js'
import {
  candidateManifest, fingerprintCandidate, frozenAcceptanceCriteria, recordAcceptance, transitionPipeline, validateAcceptanceReport, verifyPipeline,
  type AcceptanceCheck, type AcceptanceCriterion, type AcceptanceReport, type PipelineContext, type VerificationCommand,
} from '../../pipeline/pipeline-state.js'
import type { AgentEventRole, AgentResult, AgentRole, RuntimeConfig } from '../executor-types.js'
import { ARCHITECT_OUTPUT_SCHEMA, DEVELOPER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA, correctionInstructions, deepenInstructions, roleInstructions, type FrozenCriterion, type RoleFeedback } from '../prompts.js'
import type { JsonValue, NodeResult, WorkflowNode, WorkflowState, WorkflowStepContext } from '../workflow-types.js'
import { archive, child, journal, object, parseArchitecture, proposedVerification, write, writeDesignConfidence } from './artifacts.js'
import { evaluateReview, type ReviewPolicy } from './review-policy.js'
import { installEnvironment, isEnvironmentFailure } from '../compact/environment.js'
import { unreachedTestFiles, unreachedTestsReason } from '../compact/test-reachability.js'
import { exitCodeContradiction, exitHonestyReason } from '../compact/exit-code-honesty.js'
import type { RoleInvoker } from './roles.js'
import { boundedReviewManifest, reviewChanges } from '../review-context.js'
import type { ArchitectureRecord, CoreNodeId, CoreStateType, DeveloperRecord, VerificationRecord } from './state.js'

/** Autonomous investigation passes before a low-confidence design asks or proceeds. */
export const MAX_DEEPEN_PASSES = 1
const DEVELOPER_SUMMARY_LIMIT = 32_000

export interface CoreNodeDeps {
  archiveApproved?: () => boolean
  context: PipelineContext
  config: RuntimeConfig
  openspec: Record<AgentRole, OpenSpecRoleContext>
  change: string
  /** Development visits allowed per invocation, including correction cycles. */
  attempts: number
  policy: ReviewPolicy
  invoke: RoleInvoker
  /** Host-facing narration of what the runtime did with a role's reply. */
  note(role: AgentEventRole, text: string): void
  onVerificationOutput?: (text: string) => void
}
type CoreNode = WorkflowNode<CoreStateType>
type Result = NodeResult<CoreStateType>

/** Deterministic steps spend nothing; provider spend is reported by the role invoker as it happens. */
const NO_SPEND = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
function failed(error: string): Result { return { status: 'failed', error } }
/** A role that ran out of its time budget, or lost its endpoint mid-request (a local server restart, a dropped connection), did not err: block (resumable) instead of failing the run. */
const RESUMABLE_CODES = new Set(['timeout', 'provider_request_error'])
function settle(outcome: { ok: false; error: string; code?: string }, blockedHint: string): Result {
  return outcome.code && RESUMABLE_CODES.has(outcome.code) ? { status: 'blocked', error: `${outcome.error}. ${blockedHint}` } : failed(outcome.error)
}
function plural(count: number, noun: string): string { return `${count} ${noun}${count === 1 ? '' : 's'}` }
function feedbackFor(state: CoreStateType): RoleFeedback {
  return { verification: state.verifyResult, review: state.review }
}
/** Attempts count from the latest explicit resume: a human continuing a blocked run grants a fresh budget. */
export function developerVisitsSinceResume(checkpoint: WorkflowState): number {
  const resumed = [...checkpoint.events].reverse().find(event => event.type === 'workflow_resumed')
  return checkpoint.history.filter(attempt => attempt.stepId === 'developer' && (!resumed || attempt.startedAt >= resumed.timestamp)).length
}
/** Correction rounds (fixer visits) since the latest explicit resume; first passes and continuations of unchecked tasks live on the developer node and never count. */
export function fixerVisitsSinceResume(checkpoint: WorkflowState): number {
  const resumed = [...checkpoint.events].reverse().find(event => event.type === 'workflow_resumed')
  return checkpoint.history.filter(attempt => attempt.stepId === 'fixer' && (!resumed || attempt.startedAt >= resumed.timestamp)).length
}
function isCompactDeveloper(config: RuntimeConfig): boolean {
  const provider = config.providers.find(item => item.id === config.agents.developer.provider)
  return provider?.kind === 'openai-compatible' && (provider.agentLoop ?? 'compact') === 'compact'
}
function uncoveredRepositories(context: PipelineContext, plan: VerificationCommand[]): string[] {
  return context.repositories.filter(repository => !plan.some(command => command.repositoryId === repository.id)).map(repository => repository.id)
}
function strings(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim().slice(0, 1000)).slice(0, limit) : []
}
/** The developer's structured summary, or an honest prose record when the provider returned text. */
export function developerRecord(output: Record<string, unknown> | undefined, text: string, result: AgentResult, provider: string): DeveloperRecord {
  const base = { provider, ...(result.sessionId ? { sessionId: result.sessionId } : {}) }
  if (!output || typeof output.summary !== 'string' || !output.summary.trim()) {
    return { ...base, summary: text.slice(-DEVELOPER_SUMMARY_LIMIT), files: [], tests: [], incomplete: [], structured: false }
  }
  const incomplete = Array.isArray(output.incomplete) ? output.incomplete.flatMap(item => {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
    return entry && typeof entry.task === 'string' && entry.task.trim() ? [{ task: entry.task.trim().slice(0, 1000), reason: typeof entry.reason === 'string' ? entry.reason.trim().slice(0, 2000) : '' }] : []
  }).slice(0, 200) : []
  return {
    ...base, structured: true,
    summary: output.summary.trim().slice(-DEVELOPER_SUMMARY_LIMIT),
    files: strings(output.files, 500), tests: strings(output.tests, 500),
    ...(typeof output.verification === 'string' && output.verification.trim() ? { verification: output.verification.trim().slice(0, 4000) } : {}),
    incomplete,
  }
}

function architectNode(deps: CoreNodeDeps): CoreNode {
  const { context, config, change, invoke, note } = deps
  const accept = (output: Record<string, unknown> | undefined): ReturnType<typeof parseArchitecture> => {
    const architecture = parseArchitecture(object(output))
    if (config.efficiency?.planning === 'full' || context.repositories.length > 1 || /\b(?:migration|security|authentication|authorization|public contract|public api|migraci[oó]n|seguridad)\b/i.test(context.specs.map(spec => spec.title + ' ' + spec.description).join('\n'))) architecture.planningDepth = 'full'
    // Malformed proposals are repaired inside the same session, like any other structural defect.
    proposedVerification(context, config.verification, architecture.verification)
    return architecture
  }
  return {
    effect: 'write', ends: ['developer'],
    async run(state, step): Promise<Result> {
      transitionPipeline(context, 'architect', 'running')
      // A resumed node collects the requester's answer first, so the pass that
      // asked the question is never repeated.
      const answers = [...state.answers]
      const fresh: string[] = []
      if (step.pending?.kind === 'question') {
        const reply = step.interrupt<{ answer: string }>(step.pending)
        answers.push(reply.answer)
        fresh.push(reply.answer)
        note('architect', 'Continuing the architecture with the answer to the blocking question.')
      }
      const prompt = roleInstructions('architect', context, change, { definition: config.rolePrompts?.architect, verification: config.verification, answers, planning: config.efficiency?.planning })
      const first = await invoke('architect', step, { prompt, structured: true, outputSchema: ARCHITECT_OUTPUT_SCHEMA }, accept)
      if (!first.ok) return settle(first, 'Resume to run the architect again, or raise limits.timeoutMs.')
      let architecture = first.value
      let passes = state.deepenPasses
      if (architecture.confidence === 'low' && passes < MAX_DEEPEN_PASSES) {
        passes += 1
        note('architect', `Design confidence is low${architecture.question ? ` (${architecture.question})` : ''}; asking the architect to investigate the code further before deciding.`)
        const second = await invoke('architect', step, { kind: 'deepen', prompt: deepenInstructions(architecture.question), fallbackPrompt: prompt + '\nPrevious response (bounded):\n' + first.text.slice(-32_000) + '\n' + deepenInstructions(architecture.question), structured: true, outputSchema: ARCHITECT_OUTPUT_SCHEMA, resumeSessionId: first.result.sessionId }, accept)
        if (second.ok) architecture = second.value
        else note('architect', `The investigation pass could not be used (${second.error}); keeping the first design.`)
      }
      let assumed = false
      if (architecture.confidence === 'low') {
        const question = architecture.question ?? 'The architect could not choose between several plausible designs; inspect proposal.md and state the intended behavior.'
        if ((config.architect?.onLowConfidence ?? 'ask') === 'ask') {
          // The draft artifacts are written first so the requester can read the
          // proposal while answering; the resumed pass replaces them.
          writeDesignConfidence(context, change, architecture)
          transitionPipeline(context, 'architect', 'blocked', 'Design confidence is low')
          note('architect', 'Design confidence is still low; pausing until the blocking question is answered.')
          step.interrupt({ kind: 'question', question })
        }
        assumed = true
        note('architect', 'Design confidence is still low; proceeding on the stated assumptions because architect.onLowConfidence is "proceed".')
      }
      const workflow = new OpenSpecTools(deps.openspec.architect, step.signal)
      workflow.assertParticipation()
      const applied = await workflow.assertReady()
      const specs = Object.keys((await workflow.status()).artifactPaths).length ? (applied.contextFiles.specs ?? []) : []
      const names = (Array.isArray(specs) ? specs : [specs]).map(file => path.basename(path.dirname(file)))
      const proposed = proposedVerification(context, config.verification, architecture.verification)
      writeDesignConfidence(context, change, architecture, { assumed })
      const effective = initializeVerificationPlan(context, config.verification, proposed, config.efficiency?.verification?.maxConcurrency)
      bindPlan(context, effective)
      const plan = expandedPlanCommands(context, effective)
      const uncovered = uncoveredRepositories(context, plan)
      transitionPipeline(context, 'architect', 'done')
      note('architect', `Architecture written: ${plural(applied.progress.total, 'task')}, spec${names.length === 1 ? '' : 's'} ${names.join(', ')}, confidence ${architecture.confidence}.`
        + (proposed.length ? ` Verification proposed by the architect: ${proposed.map(command => [command.command, ...command.args].join(' ')).join('; ')}.` : '')
        + (uncovered.length ? ` No verification command for ${uncovered.join(', ')}; the reviewer will inspect that work without automated checks.` : ''))
      const record: ArchitectureRecord = {
        change, tasks: applied.progress.total, specs: names, confidence: architecture.confidence,
        planningDepth: architecture.planningDepth, referencePatterns: architecture.referencePatterns, riskFlags: architecture.riskFlags,
        ...(architecture.planningReason ? { planningReason: architecture.planningReason } : {}),
        ...(architecture.question ? { question: architecture.question } : {}), ...(assumed ? { assumed: true } : {}),
      }
      return {
        status: 'succeeded', next: 'developer',
        update: { plan, unverifiedRepositories: uncovered, architecture: record, answers: fresh, deepenPasses: passes },
        output: { change, verification: plan as unknown as JsonValue, unverifiedRepositories: uncovered, confidence: architecture.confidence, assumed, deepenPasses: passes },
      }
    },
  }
}

/**
 * Shared body of the two implementation nodes. `developer` implements the
 * plan and continues unchecked tasks; `fixer` is the correction round after a
 * failed verification or a rejected review — its own graph node, its own
 * editable definition and (when configured) its own engine, so the log, the
 * spans and the phase chips say who acted. Both write the same
 * `development` record and hand over to `verify`.
 */
async function implementationVisit(deps: CoreNodeDeps, state: CoreStateType, step: WorkflowStepContext, mode: 'developer' | 'fixer'): Promise<Result> {
  const { context, config, change, invoke, note } = deps
  const fixing = mode === 'fixer'
  transitionPipeline(context, 'developer', 'running')
  await new OpenSpecTools(deps.openspec.developer, step.signal).assertReady()
  const feedback = feedbackFor(state)
  // The fixer ENGINE only when the project configured one — "Inherit
  // developer" keeps the developer's engine but repairs with the fixer's
  // instructions.
  const fixer = fixing ? config.fixer : undefined
  const provider = (fixer ?? config.agents.developer).provider
  const full = roleInstructions('developer', context, change, { definition: fixing ? config.rolePrompts?.fixer : config.rolePrompts?.developer, ...(fixing ? { stance: 'fixer' as const } : {}), feedback, verification: state.plan }) + (config.efficiency?.acceptDeveloperChecks !== false ? '\nYou may propose verificationChecks in your JSON summary. These are additive required checks, never replacements for the baseline. Use kind command with structured command/args, or kind harness with entrypoint and 1–8 relative source files (64 KiB each, 256 KiB total). Core persists harnesses outside delivery, appends the absolute entrypoint to argv and supplies SPECRAILS_CHECK_REPO_ROOT. Stable keys revise your own checks; omission retains them. Do not claim a check passed until Core has executed it.' : '')
  const previous = state.development
  // A CLI developer with a live session takes corrections and continuations
  // as a short follow-up in that session; a configured fixer engine always
  // starts fresh (sessions never carry across engines).
  const visits = developerVisitsSinceResume(step.checkpoint) + fixerVisitsSinceResume(step.checkpoint)
  const resumable = !fixer && previous?.sessionId !== undefined && previous.provider === provider && visits > 1
  if (fixer) note('fixer', `Correction round on the fixer engine (${fixer.provider}/${fixer.model ?? 'provider default'}).`)
  const outcome = await invoke('developer', step, {
    kind: visits > 1 ? 'correction' : 'initial',
    ...(fixer ? { agentOverride: fixer } : {}), ...(fixing ? { stance: 'fixer' as const } : {}),
    ...(resumable
      ? { prompt: correctionInstructions('developer', feedback), resumeSessionId: previous.sessionId, fallbackPrompt: full }
      : { prompt: full }),
    structured: true, lenient: true, outputSchema: DEVELOPER_OUTPUT_SCHEMA,
  }, (output, text, result) => {
    if (!output && /"verificationChecks"\s*:/.test(text)) throw new Error('Malformed developer verificationChecks response')
    const checks = validateProposedChecks(context, output?.verificationChecks)
    if (checks.length && config.efficiency?.acceptDeveloperChecks === false) throw new Error('Developer verification proposals are disabled by the frozen policy')
    return { ...developerRecord(output, text, result, provider), ...(checks.length ? { verificationChecks: checks } : {}) }
  })
  // A timeout is a budget, not a defect: the groups already finished are
  // ticked in tasks.md and verified, and write_progress holds the handoff, so
  // the run BLOCKS (resume continues from the next open group, or raise
  // limits.timeoutMs) instead of failing the whole workflow.
  if (!outcome.ok) return settle(outcome, 'Finished task groups are ticked and verified; resume to continue from the next open group, or raise limits.timeoutMs.')
  new OpenSpecTools(deps.openspec.developer, step.signal).assertParticipation()
  const record = outcome.value
  const effective = addDeveloperChecks(context, record.verificationChecks ?? [])
  bindPlan(context, effective)
  const who = fixing ? 'Fixer' : 'Developer'
  note(mode, record.structured
    ? `${who} finished: ${plural(record.files.length, 'file')} changed, ${plural(record.tests.length, 'test file')} touched${record.incomplete.length ? `, ${plural(record.incomplete.length, 'task')} left incomplete` : ''}.`
    : `${who} finished without the structured summary; the prose summary is recorded instead.`)
  for (const item of record.incomplete) note(mode, `Pending task: ${item.task} — ${item.reason}`)
  if (record.structured && record.incomplete.length && record.files.length === 0 && record.tests.length === 0) {
    return { status: 'blocked', error: `${who} could not make progress: ${record.incomplete.map(item => `${item.task}: ${item.reason}`).join('; ')}`, output: record as unknown as JsonValue }
  }
  return {
    status: 'succeeded', next: 'verify', update: { development: record, plan: expandedPlanCommands(context, effective) },
    output: { summary: record.summary, provider, ...(record.sessionId ? { sessionId: record.sessionId } : {}), files: record.files, tests: record.tests, incomplete: record.incomplete as unknown as JsonValue, structured: record.structured },
  }
}

function developerNode(deps: CoreNodeDeps): CoreNode {
  return {
    effect: 'write', ends: ['verify'],
    async run(state, step): Promise<Result> {
      // The developer budget covers the first pass and its continuations of
      // unchecked tasks (the compact developer needs several); corrections
      // have their own budget on the fixer node.
      if (developerVisitsSinceResume(step.checkpoint) > deps.attempts + (isCompactDeveloper(deps.config) ? deps.attempts : 0)) {
        return { status: 'blocked', error: 'Implementation continuation limit reached; inspect the log and resume to grant more attempts', usage: NO_SPEND }
      }
      return implementationVisit(deps, state, step, 'developer')
    },
  }
}

function fixerNode(deps: CoreNodeDeps): CoreNode {
  return {
    effect: 'write', ends: ['verify'],
    async run(state, step): Promise<Result> {
      if (fixerVisitsSinceResume(step.checkpoint) > deps.attempts) {
        return { status: 'blocked', error: 'Implementation correction limit reached; inspect the feedback in the log and resume to grant more attempts', usage: NO_SPEND }
      }
      return implementationVisit(deps, state, step, 'fixer')
    },
  }
}

function verifyNode(deps: CoreNodeDeps): CoreNode {
  const { context, note, config } = deps
  return {
    effect: 'write', ends: ['reviewer', 'developer', 'fixer'],
    async run(state, step): Promise<Result> {
      // Unchecked tasks are developer feedback, not a workflow failure: the
      // developer sees exactly which tasks remain and continues its session.
      const workflow = new OpenSpecTools(deps.openspec.developer, step.signal)
      const applied = await workflow.assertReady()
      const open = applied.tasks.filter(task => !task.done).map(task => task.description)
      if (open.length) {
        note('developer', `Verification skipped: ${plural(open.length, 'task')} still unchecked in tasks.md; returning to the developer.`)
        const evidence: VerificationRecord = { valid: false, reason: 'Required implementation tasks remain unchecked in tasks.md', incompleteTasks: open, unverifiedRepositories: [], commands: [] }
        return { status: 'succeeded', next: 'developer', update: { verifyResult: evidence }, output: evidence as unknown as JsonValue, usage: NO_SPEND }
      }
      const effective = readVerificationPlan(context)
      if (!effective) throw new Error('Verification plan is unavailable')
      const plan = expandedPlanCommands(context, effective)
      const uncovered = uncoveredRepositories(context, plan)
      let receipt = await verifyPipeline(context, { kind: 'full', planHash: effective.planHash, commands: plan, ...(uncovered.length ? { unverified: true } : {}) }, deps.onVerificationOutput, step.signal, { ...(guardrailEnabled(config.guardrails, 'verify-idle-timeout') ? {} : { idleTimeoutMs: 0 }), onEvidence: async (kind, payload) => { await step.reportEfficiencyActivity?.(kind, payload) }, maxConcurrency: effective.executionPolicy.maxConcurrency, ...(step.remainingBudget().maxDurationMs === undefined ? {} : { deadline: Date.now() + step.remainingBudget().maxDurationMs! }) })
      // A failure that is really a missing toolchain or dependency (exit 127,
      // "command not found", "Cannot find module"…) is the HOST's to fix, not
      // the model's — for every developer: a fresh worktree has no
      // node_modules whatever wrote the code. Install once and re-verify; only
      // a second failure becomes developer feedback.
      if (!receipt.valid && guardrailEnabled(config.guardrails, 'environment-repair') && receipt.commands.some(command => isEnvironmentFailure(command.exitCode, command.output))) {
        const installs = installEnvironment(context.repositories.map(repository => repository.path), { failureOutput: receipt.commands.map(command => command.output).join('\n'), lockfileRepair: guardrailEnabled(config.guardrails, 'lockfile-repair'), onEvent: event => note('developer', event.kind === 'text' ? event.text ?? '' : `[environment] ${event.tool ?? ''} ${event.detail ?? ''}`.trim()) })
        if (installs.some(outcome => outcome.ok)) {
          note('developer', 'Verification failed on the environment (missing dependencies or tools); the host installed them and is verifying again.')
          receipt = await verifyPipeline(context, { kind: 'full', planHash: effective.planHash, commands: plan, ...(uncovered.length ? { unverified: true } : {}) }, deps.onVerificationOutput, step.signal, { ...(guardrailEnabled(config.guardrails, 'verify-idle-timeout') ? {} : { idleTimeoutMs: 0 }), onEvidence: async (kind, payload) => { await step.reportEfficiencyActivity?.(kind, payload) }, maxConcurrency: effective.executionPolicy.maxConcurrency, ...(step.remainingBudget().maxDurationMs === undefined ? {} : { deadline: Date.now() + step.remainingBudget().maxDurationMs! }) })
        }
      }
      const evidence: VerificationRecord = {
        valid: receipt.valid, ...(receipt.reason ? { reason: receipt.reason } : {}), receiptId: receipt.id, unverifiedRepositories: uncovered,
        commands: receipt.commands.map(({ evidenceId, repositoryId, command, args, exitCode, output }) => ({ ...(evidenceId ? { evidenceId } : {}), repositoryId, command, args, exitCode, output: output.slice(-2000) })),
      }
      if (!receipt.valid) {
        note('fixer', `Verification failed (${receipt.reason ?? 'a command failed'}); handing the exact output to the fixer.`)
        return { status: 'succeeded', next: 'fixer', update: { verifyResult: evidence }, output: evidence as unknown as JsonValue, usage: NO_SPEND }
      }
      // Exit 0 with "3 failed" in the output is a broken harness, not a pass.
      if (guardrailEnabled(config.guardrails, 'exit-code-honesty')) {
        const findings = receipt.commands.flatMap(command => { const found = exitCodeContradiction(command.exitCode, command.output); return found ? [{ ...found, command: [command.command, ...command.args].join(' ') }] : [] })
        if (findings.length) {
          const reason = exitHonestyReason(findings)
          note('fixer', `Verification exited 0 but reported failures (${findings.map(item => item.sample).join(' | ')}); handing it to the fixer as a failure.`)
          const dishonest: VerificationRecord = { ...evidence, valid: false, reason }
          return { status: 'succeeded', next: 'fixer', update: { verifyResult: dishonest }, output: dishonest as unknown as JsonValue, usage: NO_SPEND }
        }
      }
      // Every command exited 0 — but did any of them RUN the tests the
      // developer wrote? An enumerating test script (`node tests/a.test.js &&
      // node tests/b.test.js`) silently skips a new file (observed: a 622-line
      // browser suite with 6 failing cases shipped green). The host knows the
      // reported test files and the exact commands; an unreached file is a
      // verification failure with a precise instruction, never a pass.
      if (guardrailEnabled(config.guardrails, 'test-reachability')) {
        const reported = [...(state.development?.tests ?? []), ...(state.development?.files ?? [])]
        const unreached = context.repositories.flatMap(repository => unreachedTestFiles(repository.path, plan.filter(command => command.repositoryId === repository.id).map(({ command, args, cwd }) => ({ command, args, ...(cwd ? { cwd } : {}) })), reported).map(file => context.repositories.length > 1 ? `${repository.id}:${file}` : file))
        if (unreached.length) {
          const reason = unreachedTestsReason(unreached)
          note('fixer', `Verification incomplete: ${unreached.join(', ')} ${unreached.length === 1 ? 'is' : 'are'} not run by any verification command; handing it to the fixer.`)
          const incomplete: VerificationRecord = { ...evidence, valid: false, reason }
          return { status: 'succeeded', next: 'fixer', update: { verifyResult: incomplete }, output: incomplete as unknown as JsonValue, usage: NO_SPEND }
        }
      }
      transitionPipeline(context, 'developer', 'done')
      note('developer', plan.length ? `Verification passed: ${plural(plan.length, 'command')} exited 0.` : 'No verification commands available; relying on task completion and review.')
      return { status: 'succeeded', next: 'reviewer', update: { verifyResult: evidence }, output: evidence as unknown as JsonValue, usage: NO_SPEND }
    },
  }
}

/**
 * The acceptance report Core records for the reviewer: the frozen criteria the
 * reviewer certified by coordinates, the verification commands Core actually ran
 * as required checks, repositories admitted without a check as unavailable ones,
 * and the reviewer's own inspections as supplementary evidence.
 */
export function buildAcceptanceReport(criteria: FrozenCriterion[], verification: VerificationRecord | null, raw: unknown): AcceptanceReport {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const rows = Array.isArray(input.criteria) ? input.criteria.map(item => object(item)) : []
  const certified = criteria.map((item): AcceptanceCriterion => {
    const row = rows.find(candidate => String(candidate.specId) === item.specId && candidate.criterionIndex === item.criterionIndex)
    if (!row) throw new Error(`Invalid acceptance report: criterion ${item.specId}#${item.criterionIndex} was not certified`)
    return { ...item, status: row.status as AcceptanceCriterion['status'], evidence: row.evidence as string[], ...(row.exception !== undefined ? { exception: row.exception as AcceptanceCriterion['exception'] } : {}) }
  })
  const checks: AcceptanceCheck[] = []
  for (const command of verification?.commands ?? []) {
    checks.push({
      name: `${command.repositoryId}: ${[command.command, ...command.args].join(' ')}`,
      status: command.exitCode === 0 ? 'passed' : 'failed', required: true,
      evidence: [`Verification receipt ${verification?.receiptId ?? 'unknown'}: exit code ${String(command.exitCode)}`],
      scope: `Core ran the repository's own verification command in ${command.repositoryId} after the developer finished.`,
      limitations: 'Proves only what this command exercises; behavior outside its tests, other repositories and manual scenarios are not covered.',
    })
  }
  for (const repositoryId of verification?.unverifiedRepositories ?? []) {
    checks.push({
      name: `automated verification for ${repositoryId}`, status: 'unavailable', required: false,
      evidence: ['No verification command was configured by the host or proposed by the architect for this repository.'],
      scope: 'No automated check ran for this repository.', limitations: 'Acceptance relies on reviewer inspection alone for this repository.',
    })
  }
  // Reviewer inspections are evidence, never gates: only Core's own subprocess receipts are required checks.
  for (const item of Array.isArray(input.checks) ? input.checks : []) checks.push({ ...(object(item) as unknown as AcceptanceCheck), required: false })
  return { criteria: certified, checks, findings: (Array.isArray(input.findings) ? input.findings : []) as string[] }
}

function reviewerNode(deps: CoreNodeDeps): CoreNode {
  const { context, change, invoke, note, policy, config } = deps
  const criteria = frozenAcceptanceCriteria(context)
  return {
    effect: 'write', ends: ['archive', 'fixer'],
    async run(state, step): Promise<Result> {
      transitionPipeline(context, 'reviewer', 'running')
      const manifest = boundedReviewManifest(candidateManifest(journal(context)))
      const delta = reviewChanges(state.review?.manifest, manifest)
      // A follow-up pass (previous verdict + an incremental manifest delta) tells
      // the reviewer what changed and what it already certified, whatever the
      // transport: CLI sessions get the short follow-up below; sessionless
      // (compact/local) reviewers get the same facts inside the full prompt.
      const reReview = config.efficiency?.reviewMode !== 'full' && delta.mode === 'incremental' && state.review
        ? { changes: delta.changes, previouslyMet: (journal(context).acceptance?.criteria ?? []).filter(item => item.status === 'met').map(({ specId, criterionIndex }) => ({ specId, criterionIndex })) }
        : undefined
      if (reReview) note('reviewer', `Re-review: ${plural(reReview.changes.length, 'file')} changed since the previous verdict; certifying the previous issues instead of re-reading the candidate.`)
      const prompt = roleInstructions('reviewer', context, change, { definition: config.rolePrompts?.reviewer, feedback: feedbackFor(state), verification: state.plan, policy, criteria, developer: state.development, ...(reReview ? { reReview } : {}) })
      const incremental = config.efficiency?.reviewMode !== 'full' && delta.mode === 'incremental' && state.review?.sessionId
      const followup = correctionInstructions('reviewer', feedbackFor(state)) + '\nChanges since YOUR previous reviewed candidate:\n' + JSON.stringify(delta.changes)
        + '\nRecertify EVERY current acceptance criterion; previous met results are not current evidence:\n' + JSON.stringify(criteria)
        + '\nCurrent developer handoff:\n' + JSON.stringify(state.development)
      const outcome = await invoke('reviewer', step, { kind: state.review ? 'correction' : 'initial', prompt: incremental ? followup : prompt, ...(incremental ? { resumeSessionId: state.review!.sessionId, fallbackPrompt: prompt } : {}), structured: true, outputSchema: REVIEW_OUTPUT_SCHEMA }, output => {
        const raw = object(output)
        const review = evaluateReview(raw, policy)
        const report = buildAcceptanceReport(criteria, state.verifyResult, raw.acceptance)
        try { validateAcceptanceReport(context, report) } catch (error) { throw new Error('Invalid acceptance report: ' + (error instanceof Error ? error.message : String(error))) }
        return { ...review, report }
      })
      if (!outcome.ok) return failed(outcome.error)
      const workflow = new OpenSpecTools(deps.openspec.reviewer, step.signal)
      workflow.assertParticipation()
      await workflow.assertReady()
      const { record, approved, report } = outcome.value
      const reviewedRecord = { ...record, manifest, ...(outcome.result.sessionId ? { sessionId: outcome.result.sessionId } : {}) }
      // Acceptance evidence is bound to the exact candidate before the reviewer verdict is recorded.
      recordAcceptance(context, report)
      if (!approved) {
        transitionPipeline(context, 'reviewer', 'blocked', 'Review requests corrections')
        note('reviewer', `Review requested corrections (score ${record.score}, ${plural(record.issues.length, 'issue')}); handing them to the fixer.`)
        return { status: 'succeeded', next: 'fixer', update: { review: reviewedRecord }, output: reviewedRecord as unknown as JsonValue }
      }
      write(child(context.artifactRoot, 'openspec/changes/' + change + '/confidence-score.json'), JSON.stringify({ change, overall: record.score, aspects: record.aspects, summary: record.summary }, null, 2) + '\n')
      transitionPipeline(context, 'reviewer', 'done')
      note('reviewer', `Review approved with score ${record.score}: ${record.summary}`)
      const reviewed = { ...reviewedRecord, candidateHash: fingerprintCandidate(journal(context)) }
      return { status: 'succeeded', next: 'archive', update: { review: reviewed }, output: reviewed as unknown as JsonValue }
    },
  }
}

function archiveNode(deps: CoreNodeDeps): CoreNode {
  const { context, config, change } = deps
  return {
    effect: 'write', ends: [],
    async run(_state, step): Promise<Result> {
      if (journal(context).phases.archive.status !== 'done' && config.approvalBeforeArchive && !deps.archiveApproved?.()) {
        // Pauses until the host grants the approval; a resumed node passes straight
        // through. The pause itself spends nothing, and says so.
        step.reportUsage(NO_SPEND)
        step.interrupt<{ approved: true }>({ kind: 'approval', reason: 'Approve archive after inspecting the verified implementation' })
      }
      await archive(context, change, step.signal)
      const record = { archivePath: journal(context).archivePath!, deliveryOwner: context.ownership.git }
      return { status: 'succeeded', next: null, update: { archived: record }, output: record, usage: NO_SPEND }
    },
  }
}

/** The five Core phases as LangGraph nodes. Declaration order defines "downstream" for invalidation. */
export function coreNodes(deps: CoreNodeDeps): Record<CoreNodeId, CoreNode> {
  return { architect: architectNode(deps), developer: developerNode(deps), fixer: fixerNode(deps), verify: verifyNode(deps), reviewer: reviewerNode(deps), archive: archiveNode(deps) }
}
