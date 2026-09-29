import type { PipelineCompletion } from '../../pipeline/pipeline-state.js'
import { efficiencySummary } from '../efficiency-summary.js'
import type { WorkflowState } from '../workflow-types.js'
import type { RunLedger } from './checkpoint/ledger.js'
import type { CandidateState, EngineCompletion, ReceiptEvidence, VerifiedState } from './contracts.js'
import type { DefinitionRunRequest } from './preflight.js'

/** Derive diagnostics from committed records; status never inspects or mutates a journal. */
export function definitionEfficiencySummary(ledger: RunLedger, state: WorkflowState) {
  const row = ledger.run(), request = JSON.parse(String(row.request_json)) as DefinitionRunRequest
  const candidate = row.candidate_json ? JSON.parse(String(row.candidate_json)) as CandidateState : undefined
  const verified = row.verified_json ? JSON.parse(String(row.verified_json)) as VerifiedState : undefined
  const completion = row.completion_json ? JSON.parse(String(row.completion_json)) as EngineCompletion : undefined
  const receipts = ledger.db.sqlite.prepare('SELECT receipt_json FROM receipts WHERE run_id=? ORDER BY created_at').all(ledger.runId)
    .map(value => JSON.parse(String(value.receipt_json)) as ReceiptEvidence)
  const current = receipts.find(receipt => receipt.id === verified?.receiptId)
  const evidence = current?.evidence as { planHash?: string; commands?: Array<{ evidenceId?: string }>; notRunEvidenceIds?: string[] } | undefined
  const checks = new Map<string, Record<string, unknown>>()
  for (const entry of ledger.db.sqlite.prepare("SELECT value_json FROM piece_state WHERE run_id=? AND key LIKE 'evidence:check:%'").all(ledger.runId)) {
    const value = JSON.parse(String(entry.value_json)) as Record<string, unknown>
    if (typeof value.evidenceId === 'string') checks.set(value.evidenceId, { ...value, id: value.evidenceId })
  }
  for (const receipt of receipts) {
    const source = receipt.evidence as { planHash?: string; commands?: Array<Record<string, unknown>> }
    for (const command of source.commands ?? []) if (typeof command.evidenceId === 'string' && !checks.has(command.evidenceId)) {
      checks.set(command.evidenceId, { ...command, id: command.evidenceId, planHash: source.planHash, candidateHash: receipt.candidateHash })
    }
  }
  const native = [...state.history].reverse().map(attempt => (attempt.output as { completion?: PipelineCompletion } | undefined)?.completion).find(value => value?.archive !== undefined)
  const projected: PipelineCompletion = { implementation: completion?.ok ? 'complete' : 'incomplete',
    validation: completion?.verified ? 'verified' : completion && !completion.ok ? 'blocked' : 'pending',
    archive: native?.archive ?? 'pending', delivery: 'pending-host', reasons: completion?.reasons ?? [] }
  return { ...efficiencySummary(state, request.context, request.config, projected,
    candidate ? { candidateHash: candidate.hash, ...(evidence?.planHash ? { planHash: evidence.planHash } : {}),
      ...(evidence ? { verification: { receipt: { commands: evidence.commands ?? [], notRunEvidenceIds: evidence.notRunEvidenceIds } } } : {}) } : undefined,
    { items: [...checks.values()], available: true }), reservations: ledger.reservationStatus() }
}
