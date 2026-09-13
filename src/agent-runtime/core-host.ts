import { fingerprint } from './durable-store.js'
import { prepareOpenSpec, roleOpenSpecContext } from './openspec.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  fingerprintCandidate, initializePipeline, inspectPipeline, pipelineStateDirectory, validatePipelineContext, validateVerificationRequest,
  type PipelineContext,
} from '../installer/runtime/pipeline-state.js'
import { normalizeRuntimeConfig } from './config.js'
import { createExecutorRegistry, type ExecutorRegistry } from './executors.js'
import type { AgentEvent, AgentRole, RuntimeConfig } from './executor-types.js'
import { archive, child, journal, parseAgentObject, SLUG } from './graph/artifacts.js'
import { coreNodes } from './graph/nodes.js'
import { resolveReviewPolicy } from './graph/review-policy.js'
import { createRoleInvoker } from './graph/roles.js'
import { CORE_NODE_ORDER, CoreState, type CoreStateType } from './graph/state.js'
import { ROLE_INSTRUCTIONS_VERSION } from './prompts.js'
import { assertEffortSupported } from './capabilities.js'
import { runtimePackageIntegrity, type RuntimeIdentity } from './runtime-identity.js'
import { readWorkflowState, runWorkflow } from './workflow.js'
import type { JsonValue, WorkflowEvent, WorkflowSpan, WorkflowState } from './workflow-types.js'

export const RUNTIME_API_VERSION = 1
export const CORE_WORKFLOW_VERSION = '5'
export const CORE_PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
export function coreRuntimeIdentity(): RuntimeIdentity {
  return { packageVersion: CORE_PACKAGE_VERSION, workflowVersion: CORE_WORKFLOW_VERSION, instructionsVersion: String(ROLE_INSTRUCTIONS_VERSION), packageIntegrity: runtimePackageIntegrity(), apiVersion: 1 }
}
export { parseAgentObject }

export interface CoreWorkflowOptions {
  context: PipelineContext | unknown
  change: string
  config: RuntimeConfig | unknown
  registry?: ExecutorRegistry
  signal?: AbortSignal
  resume?: boolean
  approve?: string[]
  /** Answer to the architect's pending question; resumes the paused run. */
  answer?: string
  recoverInterrupted?: string[]
  invalidate?: string[]
  onEvent?: (event: WorkflowEvent) => void | Promise<void>
  onSpan?: (span: WorkflowSpan) => void | Promise<void>
  onAgentEvent?: (role: AgentRole, event: AgentEvent) => void
  onVerificationOutput?: (text: string) => void
}

/** Read-only admission: validate scope, limits and actual effort support before freezing a request. */
export async function preflightCoreWorkflow(options: Pick<CoreWorkflowOptions, 'context' | 'config' | 'change' | 'registry'>) {
  const context = validatePipelineContext(options.context)
  const config = normalizeRuntimeConfig(options.config, { registeredProviderIds: options.registry?.ids() })
  if (context.ownership.git !== 'host') throw new Error('Programmatic runtime requires host-owned delivery; Core shipping is not implemented by this workflow')
  if (!SLUG.test(options.change) || options.change.length > 100) throw new Error('Invalid workflow change name')
  if (!context.specs.length) throw new Error('Programmatic implementation requires a frozen spec or goal')
  // Configured commands are validated against the frozen scope up front; coverage
  // is completed by the architect (or left explicitly unverified) at run time.
  if (config.verification.length) validateVerificationRequest(context, { kind: 'scoped', commands: config.verification })
  const registry = options.registry ?? createExecutorRegistry(config)
  for (const selected of Object.values(config.agents)) {
    registry.validateLimits(selected.provider, config.limits ?? {})
    for (const tier of [selected, ...(selected.escalation ? [selected.escalation] : [])]) {
      if (tier.effort !== undefined) assertEffortSupported(tier, await registry.capabilities(selected.provider, tier.model))
    }
  }
  return { context, config, registry }
}

/**
 * Runs the Core implementation graph: architect → developer → verify → reviewer → archive,
 * with bounded corrections routed back to the developer, an autonomous investigation pass
 * before a low-confidence design asks the requester, real verification receipts, acceptance
 * evidence bound to the exact candidate, and an optional approval before archive.
 */
