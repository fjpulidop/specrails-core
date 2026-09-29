import path from 'node:path'
import { existsSync } from 'node:fs'
import { expandedPlanCommands, readVerificationPlan } from '../../verification-plan.js'
import { bindImplementationExclusions, initializePipeline, inspectPipeline, pipelineStateDirectory } from '../../../pipeline/pipeline-state.js'
import { resolveRoleDescriptor, roleIds } from '../../config.js'
import type { AgentRole, RuntimeConfig } from '../../executor-types.js'
import { journal } from '../../graph/artifacts.js'
import { coreNodes, type CoreNodeDeps } from '../../graph/nodes.js'
import { resolveReviewPolicy } from '../../graph/review-policy.js'
import { createRoleInvoker, type RoleInvoker } from '../../graph/roles.js'
import { CORE_NODE_ORDER, CoreState, type CoreNodeId, type CoreStateType, type CoreStateUpdate } from '../../graph/state.js'
import { prepareOpenSpec, roleOpenSpecContext, type OpenSpecRoleContext } from '../../openspec.js'
import type { InterruptResume, NodeResult, StepRecord, WorkflowNode, WorkflowState, WorkflowStepContext } from '../../workflow-types.js'
import { EngineError, type JsonObject, type PieceExecutionContext, type PieceResult } from '../contracts.js'
import { contentDigest } from '../canonical-json.js'
import type { PieceDependencies } from './ports.js'
import type { ImplementationBinding } from './implementation-binding.js'
import { json } from './shared.js'
import { receiptEvidence } from './verify.js'
import { captureImplementationJournal, type ImplementationJournalSnapshot } from './implementation-journal.js'

/** Child graph contract; the compiler supplies the actual durable LangGraph boundaries. */
export interface ImplementationAdapter {
  schema: typeof CoreState
  nodes: Record<CoreNodeId, WorkflowNode<CoreStateType>>
  entry: CoreNodeId
  initialize(context: PieceExecutionContext): Promise<CoreStateUpdate>
  runNode(id: CoreNodeId, state: CoreStateType, context: PieceExecutionContext): Promise<NodeResult<CoreStateType>>
  snapshot(context: PieceExecutionContext): ImplementationJournalSnapshot
  summarize(state: CoreStateType, context: PieceExecutionContext): Promise<PieceResult>
  validateCompleted(id: CoreNodeId, record: StepRecord, checkpoint: WorkflowState, context: PieceExecutionContext): Promise<boolean>
}

/** Scope the legacy convergence/attempt view without changing durable event attribution. */
export function implementationStepContext(deps: PieceDependencies, context: PieceExecutionContext, id: CoreNodeId): WorkflowStepContext {
  const original = deps.stepContext(context)
  const prefix = context.frame.nodePath.slice(0, -id.length)
  const local = (value: string): string => value.startsWith(prefix) ? value.slice(prefix.length) : value
  const belongs = (value: string): boolean => (CORE_NODE_ORDER as readonly string[]).includes(value) || (value.startsWith(prefix) && !value.slice(prefix.length).includes('/'))
  const checkpoint = original.checkpoint
  return { ...original, stepId: id, checkpoint: { ...checkpoint,
    nextStep: checkpoint.nextStep === null ? id : local(checkpoint.nextStep),
    steps: Object.fromEntries(Object.entries(checkpoint.steps).filter(([key]) => belongs(key)).map(([key, value]) => [local(key), { ...value, id: local(value.id) }])),
    history: checkpoint.history.filter(entry => belongs(entry.stepId)).map(entry => ({ ...entry, stepId: local(entry.stepId) })),
    events: checkpoint.events.filter(event => !event.stepId || belongs(event.stepId)).map(event => ({ ...event, ...(event.stepId ? { stepId: local(event.stepId) } : {}) })),
    ...(checkpoint.pendingApproval ? { pendingApproval: { ...checkpoint.pendingApproval, stepId: local(checkpoint.pendingApproval.stepId) } } : {}),
    ...(checkpoint.pendingQuestion ? { pendingQuestion: { ...checkpoint.pendingQuestion, stepId: local(checkpoint.pendingQuestion.stepId) } } : {}),
  }, interrupt: <R extends InterruptResume>(request: Parameters<WorkflowStepContext['interrupt']>[0]): R => {
    const value = context.interrupt({ kind: request.kind, prompt: request.kind === 'question' ? request.question : request.reason,
      nodePath: context.frame.nodePath, scopeId: context.frame.scope.id, attemptId: context.frame.attemptId })
    if (!value || typeof value !== 'object' || Array.isArray(value) || (request.kind === 'question' ? typeof value.answer !== 'string' : value.approved !== true)) throw new EngineError('invalid_resume', 'Implementation interrupt requires a matching answer or approval')
    return value as unknown as R
  } }
}

