import { EngineError, type Piece, type PieceExecutionContext } from '../contracts.js'
import { parseExpression } from '../expressions.js'
import type { PieceDependencyProvider } from './ports.js'
import { answerEntry, idSchema, paramsSchema, positiveInteger, stringSchema, text } from './shared.js'

export function controlPieces(bindings: PieceDependencyProvider): Piece[] {
  const pieces: Piece[] = [{
    descriptor: { kind: 'condition', paramsSchema: paramsSchema({ expr: { ...stringSchema, minLength: 1, maxLength: 4096 } }, ['expr']), outcomes: ['true', 'false'], effect: 'read', requiresAI: false },
    async execute(params, context) {
      try { return { outcome: parseExpression(text(params.expr)).evaluate(context.state) ? 'true' : 'false' } }
      catch (error) { return { outcome: 'false', output: { error: error instanceof Error ? error.message : String(error) },
        completion: { ok: false, verified: false, reasons: ['condition_error:' + context.frame.nodePath] } } }
    },
  }, {
    descriptor: { kind: 'end', paramsSchema: paramsSchema({ outcome: { enum: ['success', 'failure'] }, requiresVerified: { type: 'boolean' }, reason: stringSchema, exit: idSchema }, ['outcome']), outcomes: [], effect: 'read', requiresAI: false },
    async execute(params, context) {
      const { candidate, verified } = bindings().executionSnapshot(context)
      const current = verified !== null && candidate !== null && verified.candidateHash === candidate.hash
      const reasons = typeof params.reason === 'string' && params.reason ? [params.reason] : []
      if (params.requiresVerified && !current) reasons.push('unverified')
      return { outcome: text(params.outcome), completion: { ok: params.outcome === 'success' && !(params.requiresVerified && !current), verified: current, reasons } }
    },
  }]
  for (const kind of ['approval', 'question', 'gate'] as const) {
    const field = kind === 'question' ? 'text' : 'reason'
    pieces.push({
      descriptor: { kind, paramsSchema: paramsSchema({ [field]: { ...stringSchema, minLength: 1 } }, [field]), outcomes: ['next'], effect: 'read', requiresAI: false },
      async execute(params, context) {
        const response = context.interrupt({ kind, prompt: text(params[field]), nodePath: context.frame.nodePath, scopeId: context.frame.scope.id, attemptId: context.frame.attemptId })
        return { outcome: 'next', output: { response }, ...(kind === 'question' ? { answers: [answerEntry(context, response)] } : {}) }
      },
    })
  }
  return pieces
}

/** Composition kinds are compiled as actual child graphs, never ordinary opaque calls. */
export function compositionPieces(): Piece[] {
  const execute = async (_params: unknown, _context: PieceExecutionContext): Promise<never> => { throw new EngineError('composition_required', 'Composition pieces require a compiled child graph') }
  const getEffect = (): never => { throw new EngineError('composition_required', 'Composition effects require the compiled component body') }
  return [
    { descriptor: { kind: 'component', paramsSchema: paramsSchema({ ref: idSchema, inputs: { type: 'object', additionalProperties: stringSchema } }, ['ref']), outcomes: ['next', 'failed'], effect: 'derived', requiresAI: false }, execute, getEffect },
    { descriptor: { kind: 'map', paramsSchema: paramsSchema({ over: { oneOf: [{ enum: ['tickets', 'repositories'] }, paramsSchema({ outputsOf: idSchema, path: stringSchema }, ['outputsOf', 'path'])] }, body: idSchema, concurrency: { ...positiveInteger, maximum: 8 } }, ['over', 'body']), outcomes: ['next'], effect: 'derived', requiresAI: false }, execute, getEffect },
    { descriptor: { kind: 'implementation', paramsSchema: paramsSchema({ attempts: { ...positiveInteger, maximum: 100 }, approvalBeforeArchive: { type: 'boolean' }, reviewPolicy: paramsSchema({ minScore: { type: 'number', minimum: 0, maximum: 100 }, aspects: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 100 } } }) }), outcomes: ['next', 'rejected', 'failed'], effect: 'write', requiresAI: true }, execute },
    { descriptor: { kind: 'join', paramsSchema: paramsSchema({ reduce: { enum: ['collect', 'all-ok', 'any-ok'] } }, ['reduce']), outcomes: ['next', 'fail'], effect: 'read', requiresAI: false }, execute },
  ]
}
