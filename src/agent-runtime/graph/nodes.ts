import { addDeveloperChecks, bindPlan, expandedPlanCommands, initializeVerificationPlan, readVerificationPlan, validateProposedChecks } from '../verification-plan.js'
import path from 'node:path'
import { OpenSpecTools, type OpenSpecRoleContext } from '../openspec.js'
import {
  candidateManifest, fingerprintCandidate, frozenAcceptanceCriteria, recordAcceptance, transitionPipeline, validateAcceptanceReport, verifyPipeline,
  type AcceptanceCheck, type AcceptanceCriterion, type AcceptanceReport, type PipelineContext, type VerificationCommand,
} from '../../installer/runtime/pipeline-state.js'
import type { AgentResult, AgentRole, RuntimeConfig } from '../executor-types.js'
import { ARCHITECT_OUTPUT_SCHEMA, DEVELOPER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA, correctionInstructions, deepenInstructions, roleInstructions, type FrozenCriterion, type RoleFeedback } from '../prompts.js'
import type { JsonValue, NodeResult, WorkflowNode, WorkflowState } from '../workflow-types.js'
import { archive, child, journal, object, parseArchitecture, proposedVerification, write, writeDesignConfidence } from './artifacts.js'
import { evaluateReview, type ReviewPolicy } from './review-policy.js'
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
  note(role: AgentRole, text: string): void
  onVerificationOutput?: (text: string) => void
}
type CoreNode = WorkflowNode<CoreStateType>
type Result = NodeResult<CoreStateType>