/** Reuse every legacy node and quality gate; this factory never runs the legacy JSON workflow host. */
export function createImplementationAdapter(deps: PieceDependencies, input: { change: string; params: JsonObject }): ImplementationAdapter {
  const { change, params } = input
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change) || change.length > 64) throw new EngineError('invalid_arguments', 'Implementation requires an admitted OpenSpec change')
  const config: RuntimeConfig = { ...deps.config,
    ...(params.approvalBeforeArchive === undefined ? {} : { approvalBeforeArchive: params.approvalBeforeArchive === true }),
    ...(params.reviewPolicy ? { review: params.reviewPolicy as RuntimeConfig['review'] } : {}) }
  const attempts = (params.attempts as number | undefined) ?? config.limits?.maxAttempts ?? 3
  const bindings = new Map<string, { binding: ImplementationBinding; openspec: Record<AgentRole, OpenSpecRoleContext>; resumeChecked: boolean; archiveConsent?: string }>()
  const instanceKey = (context: PieceExecutionContext): string => context.frame.scope.id + '/' + context.frame.visitId
  const metadata: CoreNodeDeps = { context: deps.context, config, change, attempts, policy: resolveReviewPolicy(config), openspec: {}, focusedCorrectionEvidence: true,
    invoke: (() => { throw new EngineError('implementation_not_initialized', 'Implementation metadata nodes must run through the durable adapter') }) as RoleInvoker, note() {} }
  const refresh = (binding: ImplementationBinding, context: PieceExecutionContext): void => {
    const exclusions = deps.implementationExclusions?.(context)
    if (exclusions) bindImplementationExclusions(binding.context, exclusions)
  }
  const consent = (binding: ImplementationBinding): string => {
    const pipeline = journal(binding.context)
    return contentDigest(json({ candidate: inspectPipeline(binding.context).candidateHash, plan: pipeline.verificationPlan?.hash ?? null,
      criteria: pipeline.acceptance?.criteria.map(({ evidence: _evidence, ...criterion }) => criterion) ?? null,
      checks: pipeline.acceptance?.checks.map(({ evidence: _evidence, ...check }) => check) ?? null }))
  }
  const adapter: ImplementationAdapter = {
    schema: CoreState, nodes: coreNodes(metadata), entry: 'architect',
    async initialize(context) {
      context.signal.throwIfAborted()
      const binding = deps.bindImplementation(context, change)
      const pipeline = binding.context
      const state = initializePipeline(pipeline, binding.change)
      refresh(binding, context)
      if (state.phases.archive.status === 'done') {
        const inspection = inspectPipeline(pipeline)
        if (!inspection.verification.valid || !inspection.acceptance.valid || (inspection.resumePhase && !['ship', 'ci'].includes(inspection.resumePhase))) throw new EngineError('incompatible_resume', 'Archived implementation evidence changed; start a new run')
      }
      const directory = path.join(pipelineStateDirectory(pipeline), 'agent-workflow')
      const prepared = prepareOpenSpec(pipeline.artifactRoot, binding.change, directory)
      const openspec = Object.fromEntries(roleIds(config).filter(role => resolveRoleDescriptor(config, role).openspecSkill).map(role => {
        const descriptor = resolveRoleDescriptor(config, role), provider = config.providers.find(item => item.id === descriptor.provider)
        return [role, roleOpenSpecContext(prepared, pipeline.artifactRoot, binding.change, directory, descriptor, provider?.kind === 'cli' ? provider.cli : 'claude')]
      }))
      for (const role of Object.keys(openspec)) await deps.registry.get(resolveRoleDescriptor(config, role).provider).validateOpenSpec?.(openspec[role])
      bindings.set(instanceKey(context), { binding, openspec, resumeChecked: false })
      if (existsSync(path.join(directory, 'implementation-fork.json'))) {
        const plan = readVerificationPlan(pipeline)
        return { ...(plan ? { plan: expandedPlanCommands(pipeline, plan) } : {}), verifyResult: null, review: null, archived: null, verifyHistory: [] }
      }
      return {}
    },
    async runNode(id, state, context) {
      const prepared = bindings.get(context.frame.scope.id)
      if (!prepared) throw new EngineError('implementation_not_initialized', 'Initialize this implementation scope before executing its child graph')
      const { binding, openspec } = prepared
      refresh(binding, context)
      const step = implementationStepContext(deps, context, id)
      if (!prepared.resumeChecked && (step.pending || step.checkpoint.events.some(event => event.type === 'workflow_resumed'))) {
        // Collect archive consent first, then revalidate completed verification
        // and review exactly as the legacy host does on explicit resume.
        if (id === 'archive' && step.pending?.kind === 'approval') {
          step.interrupt(step.pending)
          const inspection = inspectPipeline(binding.context)
          if (inspection.verification.valid && inspection.acceptance.valid && inspection.phases.reviewer.status === 'done') prepared.archiveConsent = consent(binding)
          if (step.checkpoint.pendingApproval) step.checkpoint.pendingApproval.grantedAt = new Date().toISOString()
        }
        prepared.resumeChecked = true
        for (const completed of CORE_NODE_ORDER) {
          const record = step.checkpoint.steps[completed]
          if (completed === id || record?.status !== 'succeeded') continue
          if (!await adapter.validateCompleted(completed, record, step.checkpoint, context)) {
            const update: Partial<CoreStateType> = completed === 'architect'
              ? { architecture: null, development: null, verifyResult: null, review: null, archived: null, plan: [] }
              : completed === 'verify' ? { verifyResult: null, review: null, archived: null }
                : completed === 'reviewer' ? { review: null, archived: null } : {}
            return { status: 'succeeded', next: completed, update, output: { revalidated: false, resumeFrom: completed } }
          }
        }
      }
      const invoke = createRoleInvoker({ context: binding.context, config, registry: deps.registry, openspec, roleState: deps.roleState(context),
        onAgentEvent: (role, event) => context.progress({ type: 'agent-event', payload: json({ role, event }) }) })
      const localConfig = { ...config, verification: config.verification.filter(command => binding.context.repositories.some(repository => repository.id === command.repositoryId)) }
      const nodes = coreNodes({ ...metadata, context: binding.context, config: localConfig, change: binding.change, openspec, invoke,
        archiveApproved: () => prepared.archiveConsent !== undefined && prepared.archiveConsent === consent(binding),
        note: (role, text) => context.progress({ type: 'agent-event', payload: { role, event: { kind: 'text', text } } }),
        onVerificationOutput: text => context.progress({ type: 'verification-output', payload: { text } }),
      })
      return nodes[id].run(state, step)
    },
    snapshot(context) {
      const prepared = bindings.get(context.frame.scope.id) ?? bindings.get(instanceKey(context))
      if (!prepared) throw new EngineError('implementation_not_initialized', 'Implementation snapshot requires its initialized scope')
      refresh(prepared.binding, context)
      return captureImplementationJournal(prepared.binding)
    },
    async summarize(state, context) {
      const prepared = bindings.get(instanceKey(context))
      if (!prepared) throw new EngineError('implementation_not_initialized', 'Implementation summary requires its initialized scope')
      refresh(prepared.binding, context)
      const inspection = inspectPipeline(prepared.binding.context), pipeline = journal(prepared.binding.context)
      const archived = inspection.phases.archive.status === 'done' && inspection.completion.implementation === 'complete' && inspection.verification.valid && inspection.acceptance.valid
      const outcome = archived ? 'next' : state.review?.approved === false || state.verifyResult?.valid === false ? 'rejected' : 'failed'
      const receipt = pipeline.verification
      const verified = receipt !== undefined && inspection.verification.valid && !receipt.unverifiedRepositories?.length && receipt.commands.length > 0
      return { outcome, ...(outcome === 'failed' ? { status: 'failed' as const } : {}),
        output: json({ completion: inspection.completion, review: state.review, archived: state.archived }),
        completion: { ok: archived, verified, reasons: inspection.completion.reasons },
        ...(receipt ? { receipt: receiptEvidence({ ...receipt, valid: inspection.verification.valid }),
          verified: verified ? { receiptId: receipt.id, candidateHash: receipt.candidateHash, atTransition: context.frame.transition, revision: context.frame.transition } : null } : {}) }
    },
    async validateCompleted(id, record, checkpoint, context) {
      const prepared = bindings.get(context.frame.scope.id)
      if (!prepared) throw new EngineError('implementation_not_initialized', 'Implementation validation requires its initialized scope')
      const inspection = inspectPipeline(prepared.binding.context)
      if (id === 'architect') return inspection.phases.architect.status === 'done' && inspection.resumePhase !== 'architect'
      const retryingArchive = checkpoint.nextStep === 'archive' && checkpoint.steps.archive?.status === 'failed'
      if (id === 'verify' && !retryingArchive && checkpoint.status !== 'succeeded' && inspection.phases.archive.status !== 'done' && !(checkpoint.pendingApproval?.stepId === 'archive' && !checkpoint.pendingApproval.grantedAt)) return false
      if (id === 'verify') return (record.output as { valid?: boolean } | undefined)?.valid !== false && inspection.verification.valid
      if (id === 'reviewer') return inspection.phases.reviewer.status === 'done' && inspection.verification.valid && !['architect', 'developer', 'reviewer'].includes(inspection.resumePhase ?? '')
      if (id === 'archive') return inspection.phases.archive.status === 'done'
      return true
    },
  }
  return adapter
}
