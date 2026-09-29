import path from 'node:path'
import type { RunDatabase } from './checkpoint/database.js'
import type { RunLedger } from './checkpoint/ledger.js'
import { SqliteRunSaver } from './checkpoint/saver.js'
import { compileWorkflowDefinition } from './compiler.js'
import type { JsonValue } from './contracts.js'
import type { EngineEventStream } from './events.js'
import { DefinitionExecution } from './execution.js'
import { RunPieceDependencies } from './piece-dependencies.js'
import { createPieceRegistry } from './pieces/index.js'
import { createImplementationAdapter } from './pieces/implementation.js'
import type { preflightDefinition } from './preflight.js'
import { SqliteProjectStore } from './store/sqlite-store.js'

export type DefinitionAdmission = Awaited<ReturnType<typeof preflightDefinition>>

/** Infrastructure is bound once to the frozen project and the current execution lease. */
export async function composeDefinitionRuntime(database: RunDatabase, ledger: RunLedger, admitted: DefinitionAdmission,
  stream: EngineEventStream, signal: AbortSignal) {
  const memory = await SqliteProjectStore.open(admitted.request.context.backlogRoot)
  const deps = new RunPieceDependencies(admitted.request.context, admitted.request.config, admitted.registry, admitted.definition,
    ledger, path.dirname(database.filename), admitted.request.change, memory)
  const execution = new DefinitionExecution(ledger, stream, signal, admitted.definition.policies?.concurrency ?? 1,
    (frame, result, effect) => deps.finalize(frame, result, effect))
  try {
    const saver = new SqliteRunSaver(database, ledger, { onEvents: events => execution.committed(events) })
    const graph = compileWorkflowDefinition(admitted.definition, createPieceRegistry(deps), execution, {
      roles: admitted.roles, checkpointer: saver,
      collections: { tickets: JSON.parse(JSON.stringify(admitted.request.context.specs)) as JsonValue[], repositories: JSON.parse(JSON.stringify(admitted.request.context.repositories)) as JsonValue[] },
      implementation: params => createImplementationAdapter(deps, { change: admitted.request.change!, params }),
    })
    return { deps, execution, saver, graph, close: () => { execution.close(); memory.close() } }
  } catch (error) { execution.close(); memory.close(); throw error }
}