export async function runCoreWorkflow(options: CoreWorkflowOptions): Promise<WorkflowState> {
  const { context, config, registry } = await preflightCoreWorkflow(options)
  const directory = path.join(pipelineStateDirectory(context), 'agent-workflow')
  const previous = await readWorkflowState(directory, context.runId)
  if (previous && previous.workflowVersion !== CORE_WORKFLOW_VERSION) throw new Error('This saved run requires its original runtime package. Restore the retained original Core runtime; its checkpoint has not been migrated.')
  const state = initializePipeline(context, options.change)
  if (!previous && existsSync(path.join(context.artifactRoot, 'openspec/changes', options.change))) {
    throw new Error('Change already exists without a programmatic checkpoint; use a new change name')
  }
  if (state.phases.archive.status === 'done') {
    const checked = inspectPipeline(context)
    if (!checked.verification.valid || (checked.resumePhase && !['ship', 'ci'].includes(checked.resumePhase))) {
      throw new Error('Archived run evidence changed; start a new run for the changed candidate or environment')
    }
  }
  const prepared = prepareOpenSpec(context.artifactRoot, options.change, directory)
  const openspec = Object.fromEntries((['architect', 'developer', 'reviewer'] as const).map(role => {
    const provider = config.providers.find(item => item.id === config.agents[role].provider)
    return [role, roleOpenSpecContext(prepared, context.artifactRoot, options.change, directory, role, provider?.kind === 'cli' ? provider.cli : 'claude')]
  })) as Record<AgentRole, ReturnType<typeof roleOpenSpecContext>>
  for (const role of ['architect', 'developer', 'reviewer'] as const) await registry.get(config.agents[role].provider).validateOpenSpec?.(openspec[role])
  const attempts = config.limits?.maxAttempts ?? 3
  const note = (role: AgentRole, text: string): void => { try { options.onAgentEvent?.(role, { kind: 'text', text }) } catch { /* Observer cannot replay agent effects. */ } }
  const invoke = createRoleInvoker({ context, config, registry, openspec, onAgentEvent: options.onAgentEvent })
  let grantedArchiveScope: string | undefined
  const archiveConsent = (): string => {
    const pipeline = journal(context)
    return fingerprint({ candidate: fingerprintCandidate(pipeline), plan: pipeline.verificationPlan?.hash ?? null,
      criteria: pipeline.acceptance?.criteria.map(({ evidence: _evidence, ...criterion }) => criterion) ?? null,
      checks: pipeline.acceptance?.checks.map(({ evidence: _evidence, ...check }) => check) ?? null })
  }
  const nodes = coreNodes({ archiveApproved: () => grantedArchiveScope !== undefined && grantedArchiveScope === archiveConsent(), context, config, openspec, change: options.change, attempts, policy: resolveReviewPolicy(config), invoke, note, onVerificationOutput: options.onVerificationOutput })
  return runWorkflow<CoreStateType>({
    directory, runId: context.runId,
    input: JSON.parse(JSON.stringify({ context, config, change: options.change, coreVersion: CORE_PACKAGE_VERSION, runtimeIdentity: coreRuntimeIdentity(), instructionsVersion: ROLE_INSTRUCTIONS_VERSION, openspec: prepared.identity })) as JsonValue,
    resume: options.resume, signal: options.signal, approve: options.approve, answer: options.answer, recoverInterrupted: options.recoverInterrupted, invalidate: options.invalidate,
    budget: { maxCostUsd: config.limits?.maxCostUsd, maxTokens: config.limits?.maxTokens, maxDurationMs: config.limits?.timeoutMs },
    onEvent: options.onEvent, onSpan: options.onSpan,
    validateCompleted: async (stepId, _record, checkpoint) => {
      // The engine invokes this only after acquiring its run lease and accepting
      // an explicit interrupted-write recovery. A crash after the archive rename
      // leaves Core's active artifact path temporarily absent. Reconcile that
      // one deterministic operation before checking earlier phase fingerprints;
      // transitionPipeline still verifies the saved exact-candidate approval.
      if (stepId === 'architect' && checkpoint.nextStep === 'archive'
        && checkpoint.steps.archive?.status === 'interrupted'
        && options.recoverInterrupted?.includes('archive')
        && journal(context).phases.archive.status === 'running'
        && !existsSync(child(context.artifactRoot, 'openspec/changes/' + options.change))) {
        await archive(context, options.change)
      }
      const inspection = inspectPipeline(context)
      if (stepId === 'architect' && checkpoint.pendingApproval?.stepId === 'archive' && options.approve?.includes('archive') && inspection.verification.valid && inspection.acceptance.valid && inspection.phases.reviewer.status === 'done') grantedArchiveScope = archiveConsent()
      if (stepId === 'architect') return inspection.phases.architect.status === 'done' && inspection.resumePhase !== 'architect'
      if (stepId === 'verify' && checkpoint.status !== 'succeeded' && inspection.phases.archive.status !== 'done' && !(checkpoint.pendingApproval?.stepId === 'archive' && !options.approve?.includes('archive') && !checkpoint.pendingApproval.grantedAt)) return false
      if (stepId === 'verify') return (_record.output as { valid?: boolean } | undefined)?.valid !== false && inspection.verification.valid
      if (stepId === 'reviewer') return inspection.phases.reviewer.status === 'done' && inspection.verification.valid && !['architect', 'developer', 'reviewer'].includes(inspection.resumePhase ?? '')
      if (stepId === 'archive') return inspection.phases.archive.status === 'done'
      return true
    },
    workflow: {
      id: 'specrails-implementation', version: CORE_WORKFLOW_VERSION, schema: CoreState, entry: 'architect',
      maxTransitions: attempts * 3 + 3,
      nodes: Object.fromEntries(CORE_NODE_ORDER.map(id => [id, nodes[id]])),
    },
  })
}
