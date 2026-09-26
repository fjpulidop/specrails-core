import { RunDatabase } from './checkpoint/database.js'
import { RunLedger } from './checkpoint/ledger.js'
import { EngineError } from './contracts.js'
import type { WorkflowDefinition } from './definition-types.js'
import { ledgerWorkflowState } from './invocation-context.js'
import { runtimeEfficiency } from '../efficiency.js'
import path from 'node:path'
import { definitionEfficiencySummary } from './efficiency-summary.js'

/** An observer has no valid execution token; every attempted mutation remains fenced. */
export function observeLedger(database: RunDatabase): RunLedger {
  const row = database.sqlite.prepare('SELECT run_id,definition_json FROM runs').get()
  if (!row) throw new EngineError('run_not_found', 'Run does not exist')
  const definition = JSON.parse(String(row.definition_json)) as WorkflowDefinition
  return new RunLedger(database, { runId: String(row.run_id), owner: 'read-only-observer', epoch: -1, expiresAt: 0 }, { maxTransitions: definition.maxTransitions })
}

export function projectRunStatus(ledger: RunLedger, compact = true) {
  const row = ledger.run(), definition = JSON.parse(String(row.definition_json)) as WorkflowDefinition
  const base = ledgerWorkflowState(ledger, definition, '*'), pending = ledger.pendingInterrupts()
  const steps = ledger.db.sqlite.prepare('SELECT * FROM steps WHERE run_id=? ORDER BY node_path,scope_id').all(ledger.runId)
  const failures = ledger.db.sqlite.prepare("SELECT node_path,scope_id,branch,status,attempt,visit,ended_at,error_code,error_message FROM attempts WHERE run_id=? AND status IN ('failed','interrupted','blocked') ORDER BY started_at DESC LIMIT 8").all(ledger.runId)
  const lease = ledger.lease.current()
  const recoverable = ledger.db.sqlite.prepare("SELECT a.node_path,a.scope_id,a.attempt_id,a.status,v.effect FROM attempts a JOIN visits v ON a.visit_id=v.visit_id JOIN steps s ON s.last_attempt_id=a.attempt_id WHERE a.run_id=? AND a.terminal_digest IS NULL AND a.status IN ('running','interrupted') AND v.effect='write'").all(ledger.runId)
  const next = pending[0]?.nodePath ?? (row.status === 'succeeded' || row.status === 'cancelled' ? null : base.nextStep)
  const state = { ...(compact ? { runId: base.runId, traceId: base.traceId, status: base.status, updatedAt: base.updatedAt, usage: base.usage,
    ...(base.pendingApproval ? { pendingApproval: base.pendingApproval } : {}), ...(base.pendingQuestion ? { pendingQuestion: base.pendingQuestion } : {}) } : base),
    nextNodePath: next, nextStep: next,
    steps: Object.fromEntries(steps.map(step => [String(step.node_path), { kind: String(step.kind), status: String(step.status), visits: Number(step.visits) }])),
    scopes: steps.map(step => ({ nodePath: String(step.node_path), scopeId: String(step.scope_id), branch: step.branch_id, status: String(step.status), visits: Number(step.visits) })),
    lease: lease ? { owner: lease.owner, epoch: lease.epoch, expiresAt: lease.expiresAt, active: lease.expiresAt > Date.now() } : null,
    recoverableSteps: recoverable.map(value => ({ nodePath: String(value.node_path), scopeId: String(value.scope_id), attemptId: String(value.attempt_id), status: String(value.status), effect: 'write' as const })),
    reservations: ledger.reservationStatus(), pendingInterrupts: pending, recentFailures: failures.map(failure => ({ nodePath: failure.node_path, scopeId: failure.scope_id, branch: failure.branch,
      status: failure.status, attempt: failure.attempt, visit: failure.visit, at: failure.ended_at, error: { code: failure.error_code, message: String(failure.error_message ?? '').slice(-6000) } })),
  }
  return { type: 'runtime-status' as const, engineVersion: 2, state,
    workflow: { id: definition.id, version: definition.version, source: String(row.source) },
    completion: row.completion_json ? JSON.parse(String(row.completion_json)) : null,
    ...(row.fork_of ? { forkOf: String(row.fork_of) } : {}),
    metrics: runtimeEfficiency(base), efficiencySummary: definitionEfficiencySummary(ledger, base), revision: ledger.db.revision, eventCursor: Number(row.next_event_sequence) - 1,
  }
}

/** Status never fingerprints a repository, changes ACLs or acquires an execution lease. */
export async function statusRun(directory: string, compact = true) {
  const database = await RunDatabase.open(path.join(directory, 'run.sqlite'), { readOnly: true })
  try { return projectRunStatus(observeLedger(database), compact) } finally { database.close() }
}
