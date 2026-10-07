import type { SessionSnapshot } from './snapshot.js'

export interface InterruptionNotice {
  text: string
  subagentIds: string[]
  inputIds: string[]
}

const REASONS: Readonly<Record<string, string>> = Object.freeze({
  user_stop: 'stopped by the user',
  host_request: 'stopped by the host',
  restart: 'interrupted by an application restart',
  shutdown: 'interrupted when the application closed',
  host_lost: 'interrupted when the session host was lost',
  crashed: 'interrupted when the provider process exited unexpectedly',
  stalled: 'interrupted after no progress',
  limit: 'stopped after reaching its time limit',
  project_removed: 'interrupted because its project was removed',
})

function describeReason(phase: string, reason: string | null): string {
  return (reason && REASONS[reason]) ?? (phase === 'interrupted' ? 'interrupted' : 'stopped')
}

/**
 * Build the one-time notice prefixed to the next user input after work was
 * interrupted. It names what happened and tells the agent not to relaunch it on
 * its own — providers otherwise "resume" orphaned work silently (spike finding).
 * Returns null when there is nothing to report.
 */
export function buildInterruptionNotice(state: SessionSnapshot): InterruptionNotice | null {
  const { subagentIds, inputIds } = state.pendingInterruptions
  if (subagentIds.length === 0 && inputIds.length === 0) return null
  const lines = ['[Specrails session notice]']
  if (subagentIds.length > 0) {
    lines.push('These sub-agents did not finish:')
    for (const id of subagentIds) {
      const node = state.subagents[id]
      if (node) lines.push(`- "${node.description}" (${node.agentType ?? node.kind}) — ${describeReason(node.phase, node.reason)}.`)
    }
    lines.push('Do not relaunch or resume them unless the user explicitly asks. If their results matter for the next step, say so and ask.')
  }
  if (inputIds.length > 0) {
    lines.push(`${inputIds.length === 1 ? 'One earlier user message' : `${inputIds.length} earlier user messages`} may not have reached you before the interruption; the user can resend if needed.`)
  }
  return { text: lines.join('\n'), subagentIds: [...subagentIds], inputIds: [...inputIds] }
}
