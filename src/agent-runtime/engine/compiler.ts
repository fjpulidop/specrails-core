import { END, interrupt, isGraphInterrupt, Send, START, StateGraph, type BaseCheckpointSaver, type CompiledStateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph'
import { EngineError, type AttemptFrame, type CoreDefinitionState, type JsonValue, type NodeExecutionPort, type PieceResult } from './contracts.js'
import type { ComponentBody, RoleCatalog, WorkflowDefinition } from './definition-types.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { interpolateParams } from './expressions.js'
import type { PieceRegistry } from './piece-registry.js'
import { definitionStateSchema, initialDefinitionState, mergeHistory } from './state.js'
import { boundPieceOutput } from './output.js'
import { compileImplementationGraph, implementationContext, implementationInput } from './implementation-compiler.js'
import type { ImplementationAdapter } from './pieces/implementation.js'
import type { JsonObject } from './contracts.js'

class ClassifiedRetry extends Error {
  constructor(public readonly cause: unknown) { super(cause instanceof Error ? cause.message : String(cause)); this.name = 'ClassifiedRetry' }
}

type DefinitionSchema = ReturnType<typeof definitionStateSchema>
export type CompiledDefinitionGraph = CompiledStateGraph<CoreDefinitionState, Partial<CoreDefinitionState>, string, DefinitionSchema['spec'], DefinitionSchema['spec']>

export interface CompileDefinitionOptions {
  roles?: RoleCatalog
  checkpointer?: BaseCheckpointSaver
  /** Frozen host context collections available to map; never fetched by the compiler. */
  collections?: { tickets?: JsonValue[]; repositories?: JsonValue[] }
  /** Bound to the admitted change and real Core journal by the composition root. */
  implementation?: (params: JsonObject) => ImplementationAdapter
}

/** No provider or persistence side effects occur while compiling a validated document. */
export function compileWorkflowDefinition(definition: WorkflowDefinition, registry: PieceRegistry, execution: NodeExecutionPort, options: CompileDefinitionOptions = {}) {
  const validated = validateWorkflowDefinition(definition, registry, options.roles, { published: true })
  if (!validated.ok) throw new EngineError('invalid_definition', 'Cannot compile an invalid definition', validated.errors.map(error => ({ ...error })))
  const frozen = validated.definition
  return compileBody(frozen, true)

  function compileBody(body: ComponentBody, root: boolean): CompiledDefinitionGraph {
    const schema = definitionStateSchema(frozen.policies?.historyMaxChars, root ? { id: 'root', nodePathPrefix: '' } : null)
    const graph = new StateGraph(schema)
    for (const [id, node] of Object.entries(body.nodes)) {
      const piece = registry.get(node.kind)
      const componentBody = node.kind === 'component' || node.kind === 'map' ? frozen.components?.[String(node.params[node.kind === 'map' ? 'body' : 'ref'])] : undefined
      const child = componentBody ? compileBody(componentBody, false) : undefined
      const implementation = node.kind === 'implementation' ? options.implementation?.(node.params) : undefined
      if (node.kind === 'implementation' && !implementation) throw new EngineError('implementation_adapter_required', 'Implementation requires the real Core journal adapter')
      const implementationChild = implementation ? compileImplementationGraph(implementation, execution) : undefined
      const effect = child || implementationChild ? 'read' : registry.effect(node.kind, node.params, options.roles ?? {})
      const outcomes = node.kind === 'component' ? componentBody?.outputs ?? ['next', 'failed'] : registry.outcomes(node.kind, node.params)
      const branchName = '_core_map_' + id
      const mapPredecessor = node.kind === 'join' ? Object.entries(body.nodes).find(([, value]) => value.kind === 'map' && value.ends.next === id)?.[0] : undefined
      const retry = { maxAttempts: node.retry?.maxAttempts ?? (piece.descriptor.requiresAI ? 2 : 1), retrySafe: effect === 'read', initialIntervalMs: node.retry?.backoffMs ?? 5000 }
      graph.addNode(id, async (state: CoreDefinitionState, config: LangGraphRunnableConfig) => {
        const info = config.executionInfo
        if (!info?.threadId) throw new EngineError('execution_identity_missing', 'Durable definitions require public task identity and a checkpoint thread')
        const nodePath = state.$scope.nodePathPrefix ? state.$scope.nodePathPrefix + '/' + id : id
        const frame = await execution.enter({ nodePath, kind: node.kind, effect, requiresAI: piece.descriptor.requiresAI,
          acceptsSteering: piece.descriptor.requiresAI && ['prompt', 'role-turn'].includes(node.kind) && node.params.appendSteering !== false, scope: state.$scope,
          task: { checkpointThreadId: info.threadId, checkpointId: info.checkpointId, taskCheckpointNs: info.checkpointNs, taskId: info.taskId }, retry })
        let result: PieceResult
        let mapPlan: CoreDefinitionState['$maps'][string] | undefined
        try {
          const interpolated = interpolateParams(node.params, state.$vars)
          const params = node.kind === 'end' && root ? { ...interpolated, requiresVerified: interpolated.requiresVerified === true || frozen.delivery?.requiresVerified === true } : interpolated
          if (node.kind === 'map') {
            const items = mapItems(params.over, state, options.collections)
            result = { outcome: 'next', output: { total: items.length }, branches: { [id]: { total: items.length, results: [], visitId: frame.visitId, transition: frame.transition } } }
            // The item vector is stored once in the parent checkpoint, not once per Send argument.
            mapPlan = { frame, items }
          } else if (node.kind === 'join' && mapPredecessor) {
            const branch = state.$branches[mapPredecessor]
            if (!branch || branch.results.length !== branch.total) throw new EngineError('join_incomplete', 'Join cannot run before every branch has settled')
            const ok = branch.results.filter(value => value.outcome === 'next' || value.outcome === 'success').length
            const passes = params.reduce === 'collect' || (params.reduce === 'any-ok' ? ok > 0 : ok === branch.total)
            result = { outcome: passes ? 'next' : 'fail', output: { total: branch.total, ok, failed: branch.total - ok, results: branch.results.map(value => ({ index: value.index, outcome: value.outcome, output: value.output })) } }
          } else if (implementationChild && implementation) {
            result = await execution.execute(frame, 'read', async signal => {
              const context = implementationContext(state, frame, signal, execution)
              const initial = await implementation.initialize(context)
              const completed = await implementationChild.invoke({ ...implementationInput(state, frame), ...initial }, config)
              const summarized = await implementation.summarize(completed, context)
              if (completed.$nodeResult?.status === 'blocked') summarized.status = 'blocked'
              if (completed.$nodeResult?.error) summarized.error = { code: summarized.status === 'blocked' ? 'implementation_blocked' : 'implementation_failed', message: completed.$nodeResult.error }
              return summarized
            })
          } else if (child && componentBody) {
            const input = componentInput(state, frame, params.inputs, componentBody)
            const completed = await child.invoke(input, config)
            const exit = completed.$exit
            if (!exit) throw new EngineError('component_exit_missing', `Component ${nodePath} did not produce an exit`)
            result = { outcome: exit.outcome, status: exit.status, output: { outputs: completed.$outputs, completion: { ...exit.completion } },
              candidate: completed.$candidate ?? undefined, verified: completed.$verified, usage: completed.$usage, completion: exit.completion,
              ...(exit.error ? { error: exit.error } : {}) }
            if (!result.candidate) delete result.candidate
          } else result = await execution.execute(frame, effect, signal => piece.execute(params, {
            state: structuredClone(state), frame, signal, progress: event => execution.progress({ ...event, payload: {
              ...(event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : { payload: event.payload }),
              runId: frame.runId, nodePath: frame.nodePath, scopeId: frame.scope.id,
              ...(frame.scope.branchId ? { branch: frame.scope.branchId } : {}),
              attemptId: frame.attemptId, attempt: frame.attempt, visit: frame.visit,
            } }),
            interrupt: request => interrupt(request) as JsonValue,
          }))
          if (!outcomes.includes(result.outcome) && node.kind !== 'end' && result.status !== 'failed') throw new EngineError('invalid_piece_outcome', `Piece ${id} returned undeclared outcome ${result.outcome}`)
          result = { ...result, ...(result.output !== undefined ? { output: boundPieceOutput(result.output) } : {}),
            ...(result.history ? { history: mergeHistory([], result.history, frozen.policies?.historyMaxChars ?? 1500) } : {}) }
        } catch (error) {
          if (isGraphInterrupt(error)) { await execution.interrupted(frame, error); throw error }
          if (child || implementationChild) { await execution.interrupted(frame, error); throw error }
          const code = error instanceof EngineError || (error && typeof error === 'object' && 'code' in error) ? String((error as { code: string }).code) : 'piece_failed'
          if (effect === 'write' && ['aborted', 'timeout', 'idle_timeout', 'lease_lost'].includes(code)) {
            await execution.interrupted(frame, error)
            throw error
          }
          const allowedCodes = node.retry?.retryOn ?? ['idle_timeout', 'provider_request_error']
          const failure = await execution.failed(frame, error, { retry: frame.attempt < retry.maxAttempts && allowedCodes.includes(code) })
          if (failure.retryable) throw new ClassifiedRetry(error)
          result = { outcome: 'failed', status: 'failed', error: { code, message: error instanceof Error ? error.message : String(error) } }
        }
        const exitsBody = node.kind === 'end' || node.ends[result.outcome] === null || (!Object.hasOwn(node.ends, result.outcome) && result.status === 'failed')
        result = { ...result, completesRun: root && exitsBody, ...(exitsBody && !result.completion ? { completion: implicitCompletion(result, state) } : {}) }
        if (root && exitsBody && frozen.delivery?.requiresVerified && result.completion && !result.completion.verified) {
          result.completion = { ...result.completion, ok: false, reasons: [...new Set([...result.completion.reasons, 'unverified'])] }
        }
        const marker = execution.terminal(frame, result)
        const patch = resultPatch(id, frame, marker.result, marker)
        if (mapPlan) patch.$maps = { [id]: mapPlan }
        if (node.kind === 'join' && mapPredecessor && state.$maps[mapPredecessor]) patch.$maps = { [mapPredecessor]: { ...state.$maps[mapPredecessor], items: [] } }
        if (exitsBody) {
          const completion = marker.result.completion ?? implicitCompletion(result, state)
          patch.$exit = { outcome: typeof node.params.exit === 'string' ? node.params.exit : completion.ok ? 'next' : 'failed',
            transition: frame.transition, completion, status: marker.result.status ?? 'succeeded', ...(result.error ? { error: result.error } : {}) }
        }
        return patch
      }, { ...(implementationChild ? { subgraphs: [implementationChild] } : child && node.kind !== 'map' ? { subgraphs: [child] } : {}), ...(node.kind === 'join' ? { defer: true } : {}), retryPolicy: { maxAttempts: retry.maxAttempts, initialInterval: retry.initialIntervalMs, jitter: false, retryOn: error => error instanceof ClassifiedRetry } })
      if (node.kind === 'map' && child && componentBody) {
        graph.addNode(branchName, async (task: MapTask, config: LangGraphRunnableConfig) => {
          const input = componentInput(task.seed, task.frame, undefined, componentBody)
          input.$scope.id += '/' + task.index
          input.$scope.branchId = task.frame.visitId + ':' + task.index
          input.$scope.limits = [...(task.frame.scope.limits ?? []), { id: task.frame.visitId, concurrency: Number(node.params.concurrency ?? frozen.policies?.concurrency ?? 1) }]
          input.$item = { index: task.index, value: task.item }
          input.$vars.item = task.item
          input.$vars.index = task.index
          const completed = await child.invoke(input, config)
          if (!completed.$exit) throw new EngineError('component_exit_missing', 'Map body did not produce an exit')
          return { $branches: { [id]: { total: task.total, visitId: task.frame.visitId, transition: task.frame.transition,
            results: [{ id: task.frame.visitId + ':' + task.index, transition: task.frame.transition, attempt: task.frame.attempt, ordinal: task.index,
              index: task.index, outcome: completed.$exit.completion.ok ? 'next' : 'failed', output: boundPieceOutput({ outputs: completed.$outputs, completion: { ...completed.$exit.completion } }) }] } } }
        }, { subgraphs: [child] })
      }
    }
    // Dynamic IDs are validated above; LangGraph's builder generic accumulates only literal IDs.
    const edges = graph as StateGraph<typeof schema.spec, CoreDefinitionState, Partial<CoreDefinitionState>, string>
    edges.addEdge(START, body.entry)
    for (const [id, node] of Object.entries(body.nodes)) {
      if (node.kind === 'end') { edges.addEdge(id, END); continue }
      if (node.kind === 'map') {
        const branchName = '_core_map_' + id
        const join = node.ends.next!
        edges.addConditionalEdges(id, state => {
          if (state.$lastOutcome[id] !== 'next') return END
          const plan = state.$maps[id]
          if (!plan || !plan.items.length) return join
          const seed = initialDefinitionState(state.$vars, state.$scope)
          seed.$candidate = state.$candidate; seed.$verified = state.$verified; seed.$usage = state.$usage
          return plan.items.map((item, index) => new Send(branchName, { seed, frame: plan.frame, item, index, total: plan.items.length } satisfies MapTask))
        }, [branchName, join, END])
        edges.addEdge(branchName, join)
        continue
      }
      const mapping = Object.fromEntries(Object.entries(node.ends).map(([outcome, target]) => [outcome, target ?? END]))
      mapping.__engine_failure = END
      edges.addConditionalEdges(id, state => {
        const outcome = state.$lastOutcome[id]
        return Object.hasOwn(node.ends, outcome) ? outcome : '__engine_failure'
      }, mapping)
    }
    return edges.compile(root ? { checkpointer: options.checkpointer } : {})
  }
}

function resultPatch(id: string, frame: AttemptFrame, result: PieceResult, marker: CoreDefinitionState['$commit']): Partial<CoreDefinitionState> {
  return {
    $outputs: { [id]: result.output ?? null }, $lastOutcome: { [id]: result.outcome },
    $attempts: { [id]: frame.attempt }, $transitions: frame.transition, $commit: marker,
    ...(result.vars ? { $vars: result.vars } : {}), ...(result.history ? { $history: result.history } : {}),
    ...(result.session ? { $sessions: { [id]: result.session } } : {}), ...(result.usage ? { $usage: result.usage } : {}),
    ...(result.candidate ? { $candidate: result.candidate } : {}),
    ...(Object.hasOwn(result, 'verified') ? { $verified: result.verified ?? null } : {}),
    ...(result.answers ? { $answers: result.answers } : {}), ...(result.branches ? { $branches: result.branches } : {}),
  }
}

function componentInput(state: CoreDefinitionState, frame: AttemptFrame, mapping: JsonValue | undefined, body: ComponentBody): CoreDefinitionState {
  const vars: Record<string, JsonValue> = {}
  for (const name of body.inputs ?? []) if (Object.hasOwn(state.$vars, name)) vars[name] = state.$vars[name]
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) for (const [key, value] of Object.entries(mapping)) {
    if (typeof value === 'string' && value.startsWith('$')) {
      const parts = value.split('.')
      if (!['$vars', '$outputs', '$history', '$answers', '$candidate', '$verified', '$item'].includes(parts[0])) throw new EngineError('invalid_component_input', `Unsupported input channel ${parts[0]}`)
      let resolved: unknown = state
      for (const part of parts) {
        if (['__proto__', 'constructor', 'prototype'].includes(part) || !resolved || typeof resolved !== 'object' || !Object.hasOwn(resolved, part)) throw new EngineError('run_var_missing', `Component input ${value} is missing`)
        resolved = (resolved as Record<string, unknown>)[part]
      }
      vars[key] = resolved as JsonValue
    } else vars[key] = value
  }
  const input = initialDefinitionState(vars, { id: frame.scope.id + '/' + frame.visitId, nodePathPrefix: frame.nodePath,
    ...(frame.scope.branchId ? { branchId: frame.scope.branchId } : {}), ...(frame.scope.limits ? { limits: frame.scope.limits } : {}) })
  input.$candidate = state.$candidate
  input.$verified = state.$verified
  input.$usage = state.$usage
  return input
}

