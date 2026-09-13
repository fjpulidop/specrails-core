import type { AgentRole, RuntimeAgentConfig } from './executor-types.js'
import type { WorkflowState } from './workflow-types.js'
import type { RoleExecutionState } from './role-state.js'

export type InvocationKind = 'initial' | 'correction' | 'repair' | 'deepen' | 'session-fallback'
export function failedCandidateCount(checkpoint: Pick<WorkflowState, 'history'>): number {
  let candidate: string | undefined
  const failures = new Set<string>()
  for (const attempt of checkpoint.history) {
    if (attempt.stepId === 'developer') candidate = attempt.id
    if (!candidate || attempt.status !== 'succeeded') continue
    const output = attempt.output as { valid?: unknown; approved?: unknown } | undefined
    if ((attempt.stepId === 'verify' && output?.valid === false) || (attempt.stepId === 'reviewer' && output?.approved === false)) failures.add(candidate)
  }
  return failures.size
}
export function selectRoleRoute(role: AgentRole, selected: RuntimeAgentConfig, kind: InvocationKind, checkpoint: Pick<WorkflowState, 'history'>, previous?: RoleExecutionState['routes'][AgentRole]): { tier: 'base' | 'escalation'; reason: string; selection: RuntimeAgentConfig } {
  const reason = previous?.tier === 'escalation' ? previous.reason
    : role === 'architect' && kind === 'deepen' ? 'Architect requested its single deeper investigation'
      : role === 'reviewer' && kind === 'repair' ? 'Reviewer required its single protocol repair'
        : role === 'developer' && ['initial', 'correction'].includes(kind) && failedCandidateCount(checkpoint) >= 2 ? 'Two completed candidate attempts failed verification or review'
          : undefined
  if (!selected.escalation || !reason) return { tier: 'base', reason: 'Configured base role selection', selection: selected }
  return { tier: 'escalation', reason, selection: {
    provider: selected.provider, model: selected.escalation.model,
    ...(selected.maxTurns === undefined ? {} : { maxTurns: selected.maxTurns }),
    ...(selected.escalation.effort === undefined ? {} : { effort: selected.escalation.effort }),
  } }
}