/** Deterministic steps spend nothing; provider spend is reported by the role invoker as it happens. */
const NO_SPEND = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
function failed(error: string): Result { return { status: 'failed', error } }
function plural(count: number, noun: string): string { return `${count} ${noun}${count === 1 ? '' : 's'}` }
function feedbackFor(state: CoreStateType): RoleFeedback {
  return { verification: state.verifyResult, review: state.review }
}
/** Attempts count from the latest explicit resume: a human continuing a blocked run grants a fresh budget. */
export function developerVisitsSinceResume(checkpoint: WorkflowState): number {
  const resumed = [...checkpoint.events].reverse().find(event => event.type === 'workflow_resumed')
  return checkpoint.history.filter(attempt => attempt.stepId === 'developer' && (!resumed || attempt.startedAt >= resumed.timestamp)).length
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
      if (!first.ok) return failed(first.error)
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

function developerNode(deps: CoreNodeDeps): CoreNode {
  const { context, config, change, invoke, note } = deps
  return {
    effect: 'write', ends: ['verify'],
    async run(state, step): Promise<Result> {
      if (developerVisitsSinceResume(step.checkpoint) > deps.attempts) {
        return { status: 'blocked', error: 'Implementation correction limit reached; inspect the feedback in the log and resume to grant more attempts', usage: NO_SPEND }
      }
      transitionPipeline(context, 'developer', 'running')
      await new OpenSpecTools(deps.openspec.developer, step.signal).assertReady()
      const feedback = feedbackFor(state)
      const provider = config.agents.developer.provider
      const full = roleInstructions('developer', context, change, { definition: config.rolePrompts?.developer, feedback, verification: state.plan }) + (config.efficiency?.acceptDeveloperChecks !== false ? '\nYou may propose verificationChecks in your JSON summary. These are additive required checks, never replacements for the baseline. Use kind command with structured command/args, or kind harness with entrypoint and 1–8 relative source files (64 KiB each, 256 KiB total). Core persists harnesses outside delivery, appends the absolute entrypoint to argv and supplies SPECRAILS_CHECK_REPO_ROOT. Stable keys revise your own checks; omission retains them. Do not claim a check passed until Core has executed it.' : '')
      const previous = state.development
      const resumable = previous?.sessionId !== undefined && previous.provider === provider && developerVisitsSinceResume(step.checkpoint) > 1
      const outcome = await invoke('developer', step, {
        kind: developerVisitsSinceResume(step.checkpoint) > 1 ? 'correction' : 'initial',
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
      if (!outcome.ok) return failed(outcome.error)
      new OpenSpecTools(deps.openspec.developer, step.signal).assertParticipation()
      const record = outcome.value
      const effective = addDeveloperChecks(context, record.verificationChecks ?? [])
      bindPlan(context, effective)
      note('developer', record.structured
        ? `Developer finished: ${plural(record.files.length, 'file')} changed, ${plural(record.tests.length, 'test file')} touched${record.incomplete.length ? `, ${plural(record.incomplete.length, 'task')} left incomplete` : ''}.`
        : 'Developer finished without the structured summary; the prose summary is recorded instead.')
      for (const item of record.incomplete) note('developer', `Pending task: ${item.task} — ${item.reason}`)
      if (record.structured && record.incomplete.length && record.files.length === 0 && record.tests.length === 0) {
        return { status: 'blocked', error: `Developer could not make progress: ${record.incomplete.map(item => `${item.task}: ${item.reason}`).join('; ')}`, output: record as unknown as JsonValue }
      }
      return {
        status: 'succeeded', next: 'verify', update: { development: record, plan: expandedPlanCommands(context, effective) },
        output: { summary: record.summary, provider, ...(record.sessionId ? { sessionId: record.sessionId } : {}), files: record.files, tests: record.tests, incomplete: record.incomplete as unknown as JsonValue, structured: record.structured },
      }
    },
  }
}

function verifyNode(deps: CoreNodeDeps): CoreNode {
  const { context, note } = deps
  return {
    effect: 'write', ends: ['reviewer', 'developer'],
    async run(_state, step): Promise<Result> {
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
      const receipt = await verifyPipeline(context, { kind: 'full', planHash: effective.planHash, commands: plan, ...(uncovered.length ? { unverified: true } : {}) }, deps.onVerificationOutput, step.signal, { onEvidence: async (kind, payload) => { await step.reportEfficiencyActivity?.(kind, payload) }, maxConcurrency: effective.executionPolicy.maxConcurrency, ...(step.remainingBudget().maxDurationMs === undefined ? {} : { deadline: Date.now() + step.remainingBudget().maxDurationMs! }) })
      const evidence: VerificationRecord = {
        valid: receipt.valid, ...(receipt.reason ? { reason: receipt.reason } : {}), receiptId: receipt.id, unverifiedRepositories: uncovered,
        commands: receipt.commands.map(({ evidenceId, repositoryId, command, args, exitCode, output }) => ({ ...(evidenceId ? { evidenceId } : {}), repositoryId, command, args, exitCode, output: output.slice(-2000) })),
      }
      if (!receipt.valid) {
        note('developer', `Verification failed (${receipt.reason ?? 'a command failed'}); returning to the developer with the exact output.`)
        return { status: 'succeeded', next: 'developer', update: { verifyResult: evidence }, output: evidence as unknown as JsonValue, usage: NO_SPEND }
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
    effect: 'write', ends: ['archive', 'developer'],
    async run(state, step): Promise<Result> {
      transitionPipeline(context, 'reviewer', 'running')
      const manifest = boundedReviewManifest(candidateManifest(journal(context)))
      const delta = reviewChanges(state.review?.manifest, manifest)
      const prompt = roleInstructions('reviewer', context, change, { definition: config.rolePrompts?.reviewer, feedback: feedbackFor(state), verification: state.plan, policy, criteria, developer: state.development })
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
        note('reviewer', `Review requested corrections (score ${record.score}, ${plural(record.issues.length, 'issue')}); returning to the developer.`)
        return { status: 'succeeded', next: 'developer', update: { review: reviewedRecord }, output: reviewedRecord as unknown as JsonValue }
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
  return { architect: architectNode(deps), developer: developerNode(deps), verify: verifyNode(deps), reviewer: reviewerNode(deps), archive: archiveNode(deps) }
}
