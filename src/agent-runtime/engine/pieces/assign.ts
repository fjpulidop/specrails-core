import { EngineError, type JsonObject, type Piece } from '../contracts.js'
import { paramsSchema, variableNameSchema } from './shared.js'

const safeInteger = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, default: 1 }
const assignments = (values: JsonObject | boolean): JsonObject => ({
  type: 'object', minProperties: 1, maxProperties: 64,
  propertyNames: variableNameSchema, additionalProperties: values,
})

/** Pure scoped state updates. The runtime commits the complete result through
 * the same fenced transaction as every other piece, with no separate store. */
export function assignPiece(): Piece {
  return {
    descriptor: {
      kind: 'assign', effect: 'read', requiresAI: false, outcomes: ['next', 'failed'],
      paramsSchema: { ...paramsSchema({ set: assignments(true), increment: assignments(safeInteger) }), minProperties: 1 },
    },
    async execute(params, context) {
      const set = (params.set ?? {}) as JsonObject
      const increments = (params.increment ?? {}) as JsonObject
      const names = [...Object.keys(set), ...Object.keys(increments)]
      if (names.length > 64 || new Set(names).size !== names.length) {
        throw new EngineError('invalid_assignment', 'Assign at most 64 distinct variables; set and increment cannot overlap')
      }
      const vars: JsonObject = Object.fromEntries(Object.entries(set))
      for (const [name, delta] of Object.entries(increments)) {
        const previous = context.state.$vars[name]
        if (typeof previous !== 'number' || typeof delta !== 'number' ||
          !Number.isSafeInteger(previous) || !Number.isSafeInteger(delta) || !Number.isSafeInteger(previous + delta)) {
          throw new EngineError('invalid_assignment', `Variable ${name} must contain a safe integer and remain within its range`)
        }
        vars[name] = previous + delta
      }
      return { outcome: 'next', vars, output: { vars } }
    },
  }
}
