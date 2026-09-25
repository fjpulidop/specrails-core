// Correction rounds must converge. A fixer round that leaves the change as it
// was, the same failure surviving round after round, or a review correction
// that brings back a failure an earlier round had fixed, are loops: repeating
// the checks cannot change their outcome. The host stops and says why instead
// of spending another round (observed: verify ↔ fixer ↔ review cycling on a
// credential problem until the requester cancelled the run).
import type { VerificationReceipt } from '../../pipeline/pipeline-state.js'
import { fingerprint } from '../durable-store.js'
import type { WorkflowState } from '../workflow-types.js'

/** One verify visit, as the convergence guard remembers it. */
export interface VerifyOutcome {
  at: string
  candidateHash: string
  planHash: string
  passed: boolean
  /** Normalized identity of the first failure: the command plus its output with volatile details removed. */
  signature?: string
  summary?: string
}

/** Verify visits since the latest explicit resume: a human continuing a blocked run grants a fresh budget, as for attempts. */
export function outcomesSinceResume(history: readonly VerifyOutcome[], checkpoint: WorkflowState): VerifyOutcome[] {
  const resumed = [...checkpoint.events].reverse().find(event => event.type === 'workflow_resumed')
  return history.filter(entry => !resumed || entry.at >= resumed.timestamp)
}

function normalized(output: string, roots: readonly string[]): string {
  let text = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  for (const root of [...roots].sort((a, b) => b.length - a.length)) text = text.split(root).join('<repo>')
  return text.split(/\r?\n/)
    .map(line => line.replace(/\b[0-9a-f]{7,64}\b/gi, '#').replace(/\d+(?:[.,]\d+)*/g, '0').replace(/\s+/g, ' ').trim())
    .filter(Boolean).slice(-40).join('\n')
}
/** The last line that says what went wrong, bounded. */
function headline(output: string): string {
  const lines = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const telling = [...lines].reverse().find(line => /error|fail|✕|×|not found|cannot|denied|refused|forbidden|unauthori[sz]ed/i.test(line))
  return (telling ?? lines.at(-1) ?? '').slice(0, 300)
}
/** Identity and one-line description of a failed receipt (or of a host finding that failed a green receipt). */
export function describeFailure(receipt: Pick<VerificationReceipt, 'commands' | 'reason'>, roots: readonly string[], finding?: string): { signature: string; summary: string } {
  if (finding) return { signature: fingerprint({ finding: normalized(finding, roots) }), summary: finding.slice(0, 300) }
  const failed = receipt.commands.find(command => command.exitCode !== 0)
  if (!failed) return { signature: fingerprint({ reason: receipt.reason ?? 'verification failed' }), summary: receipt.reason ?? 'verification failed' }
  const name = failed.label ?? [failed.command, ...failed.args].join(' ')
  const detail = headline(failed.output)
  return {
    signature: fingerprint({ check: failed.key ?? [failed.command, ...failed.args, failed.cwd], exitCode: failed.exitCode, output: normalized(failed.output, roots) }),
    summary: `${name} exited ${failed.exitCode}${detail ? `: ${detail}` : ''}`.slice(0, 400),
  }
}

/**
 * Why the failure just recorded (`current`, not yet in `history`) proves the
 * correction loop is not converging, or undefined when another round can help.
 */
export function divergence(history: readonly VerifyOutcome[], current: VerifyOutcome): string | undefined {
  if (current.passed || !current.signature) return undefined
  const cycle = history.find(entry => !entry.passed && entry.candidateHash === current.candidateHash && entry.planHash === current.planHash)
  if (cycle) return `The correction round returned the change to a state that already failed verification (${current.summary}). Running the same checks again cannot pass.`
  let repeats = 0
  for (const entry of [...history].reverse()) {
    if (entry.passed || entry.signature !== current.signature) break
    repeats++
  }
  if (repeats >= 2) return `The same verification failure survived ${repeats} correction rounds unchanged (${current.summary}). It is most likely outside what this change can fix: a pre-existing failure, another package, or the environment.`
  const previous = history.at(-1)
  if (previous?.passed && history.some(entry => !entry.passed && entry.signature === current.signature)) {
    return `A review correction brought back a verification failure that an earlier correction had fixed (${current.summary}). The review request and the checks pull in opposite directions; decide which one applies before resuming.`
  }
  return undefined
}

/** The same test for a candidate that has not been verified again yet: an unchanged failed candidate is not worth a new run. */
export function unchangedFailure(history: readonly VerifyOutcome[], candidateHash: string, planHash: string): VerifyOutcome | undefined {
  return [...history].reverse().find(entry => !entry.passed && entry.candidateHash === candidateHash && entry.planHash === planHash)
}
