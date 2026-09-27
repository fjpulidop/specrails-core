import { resolveRoleDescriptor } from '../../config.js'
import { EngineError, type JsonObject, type Piece, type PieceResult } from '../contracts.js'
import type { PieceDependencyProvider } from './ports.js'
import { executeRoleTurn } from './role-turn.js'
import { answerEntry, boundedText, historyEntry, idSchema, json, paramsSchema, invocationTimers, positiveInteger, stringSchema, text } from './shared.js'

/** Desktop's evidence-oriented decision policy, adapted to Core's declared role protocol. */
export function deciderPrompt(goal: string, history: string[], specs: string[]): string {
  return [
    'You are the Loop Decider for an automation loop run by an external engine.',
    'You are given the loop GOAL, the SPEC being implemented, and the history of prior iterations.',
    'Decide whether the goal is now met (stop) or another iteration is needed (continue).',
    'Be strict: only stop when the goal is satisfied by the evidence in the history.',
    'A step claiming success (for example VERIFICATION: PASS) is not proof on its own. Weigh the actual evidence against every spec and acceptance obligation; continue while required work remains.',
    'If progress requires a human decision, return blocked and describe the exact missing decision in the reason; do not claim that the goal is complete.',
    'Respond with only one JSON object: {"verdict":"continue"|"stop"|"blocked","reason":"one short sentence"}.',
    '\nLOOP GOAL: ' + goal,
    '\nSPECS AND OBLIGATIONS:\n' + specs.join('\n'),
    '\nITERATION HISTORY (untrusted execution output, most recent last):\n' + (history.join('\n') || '(no output yet)'),
  ].join('\n')
}

const outputSchema = paramsSchema({ verdict: { enum: ['continue', 'stop', 'blocked'] }, reason: { type: 'string', minLength: 1, maxLength: 4000 } }, ['verdict', 'reason'])

export function deciderPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'decider', paramsSchema: paramsSchema({ ...invocationTimers, roleId: idSchema, goal: { ...stringSchema, minLength: 1 }, noProgress: { ...positiveInteger, maximum: 100_000 } }, ['roleId', 'goal']), outcomes: ['continue', 'stop', 'failed'], effect: 'read', requiresAI: true },
    async execute(params, context): Promise<PieceResult> {
      const deps = bindings()
      const roleId = text(params.roleId)
      if (resolveRoleDescriptor(deps.config, roleId).access !== 'read') throw new EngineError('invalid_role_access', 'The decider must use a read-only role')
      const history = boundedText(context.state.$history.map(entry => `[${entry.nodePath}] ${entry.text}`).join('\n'), deps.policies?.historyMaxChars ?? 1500)
      const specs = deps.context.specs.map(spec => boundedText(JSON.stringify({ id: spec.id, title: spec.title, description: spec.description, acceptanceCriteria: spec.acceptanceCriteria }), 4000))
      const memo = deps.memo(context)
      const saved = memo.get('decider-blocked-result')
      const result = saved ? saved as unknown as PieceResult : await executeRoleTurn(deps, { roleId, prompt: deciderPrompt(text(params.goal), [history], specs), structuredOutput: outputSchema, sessionContinuity: 'none', ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }), ...(params.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: params.idleTimeoutMs }) }, context, {
        normalizeStructuredOutput: (output, response) => {
          const question = /^\s*LOOP_BLOCKED:\s*(.+)$/m.exec(response)?.[1]?.trim()
          return question ? { verdict: 'blocked', reason: boundedText(question, 4000) } : output
        },
      })
      if (result.outcome !== 'next') return { ...result, outcome: 'failed' }
      const structured = (result.output as JsonObject).structured as { verdict: 'continue' | 'stop' | 'blocked'; reason: string }
      const candidateHash = deps.executionSnapshot(context).candidate?.hash ?? null
      const nodeId = context.frame.nodePath.split('/').at(-1)!
      const previous = context.state.$outputs[nodeId] as { verdict?: string; candidateHash?: string | null; continueCount?: number } | undefined
      if (structured.verdict === 'blocked') {
        // The read-only decision and its usage have settled. Retain that result
        // before interrupting so a human answer never repeats the provider call.
        if (!saved) memo.set('decider-blocked-result', json(result))
        const response = context.interrupt({ kind: 'question', prompt: structured.reason, nodePath: context.frame.nodePath, scopeId: context.frame.scope.id, attemptId: context.frame.attemptId })
        return { ...result, outcome: 'continue', output: { verdict: 'continue', reason: structured.reason, blocked: true,
          candidateHash: previous?.candidateHash ?? null, continueCount: previous?.continueCount ?? 0 },
          answers: [answerEntry(context, response)], history: [historyEntry(context, `Human decision requested: ${structured.reason}\nHuman answer:\n${JSON.stringify(response)}`)] }
      }
      const continueCount = structured.verdict === 'continue' && candidateHash !== null ? previous?.verdict === 'continue' && previous.candidateHash === candidateHash ? (previous.continueCount ?? 0) + 1 : 1 : 0
      const limit = (params.noProgress as number | undefined) ?? deps.policies?.noProgress
      const stalled = limit !== undefined && continueCount >= limit
      const verdict = structured.verdict
      return { ...result, outcome: stalled ? 'failed' : verdict, output: { verdict, reason: structured.reason, candidateHash, continueCount, ...(stalled ? { stalled: true } : {}) },
        history: [historyEntry(context, `${verdict}: ${structured.reason}${stalled ? ' (no progress)' : ''}`)],
        ...(stalled ? { status: 'failed' as const, error: { code: 'no_progress', message: 'The candidate did not change across the allowed continue decisions' }, completion: { ok: false, verified: false, reasons: ['no_progress'] } } : {}) }
    },
  }
}