function implicitCompletion(result: import('./contracts.js').PieceResult, state: CoreDefinitionState): import('./contracts.js').EngineCompletion {
  const candidate = result.candidate ?? state.$candidate
  const verified = Object.hasOwn(result, 'verified') ? result.verified : state.$verified
  return { ok: !result.status || result.status === 'succeeded' ? ['success', 'next', 'pass', 'stop', 'ok', 'true'].includes(result.outcome) : false,
    reasons: result.error ? [result.error.code] : [], verified: Boolean(candidate && verified && candidate.hash === verified.candidateHash) }
}

interface MapTask { seed: CoreDefinitionState; frame: AttemptFrame; item: JsonValue; index: number; total: number }

function mapItems(over: JsonValue | undefined, state: CoreDefinitionState, collections: CompileDefinitionOptions['collections']): JsonValue[] {
  let items: unknown
  if (over === 'tickets' || over === 'repositories') items = collections?.[over]
  else if (over && typeof over === 'object' && !Array.isArray(over) && typeof over.outputsOf === 'string' && typeof over.path === 'string') {
    items = Object.hasOwn(state.$outputs, over.outputsOf) ? state.$outputs[over.outputsOf] : undefined
    for (const part of over.path ? over.path.split('.') : []) {
      if (['__proto__', 'constructor', 'prototype'].includes(part) || !items || typeof items !== 'object' || !Object.hasOwn(items, part)) throw new EngineError('map_input_missing', 'Map output path is missing')
      items = (items as Record<string, unknown>)[part]
    }
  }
  if (!Array.isArray(items)) throw new EngineError('map_input_missing', 'Map requires a frozen array collection')
  if (items.length > 10_000) throw new EngineError('map_input_limit', 'Map item count cannot exceed the global maximum transition bound')
  return structuredClone(items) as JsonValue[]
}
