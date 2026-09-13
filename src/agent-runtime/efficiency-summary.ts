import { readVerificationEvidence, type PipelineContext, type PipelineCompletion } from '../installer/runtime/pipeline-state.js'
import type { RuntimeConfig } from './executor-types.js'
import type { WorkflowState } from './workflow-types.js'
import { runtimeEfficiency } from './efficiency.js'

/** Compact derived view. Durable invocation/evidence IDs remain the accounting authority. */
export function efficiencySummary(state: WorkflowState, context: PipelineContext, config: RuntimeConfig | undefined, completion?: PipelineCompletion, identity?: { planHash?: string; candidateHash: string; verification?: { receipt?: { commands: Array<{ evidenceId?: string }>; notRunEvidenceIds?: string[] } } }) {
  const invocations = state.history.flatMap(attempt => [...(attempt.invocations ?? []), ...(attempt.pendingInvocations ?? [])].map(call => ({ ...call, role: attempt.stepId, attemptId: attempt.id })))
  const kinds = ['initial', 'correction', 'repair', 'deepen', 'session-fallback'] as const
  const byKind = Object.fromEntries(kinds.map(kind => [kind, invocations.filter(call => call.kind === kind).length]))
  const measured = state.history.every(attempt => !attempt.pendingInvocations?.length) && state.history.every(attempt => !['architect', 'developer', 'reviewer'].includes(attempt.stepId) || attempt.invocations !== undefined) && invocations.every(call => call.kind !== undefined && call.promptBytes !== undefined)
  const bytes = (key: 'promptBytes' | 'contextBytes' | 'handoffBytes') => invocations.every(call => call[key] !== undefined) ? invocations.reduce((sum, call) => sum + call[key]!, 0) : null
  const checkIds = new Set<string>()
  let checks: Array<Record<string, unknown>> = [], evidenceAvailable = true
  try {
    let cursor: string | undefined
    do {
      const page = readVerificationEvidence(context, { limit: 100, ...(cursor ? { cursor } : {}) })
      if (!page.available) { evidenceAvailable = false; break }
      for (const row of page.items ?? []) if (typeof row.id === 'string' && !checkIds.has(row.id)) { checkIds.add(row.id); checks.push(row) }
      if (checkIds.size > 10000) throw new Error('Evidence summary limit')
      cursor = 'nextCursor' in page ? page.nextCursor : undefined
    } while (cursor)
  } catch { checks = []; evidenceAvailable = false }
  const checksComplete = evidenceAvailable && checks.every(check => check.status !== 'interrupted' && typeof check.durationMs === 'number')
  const escalatedRoles = new Set<string>()
  const escalations = invocations.filter(call => { if (call.tier !== 'escalation' || escalatedRoles.has(call.role)) return false; escalatedRoles.add(call.role); return true }).map(call => ({ role: call.role, attemptId: call.attemptId, provider: call.provider, model: call.model ?? null, effort: call.requestedEffort ?? null, reason: call.routeReason ?? null }))
  return {
    schemaVersion: 1 as const, currentEvidenceIds: [...(identity?.verification?.receipt?.commands.flatMap(command => command.evidenceId ? [command.evidenceId] : []) ?? []), ...(identity?.verification?.receipt?.notRunEvidenceIds ?? [])].slice(0, 100), planHash: identity?.planHash ?? null, candidateHash: identity?.candidateHash ?? null, runId: state.runId, workflowVersion: state.workflowVersion,
    technicalAcceptance: completion?.validation === 'verified' ? 'validated' : completion?.validation === 'with-exceptions' ? 'with-exceptions' : completion?.validation === 'blocked' ? 'blocked' : 'pending',
    archive: completion?.archive ?? 'pending', delivery: completion?.delivery ?? 'pending',
    roles: (['architect', 'developer', 'reviewer'] as const).map(role => {
      const selected = config?.agents[role], latest = invocations.filter(call => call.role === role).at(-1)
      return { role, provider: latest?.provider ?? selected?.provider ?? null, model: latest?.model ?? selected?.model ?? null, effort: latest ? latest.requestedEffort ?? null : selected?.effort ?? null, observedModel: null, observedEffort: null, origin: 'frozen-runtime-config', tier: latest?.tier ?? 'base' }
    }),
    invocations: { byKind, total: invocations.length, complete: measured, promptBytes: bytes('promptBytes'), contextBytes: bytes('contextBytes'), handoffBytes: bytes('handoffBytes'), fullContexts: invocations.filter(call => call.contextMode === 'full').length, incrementalContexts: invocations.filter(call => call.contextMode === 'incremental').length },
    escalations: escalations.slice(-16), escalationsTruncated: escalations.length > 16,
    checks: { invalidated: identity && evidenceAvailable ? checks.filter(check => check.planHash !== identity.planHash || check.candidateHash !== identity.candidateHash || check.reuseReason === 'snapshot-inputs-changed-during-verification').length : null, available: evidenceAvailable, complete: checksComplete, executed: checksComplete ? checks.filter(check => check.disposition === 'executed').length : null, reused: evidenceAvailable ? checks.filter(check => check.disposition === 'reused').length : null, notRun: evidenceAvailable ? checks.filter(check => check.disposition === 'not-run').length : null, durationMs: checksComplete ? checks.reduce((sum, check) => sum + (typeof check.durationMs === 'number' ? check.durationMs : 0), 0) : null },
    metrics: runtimeEfficiency(state),
  }
}
