import { CoreState, type CoreNodeId, type CoreStateType } from '../../graph/state.js'
import { EngineError, type JsonObject, type Piece } from '../contracts.js'
import { createImplementationAdapter } from './implementation.js'
import type { PieceDependencyProvider } from './ports.js'
import { json, paramsSchema } from './shared.js'

/** Outcomes are facts, not destinations. Only the host definition chooses the next node. */
export const IMPLEMENTATION_STEP_OUTCOMES = ['next', 'incomplete', 'rejected', 'replan', 'reverify', 'rereview', 'failed'] as const

export function implementationStepPiece(bindings: PieceDependencyProvider): Piece {
  return {
    descriptor: { kind: 'implementation-step', paramsSchema: paramsSchema({
      phase: { enum: ['architect', 'developer', 'fixer', 'verify', 'reviewer', 'archive'] },
    }, ['phase']), outcomes: [...IMPLEMENTATION_STEP_OUTCOMES], effect: 'write', requiresAI: true },
    async execute(params, context) {
      const deps = bindings(), phase = params.phase as CoreNodeId
      const change = deps.change ?? context.state.$vars.changeId
      if (typeof change !== 'string') throw new EngineError('invalid_arguments', 'Implementation operation requires a frozen change')
      const saved = deps.operationState?.(context) as JsonObject | undefined
      const resumed = [...deps.stepContext(context).checkpoint.events].reverse().find(event => event.type === 'workflow_resumed')?.timestamp ?? ''
      const adapter = createImplementationAdapter(deps, { change, params: {}, independent: true, revalidate: saved?.operationResume !== resumed, archiveConsent: saved?.operationRunId === deps.context.runId && typeof saved.operationConsent === 'string' ? saved.operationConsent : undefined })
      const initialized = await adapter.initialize(context)
      const initial: CoreStateType = { plan: [], unverifiedRepositories: [], architecture: null, development: null,
        verifyResult: null, review: null, answers: [], deepenPasses: 0, archived: null, verifyHistory: [] }
      const state = { ...initial, ...(saved?.operationState as Partial<CoreStateType> | undefined),
        ...(saved?.operationRunId === deps.context.runId ? {} : initialized as Partial<CoreStateType>) }
      const response = await adapter.runNode(phase, state, context)
      const updated = { ...state }
      for (const [key, value] of Object.entries(response.update ?? {})) {
        const channel = CoreState.spec[key as keyof typeof CoreState.spec] as unknown as { operator?: (left: unknown, right: unknown) => unknown }
        ;(updated as unknown as Record<string, unknown>)[key] = channel.operator ? channel.operator(state[key as keyof CoreStateType], value) : value
      }
      const normal = { architect: 'developer', developer: 'verify', fixer: 'verify', verify: 'reviewer', reviewer: 'archive', archive: null }[phase]
      const next = response.next === undefined ? normal : response.next
      const outcome = response.status !== 'succeeded' ? 'failed' : next === normal ? 'next'
        : next === 'architect' ? 'replan' : next === 'verify' ? 'reverify' : next === 'reviewer' ? 'rereview'
          : next === 'developer' ? 'incomplete' : next === 'fixer' ? 'rejected' : 'failed'
      // The summary reads host verification receipts and acceptance, never an agent's claim.
      const evidence = await adapter.summarize(updated, context)
      return { outcome, status: response.status,
        ...(response.output === undefined ? {} : { output: json({ ...((response.output && typeof response.output === 'object' && !Array.isArray(response.output)) ? response.output : { value: response.output }), phase }) }),
        ...(response.error ? { error: { code: response.status === 'blocked' ? 'implementation_blocked' : 'implementation_failed', message: response.error } } : {}),
        childUpdate: { operationState: json(updated), operationRunId: deps.context.runId, operationResume: resumed, operationConsent: adapter.consentSnapshot?.(context) ?? null, journal: json(adapter.snapshot(context)) },
        ...(evidence.receipt ? { receipt: evidence.receipt, verified: phase === 'archive' && outcome === 'next' ? evidence.verified : null } : {}),
        ...(phase === 'archive' && outcome === 'next' ? { completion: evidence.completion } : {}),
      }
    },
  }
}
