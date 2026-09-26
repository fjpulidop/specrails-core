import { PieceRegistry } from '../piece-registry.js'
import { controlPieces, compositionPieces } from './control.js'
import { deciderPiece } from './decider.js'
import { openSpecPieces } from './openspec.js'
import { EngineError } from '../contracts.js'
import type { PieceDependencies, PieceDependencyProvider } from './ports.js'
import { promptPiece } from './prompt.js'
import { roleTurnPiece } from './role-turn.js'
import { shellPiece } from './shell.js'
import { verifyPiece } from './verify.js'

export type { PieceDependencies, PieceStatePort } from './ports.js'

/** The composition root binds effects once; definitions can only select this reviewed catalog. */
export function createPieceRegistry(deps: PieceDependencies): PieceRegistry {
  return registry(() => deps)
}

/** Exactly the production descriptors and validators, without creating a host or an executor. */
export function validationPieceRegistry(): PieceRegistry {
  return registry(() => { throw new EngineError('read_only', 'Catalog registry cannot execute workflow effects') })
}

function registry(bindings: PieceDependencyProvider): PieceRegistry {
  return new PieceRegistry([promptPiece(bindings), roleTurnPiece(bindings), deciderPiece(bindings), verifyPiece(bindings), shellPiece(bindings),
    ...openSpecPieces(bindings), ...controlPieces(bindings), ...compositionPieces()])
}
