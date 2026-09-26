import { Annotation, END, interrupt, isGraphInterrupt, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph'
import { EphemeralValue } from '@langchain/langgraph/channels'
import { CORE_NODE_ORDER, CoreState, type CoreNodeId, type CoreStateType } from '../graph/state.js'
import type { NodeResult } from '../workflow-types.js'
import { EngineError, type AttemptFrame, type CoreDefinitionState, type ExecutionScope, type JsonObject, type JsonValue, type NodeExecutionPort, type PieceExecutionContext, type PieceResult, type TerminalCommit } from './contracts.js'
import { boundPieceOutput } from './output.js'
import type { ImplementationAdapter } from './pieces/implementation.js'
import { json } from './pieces/shared.js'

function implementationSchema() {
  return Annotation.Root({ ...CoreState.spec,
    $scope: Annotation<ExecutionScope>({ reducer: (_old, value) => value }),
    $outer: Annotation<CoreDefinitionState>({ reducer: (_old, value) => value }),
    $next: Annotation<CoreNodeId | null>({ reducer: (_old, value) => value, default: () => 'architect' }),
    $nodeResult: Annotation<NodeResult<CoreStateType> | null>({ reducer: (_old, value) => value, default: () => null }),
    $commit: new EphemeralValue<TerminalCommit>(false),
  })
}
type ImplementationSchema = ReturnType<typeof implementationSchema>
export type ImplementationGraphState = ImplementationSchema['State']

export function implementationInput(parent: CoreDefinitionState, frame: AttemptFrame): Pick<ImplementationGraphState, '$outer' | '$scope'> {
  return { $outer: structuredClone(parent), $scope: { id: frame.scope.id + '/' + frame.visitId, nodePathPrefix: frame.nodePath,
    ...(frame.scope.branchId ? { branchId: frame.scope.branchId } : {}), ...(frame.scope.limits ? { limits: frame.scope.limits } : {}) } }
}

export function implementationContext(state: CoreDefinitionState, frame: AttemptFrame, signal: AbortSignal, execution: NodeExecutionPort): PieceExecutionContext {
  return { state: structuredClone(state), frame, signal,
    interrupt: request => interrupt(request) as JsonValue,
    progress: event => execution.progress({ ...event, payload: {
      ...(event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : { payload: event.payload }),
      runId: frame.runId, nodePath: frame.nodePath, scopeId: frame.scope.id,
      ...(frame.scope.branchId ? { branch: frame.scope.branchId } : {}), attemptId: frame.attemptId, attempt: frame.attempt, visit: frame.visit,
    } }),
  }
}

/** Six actual Core nodes use the parent's saver; every state update shares its terminal commit. */
export function compileImplementationGraph(adapter: ImplementationAdapter, execution: NodeExecutionPort) {
  const schema = implementationSchema(), graph = new StateGraph(schema)
  for (const id of CORE_NODE_ORDER) {
    const node = adapter.nodes[id], effect = node.effect ?? 'write'
    graph.addNode(id, async (state: ImplementationGraphState, config: LangGraphRunnableConfig) => {
      const info = config.executionInfo
      if (!info?.threadId) throw new EngineError('execution_identity_missing', 'Implementation child requires a public checkpoint identity')
      const frame = await execution.enter({ nodePath: state.$scope.nodePathPrefix + '/' + id, scope: state.$scope,
        kind: id === 'verify' ? 'verify' : id === 'archive' ? 'openspec-archive' : 'role-turn', effect,
        requiresAI: !['verify', 'archive'].includes(id), acceptsSteering: !['verify', 'archive'].includes(id),
        task: { checkpointThreadId: info.threadId, checkpointId: info.checkpointId, taskCheckpointNs: info.checkpointNs, taskId: info.taskId },
        retry: { maxAttempts: node.maxAttempts ?? 1, retrySafe: node.retrySafe === true },
      })
      let result: PieceResult
      try {
        result = await execution.execute(frame, effect, async signal => {
          const context = implementationContext(state.$outer, frame, signal, execution)
          const response = await adapter.runNode(id, state, context)
          const next = response.status === 'succeeded' ? response.next === undefined ? node.ends[0] ?? null : response.next : null
          if (next !== null && !(CORE_NODE_ORDER as readonly string[]).includes(next)) throw new EngineError('invalid_piece_outcome', `Implementation ${id} returned an unknown successor`)
          const update = response.update === undefined ? {} : json(response.update) as JsonObject
          const childUpdate = { update, next, response: json({ ...response, update: undefined }), journal: json(adapter.snapshot(context)) }
          if (Buffer.byteLength(JSON.stringify(childUpdate)) > 1_750_000) throw new EngineError('implementation_snapshot_invalid', 'Implementation child checkpoint exceeds its bounded state budget')
          return { outcome: next ?? (response.status === 'succeeded' ? 'next' : response.status), status: response.status,
            childUpdate,
            ...(response.output === undefined ? {} : { output: boundPieceOutput(json(response.output)) }),
            ...(response.error ? { error: { code: response.status === 'blocked' ? 'implementation_blocked' : 'implementation_failed', message: response.error } } : {}),
            completesRun: false }
        })
      } catch (error) {
        if (isGraphInterrupt(error)) { await execution.interrupted(frame, error); throw error }
        const code = error instanceof EngineError || (error && typeof error === 'object' && 'code' in error) ? String((error as { code: string }).code) : 'implementation_failed'
        if (effect === 'write' && ['aborted', 'timeout', 'idle_timeout', 'lease_lost'].includes(code)) { await execution.interrupted(frame, error); throw error }
        await execution.failed(frame, error, { retry: false })
        result = { outcome: 'failed', status: 'failed', error: { code, message: error instanceof Error ? error.message : String(error) },
          childUpdate: { update: {}, next: null, response: { status: 'failed', error: error instanceof Error ? error.message : String(error) } }, completesRun: false }
      }
      const marker = execution.terminal(frame, result)
      const saved = marker.result.childUpdate
      if (!saved) throw new EngineError('terminal_mismatch', 'Implementation terminal is missing its child state update')
      return { ...(saved.update as Partial<CoreStateType>), $next: saved.next as CoreNodeId | null, $nodeResult: saved.response as unknown as NodeResult<CoreStateType>, $commit: marker }
    })
  }
  const edges = graph as StateGraph<typeof schema.spec, ImplementationGraphState, Partial<ImplementationGraphState>, string>
  edges.addEdge(START, adapter.entry)
  const destinations: Record<string, string> = Object.fromEntries(CORE_NODE_ORDER.map(id => [id, id]))
  destinations.__end__ = END
  for (const id of CORE_NODE_ORDER) edges.addConditionalEdges(id, state => state.$next ?? '__end__', destinations)
  return edges.compile()
}
