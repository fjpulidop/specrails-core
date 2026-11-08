import { randomUUID } from 'node:crypto'
import { RunLease } from './engine/checkpoint/lease.js'
import type { ExecutionLease } from './engine/contracts.js'
import { lstat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { inspectPipeline, pipelineStateDirectory, validatePipelineContext, type PipelineContext } from '../pipeline/pipeline-state.js'
import { fingerprint, readWorkflowState } from './durable-store.js'
import { readVerificationPlan } from './verification-plan.js'
import { RunDatabase } from './engine/checkpoint/database.js'
import { EngineError } from './engine/contracts.js'
import { contentDigest } from './engine/canonical-json.js'
import { observeLedger, projectRunStatus } from './engine/run-status.js'
import type { ImplementationBinding } from './engine/pieces/implementation-binding.js'

export type RecoveryEngine = 'legacy' | 'v2'
export interface NormalizedRecoveryState {
  status: string
  nextStep: string | null
  steps: Record<string, { status: string }>
  candidateHash: string | null
}
const RECOVERY_RECOMMENDATION = 'Preserve the original worktree; inspect its saved evidence and fork the run through the supported control.'
export class RecoveryUnsupportedEngineError extends EngineError {
  readonly recommendation = RECOVERY_RECOMMENDATION
  constructor(readonly action: string, reason: string) {
    const recommendation = RECOVERY_RECOMMENDATION
    super('recovery_unsupported_engine', `Recovery ${action} is unsupported for this v2 run: ${reason}. ${recommendation}`, { action, recommendation })
    this.name = 'RecoveryUnsupportedEngineError'
  }
}
export interface RecoveryAuthority {
  state: NormalizedRecoveryState
  context?: PipelineContext
  journalContext?: PipelineContext
  inspection?: ReturnType<typeof inspectPipeline>
  plan: ReturnType<typeof readVerificationPlan>
  archived: boolean
  completed: boolean
  activeLease: boolean
  identity: string
}
const databasePath = (runDir: string) => path.join(runDir, 'agent-workflow', 'run.sqlite')
async function present(filename: string): Promise<boolean> {
  try { await lstat(filename); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
export async function detectRecoveryEngine(runDir: string): Promise<RecoveryEngine | null> {
  if (await present(databasePath(runDir))) return 'v2'
  if (await present(path.join(runDir, 'agent-workflow', path.basename(runDir), 'checkpoint.json'))) return 'legacy'
  return null
}

/** Bindings authorize existing journals, never a guessed or reconstructed scope. */
function boundContext(parent: PipelineContext, binding: ImplementationBinding, scopeId: string, nodePath: string): PipelineContext {
  if (binding.parentRunId !== parent.runId || binding.scopeId !== scopeId || binding.nodePath !== nodePath) throw new Error('Implementation binding identity differs from its saved scope')
  const context = validatePipelineContext(binding.context)
  const digest = contentDigest({ parentRunId: parent.runId, scopeId, nodePath }).slice(0, 24)
  const standalone = context.runId === parent.runId
  if (standalone ? fingerprint(context) !== fingerprint(parent) : context.runId !== parent.runId.slice(0, 80) + '-impl-' + digest) throw new Error('Implementation journal run ID differs from its derived binding')
  if (binding.directory !== pipelineStateDirectory(context)) throw new Error('Implementation journal directory differs from its derived binding')
  if (context.backlogRoot !== parent.backlogRoot || fingerprint(context.ownership) !== fingerprint(parent.ownership)
    || context.repositories.some(repo => !parent.repositories.some(saved => fingerprint(repo) === fingerprint(saved)))
    || context.specs.some(spec => !parent.specs.some(saved => fingerprint({ ...spec, repositoryIds: saved.repositoryIds ?? [] }) === fingerprint({ ...saved, repositoryIds: saved.repositoryIds ?? [] })))) throw new Error('Implementation journal exceeds the frozen parent scope')
  const artifact = parent.repositories.find(repo => repo.id === context.artifactRepositoryId)
  if (!artifact || context.artifactRoot !== (artifact.id === parent.artifactRepositoryId ? parent.artifactRoot : artifact.path)) throw new Error('Implementation journal artifact root differs from the frozen parent scope')
  return context
}

export async function readRecoveryAuthority(runDir: string, engine: RecoveryEngine, action: string, expectedContext?: PipelineContext): Promise<RecoveryAuthority> {
  if (engine === 'legacy') {
    const saved = await readWorkflowState(path.join(runDir, 'agent-workflow'), path.basename(runDir))
    if (!saved) throw new Error('Saved legacy checkpoint disappeared; inspect the run again')
    const journalFile = path.join(runDir, 'state.json')
    const context = expectedContext ?? (existsSync(journalFile) ? validatePipelineContext(JSON.parse(readFileSync(journalFile, 'utf8')).context) : undefined)
    const inspection = context ? inspectPipeline(context) : undefined
    return { state: { status: saved.status, nextStep: saved.nextStep, steps: saved.steps, candidateHash: inspection?.candidateHash ?? null },
      context, journalContext: context, inspection, plan: context ? readVerificationPlan(context) : null,
      archived: inspection?.phases.archive.status === 'done', completed: saved.status === 'succeeded', activeLease: false, identity: fingerprint(saved) }
  }
  let db: RunDatabase | undefined
  try {
    db = await RunDatabase.open(databasePath(runDir), { readOnly: true })
    const ledger = observeLedger(db), row = ledger.run()
    const request = JSON.parse(String(row.request_json)) as { context: unknown }
    const context = validatePipelineContext(request.context)
    if (row.engine_version !== 2 || row.run_id !== context.runId || path.resolve(runDir) !== pipelineStateDirectory(context)
      || expectedContext && fingerprint(context) !== fingerprint(expectedContext)) throw new Error('Saved run ID or frozen context differs from the requested run')
    const view = projectRunStatus(ledger)
    const observed: NormalizedRecoveryState = { status: view.state.status, nextStep: view.state.nextStep,
      steps: Object.fromEntries(view.state.scopes.map(step => [JSON.stringify([step.scopeId, step.nodePath]), { status: step.status }])), candidateHash: null }
    const completed = view.state.status === 'succeeded' || view.completion?.ok === true
    if (['history', 'list_files', 'read_file', 'diff'].includes(action)) return {
      state: observed, context, plan: null, archived: false, completed, activeLease: view.state.lease?.active === true,
      identity: fingerprint({ state: observed, request: JSON.parse(String(row.request_json)) }),
    }
    const bindings = db.sqlite.prepare("SELECT scope_id,node_path,value_json FROM piece_state WHERE run_id=? AND key='binding:implementation'").all(context.runId)
    const journals = new Map<string, { context: PipelineContext; inspection: ReturnType<typeof inspectPipeline> }>()
    if (existsSync(path.join(runDir, 'state.json'))) journals.set(runDir, { context, inspection: inspectPipeline(context) })
    for (const row of bindings) {
      const bound = boundContext(context, JSON.parse(String(row.value_json)) as ImplementationBinding, String(row.scope_id), String(row.node_path))
      const directory = pipelineStateDirectory(bound)
      journals.set(directory, { context: bound, inspection: inspectPipeline(bound) })
    }
    const applicable = [...journals.values()].filter(journal => fingerprint(journal.context.repositories) === fingerprint(context.repositories) && fingerprint(journal.context.specs) === fingerprint(context.specs))
    const journal = journals.get(runDir) ?? (applicable.length === 1 ? applicable[0] : undefined)
    const ambiguous = !journals.has(runDir) && applicable.length > 1
    if (ambiguous) throw new Error('Multiple implementation journals cover this scope; the recovery request has no scope selector')
    const plan = readVerificationPlan(journal?.context ?? context)
    const state: NormalizedRecoveryState = { ...observed, candidateHash: journal?.inspection.candidateHash ?? null }
    return { state, context, journalContext: journal?.context, inspection: journal?.inspection, plan,
      archived: [...journals.values()].some(journal => journal.inspection.phases.archive.status === 'done'), completed,
      activeLease: view.state.lease?.active === true,
      identity: fingerprint({ state, completion: view.completion, scopes: view.state.scopes, plan: plan ? { integrity: plan.integrity, planHash: plan.planHash } : null, request: JSON.parse(String(row.request_json)), bindings: bindings.map(row => ({ ...row })), journals: [...journals.values()].map(journal => ({ context: journal.context, phases: journal.inspection.phases, planHash: journal.inspection.planHash ?? null })) }) }
  } catch (error) {
    if (error instanceof RecoveryUnsupportedEngineError) throw error
    throw new RecoveryUnsupportedEngineError(action, error instanceof Error ? error.message : String(error))
  } finally { db?.close() }
}
export async function readNormalizedRecoveryState(runDir: string, engine: RecoveryEngine): Promise<NormalizedRecoveryState> {
  return (await readRecoveryAuthority(runDir, engine, 'inspect')).state
}

export function requireRecoveryMutationAuthority(authority: RecoveryAuthority, action: string): void {
  if (!authority.inspection || !authority.journalContext || !authority.state.candidateHash) throw new RecoveryUnsupportedEngineError(action, 'current candidate/archive authority is unavailable or does not cover the complete frozen scope')
}

export interface RecoveryExecutionLease {
  signal: AbortSignal
  assert(): void
  assertOwnership(): void
  release(): void
}

/** The directory lease serializes history; only this SQLite token fences engine execution. */
export async function acquireRecoveryExecutionLease(runDir: string, context: PipelineContext, before: RecoveryAuthority, action: string, signal?: AbortSignal): Promise<RecoveryExecutionLease> {
  requireRecoveryMutationAuthority(before, action)
  signal?.throwIfAborted()
  const database = await RunDatabase.open(databasePath(runDir))
  const lease = new RunLease(database, context.runId)
  let token: ExecutionLease | undefined, stopHeartbeat: (() => void) | undefined
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
  let released = false
  const release = () => {
    if (released) return
    released = true
    stopHeartbeat?.(); signal?.removeEventListener('abort', abort)
    try { if (token) lease.release(token) } finally { database.close() }
  }
  try {
    token = lease.acquire(randomUUID())
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    stopHeartbeat = lease.heartbeat(token, error => controller.abort(error))
    const current = await readRecoveryAuthority(runDir, 'v2', action, context)
    if (before.identity !== current.identity) throw new Error('Recovery authority changed during lease acquisition; inspect the run again')
    const owned = token
    return { signal: controller.signal,
      assert() { controller.signal.throwIfAborted(); lease.assert(owned) },
      assertOwnership() { lease.assert(owned) }, release }
  } catch (error) { release(); throw error }
}
