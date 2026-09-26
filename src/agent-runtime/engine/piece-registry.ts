import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { EngineError, type JsonObject, type Piece, type EngineEffect, type PieceDescriptor } from './contracts.js'
import type { DefinitionIssue, RoleCatalog } from './definition-types.js'

function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeData); Object.freeze(value) }
  return value
}

/**
 * Version of the published piece catalog. Bump it only when a descriptor's kind,
 * outcomes, effect or params schema changes incompatibly; hosts pin definitions to it.
 */
export const NODE_KINDS_VERSION = 1

/** Immutable bindings supplied by Core's composition root; user definitions cannot register code. */
export class PieceRegistry {
  private readonly entries = new Map<string, { piece: Piece; validate: ValidateFunction }>()

  constructor(pieces: readonly Piece[]) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false, ownProperties: true })
    for (const piece of pieces) {
      const descriptor = freezeData(structuredClone(piece.descriptor))
      if (this.entries.has(descriptor.kind)) throw new EngineError('duplicate_piece', `Duplicate piece ${descriptor.kind}`)
      if (descriptor.effect === 'derived' && !piece.getEffect) throw new EngineError('invalid_piece', `Derived piece ${descriptor.kind} requires getEffect`)
      if (new Set(descriptor.outcomes).size !== descriptor.outcomes.length) throw new EngineError('invalid_piece', 'Duplicate outcome labels')
      this.entries.set(descriptor.kind, { piece: Object.freeze({ ...piece, descriptor }), validate: ajv.compile(descriptor.paramsSchema) })
    }
  }

  get(kind: string): Piece {
    const entry = this.entries.get(kind)
    if (!entry) throw new EngineError('unknown_piece', `Piece ${kind} is not implemented by this runtime`)
    return entry.piece
  }

  catalog(): PieceDescriptor[] { return [...this.entries.values()].map(({ piece }) => structuredClone(piece.descriptor)) }

  /** Registered kinds in registration order: the `nodeKinds` advertised by `runtime api` and the integration contract. */
  kinds(): string[] { return [...this.entries.keys()] }

  validateParams(kind: string, params: JsonObject, path: string): DefinitionIssue[] {
    const entry = this.entries.get(kind)
    if (!entry) return [{ code: 'unknown_piece', path, message: `Piece ${kind} is not implemented by this runtime` }]
    if (entry.validate(params)) return []
    return (entry.validate.errors ?? []).map(error => ({ code: 'invalid_piece_params', path: path + '/params' + error.instancePath, message: error.message ?? 'Invalid piece parameters' }))
  }

  outcomes(kind: string, params: JsonObject): readonly string[] {
    const piece = this.get(kind)
    const outcomes = piece.getOutcomes?.(params) ?? piece.descriptor.outcomes
    if (new Set(outcomes).size !== outcomes.length || outcomes.some(value => !/^[a-z][a-z0-9-]{0,31}$/.test(value))) throw new EngineError('invalid_piece', `Invalid outcomes for ${kind}`)
    return outcomes
  }

  effect(kind: string, params: JsonObject, roles: RoleCatalog): EngineEffect {
    const piece = this.get(kind)
    const effect = piece.getEffect?.(params, roles) ?? piece.descriptor.effect
    if (effect !== 'read' && effect !== 'write') throw new EngineError('invalid_piece', `Unresolved effect for ${kind}`)
    return effect
  }
}
