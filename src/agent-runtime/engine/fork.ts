import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RunnableConfig } from '@langchain/core/runnables'
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint'
import { pipelineStateDirectory, validatePipelineContext, type PipelineContext } from '../../pipeline/pipeline-state.js'
import { createExecutorRegistry, type ExecutorRegistry } from '../executors.js'
import { coreRuntimeIdentity } from '../core-host.js'
import { sameRuntimeIdentity, type RuntimeIdentity } from '../runtime-identity.js'
import { canonicalJson, contentDigest } from './canonical-json.js'
import { RunDatabase, type DatabaseRow } from './checkpoint/database.js'
import { RunLedger } from './checkpoint/ledger.js'
import { RunLease } from './checkpoint/lease.js'
import { EngineError, type ExecutionScope, type JsonObject, type JsonValue, type PieceResult } from './contracts.js'
import { composeDefinitionRuntime } from './composition.js'
import { EngineEventStream } from './events.js'
import { configuredRoles, type DefinitionRunRequest } from './preflight.js'
import type { WorkflowDefinition } from './definition-types.js'
import { forkImplementationJournal, projectImplementationFork, type ImplementationJournalSnapshot } from './pieces/implementation-journal.js'
import type { ImplementationBinding } from './pieces/implementation-binding.js'
import { projectRunStatus } from './run-status.js'
import { ensurePrivateDirectory } from './storage/private-path.js'

export interface ForkRunOptions {
  fromNodePath: string
  runId: string
  scopeId?: string
  visit?: number
  state?: { $vars?: Record<string, JsonValue>; $outputs?: Record<string, JsonValue> }
  registry?: ExecutorRegistry
}

function patchState(input: ForkRunOptions['state']): NonNullable<ForkRunOptions['state']> {
  if (input === undefined) return {}
  canonicalJson(input)
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['$vars', '$outputs'].includes(key)) || Buffer.byteLength(canonicalJson(input)) > 2 * 1024 * 1024) throw new EngineError('invalid_arguments', 'Fork can patch only bounded $vars and $outputs')
  for (const value of Object.values(input)) if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new EngineError('invalid_arguments', 'Fork state channels require safe JSON object keys')
  return structuredClone(input)
}
function rebind(source: ImplementationBinding, parent: PipelineContext, change: string): ImplementationBinding {
  const standalone = source.context.runId === source.parentRunId
  const digest = contentDigest({ parentRunId: parent.runId, scopeId: source.scopeId, nodePath: source.nodePath }).slice(0, 24)
  const context = validatePipelineContext({ ...source.context, runId: standalone ? parent.runId : parent.runId.slice(0, 80) + '-impl-' + digest })
  return { ...source, context, parentRunId: parent.runId, change: standalone ? change : change.slice(0, 38).replace(/-+$/, '') + '-' + digest, directory: pipelineStateDirectory(context) }
}

/** A fork publishes an independently leased historical cut; the source is opened read-only. */
export async function forkRun(directory: string, options: ForkRunOptions) {
  const state = patchState(options.state)
  if (!options.fromNodePath || (options.visit !== undefined && (!Number.isSafeInteger(options.visit) || options.visit < 1))) throw new EngineError('invalid_arguments', 'Fork requires a node path and an optional positive visit')
  const source = await RunDatabase.open(path.join(directory, 'run.sqlite'), { readOnly: true })
  let destination: RunDatabase | undefined, runtime: Awaited<ReturnType<typeof composeDefinitionRuntime>> | undefined
  let ledger: RunLedger | undefined, targetRoot: string | undefined, published = false
  const created: string[] = []
  try {
    const sourceRun = source.sqlite.prepare('SELECT * FROM runs').get()!
    if (!sourceRun) throw new EngineError('run_not_found', 'Source run does not exist')
    if (!sameRuntimeIdentity(JSON.parse(String(sourceRun.runtime_identity_json)) as RuntimeIdentity, coreRuntimeIdentity())) throw new EngineError('resume_incompatible', 'Fork requires the original retained Core runtime')
    const request = JSON.parse(String(sourceRun.request_json)) as DefinitionRunRequest, definition = JSON.parse(String(sourceRun.definition_json)) as WorkflowDefinition
    const context = validatePipelineContext({ ...request.context, runId: options.runId })
    if (context.runId === request.context.runId) throw new EngineError('invalid_arguments', 'Fork requires a different run ID')
    const matches = source.sqlite.prepare('SELECT * FROM visits WHERE run_id=? AND node_path=? ORDER BY global_transition').all(sourceRun.run_id, options.fromNodePath)
      .filter(row => (options.scopeId === undefined || row.scope_id === options.scopeId) && (options.visit === undefined || Number(row.local_visit) === options.visit))
    if (matches.length !== 1) throw new EngineError('fork_ambiguous', 'Fork must identify exactly one visit; include scopeId and visit when needed')
    const from = matches[0], cut = Number(from.before_revision)
    const checkpointRows = source.sqlite.prepare('SELECT thread_id,checkpoint_ns,checkpoint_id FROM checkpoints WHERE thread_id=? AND checkpoint_id=?').all(sourceRun.checkpoint_thread_id, from.checkpoint_id)
    if (checkpointRows.length !== 1) throw new EngineError('fork_checkpoint_missing', 'The target visit does not identify exactly one public checkpoint')
    const targetConfig: RunnableConfig = { configurable: { thread_id: checkpointRows[0].thread_id, checkpoint_ns: checkpointRows[0].checkpoint_ns, checkpoint_id: checkpointRows[0].checkpoint_id } }
    targetRoot = pipelineStateDirectory(context)
    if (existsSync(targetRoot)) throw new EngineError('run_exists', 'Fork refuses to replace an existing run directory')
    mkdirSync(path.dirname(targetRoot), { recursive: true, mode: 0o700 }); mkdirSync(targetRoot, { mode: 0o700 }); created.push(targetRoot)
    await ensurePrivateDirectory(targetRoot)
    const staging = path.join(targetRoot, '.fork-' + randomUUID()), finalDirectory = path.join(targetRoot, 'agent-workflow')
    destination = await RunDatabase.open(path.join(staging, 'run.sqlite'), { create: true })
    source.forkAt(destination, { revision: cut, runId: context.runId })
    const change = request.change ? request.change.slice(0, 42).replace(/-+$/, '') + '-fork-' + contentDigest(context.runId).slice(0, 12) : undefined
    const forkRequest = { ...request, context, ...(change ? { change } : {}) }
    const sourceBindings = destination.sqlite.prepare("SELECT * FROM piece_state WHERE key='binding:implementation'").all()
    const restored: Array<{ source: ImplementationBinding; target: ImplementationBinding; row: DatabaseRow }> = []
    for (const row of sourceBindings) {
      // A completed implementation is inherited evidence. Rebinding its journal would
      // create a new candidate and repeat verified work even when the workspace is unchanged.
      const completed = destination.sqlite.prepare('SELECT 1 FROM attempts WHERE visit_id=? AND terminal_digest IS NOT NULL').get(row.visit_id)
      if (completed) continue
      const binding = JSON.parse(String(row.value_json)) as ImplementationBinding, target = rebind(binding, context, change!)
      const changeDirectory = path.join(target.context.artifactRoot, 'openspec', 'changes', target.change)
      if ((target.directory !== targetRoot && existsSync(target.directory)) || existsSync(changeDirectory)) throw new EngineError('run_exists', 'Fork refuses to replace an existing implementation journal or change')
      const childScope = binding.scopeId + '/' + String(row.visit_id)
      const results = destination.sqlite.prepare('SELECT a.output_json FROM attempts a JOIN visits v ON a.visit_id=v.visit_id WHERE a.scope_id=? AND a.output_json IS NOT NULL ORDER BY v.global_transition DESC,a.attempt DESC').all(childScope)
      const snapshot = results.map(result => (JSON.parse(String(result.output_json)) as PieceResult).childUpdate?.journal).find(value => value !== undefined) as unknown as ImplementationJournalSnapshot | undefined
      if (snapshot) {
        if (target.directory !== targetRoot) created.push(target.directory)
        created.push(changeDirectory)
        await ensurePrivateDirectory(target.directory)
        forkImplementationJournal(snapshot, binding, target)
      }
      restored.push({ source: binding, target, row })
    }
    const lease = new RunLease(destination, context.runId), token = lease.acquire(randomUUID())
    ledger = new RunLedger(destination, token, { maxTransitions: definition.maxTransitions, failFast: definition.policies?.failFast })
    destination.transaction('fork-rebound', () => {
      lease.assert(token)
      destination!.put('runs', { ...ledger!.run(), request_json: canonicalJson(forkRequest), status: 'running', completion_json: null,
        ...(Object.keys(state).length || restored.length ? { verified_json: null } : {}) })
      for (const binding of restored) destination!.put('piece_state', { ...binding.row, value_json: canonicalJson(binding.target) })
      destination!.put('piece_state', { run_id: context.runId, scope_id: 'root', node_path: '', key: 'lineage:fork', value_json: canonicalJson({
        sourceRunId: request.context.runId, sourceContext: request.context, sourceBindings: sourceBindings.map(row => JSON.parse(String(row.value_json))) }), updated_at: new Date().toISOString() })
      // Fork explicitly requests a new execution of the uncommitted cut. Reads and
      // coordinators are safe to restart even when their original retry allowance
      // was one. Repository-writing child tasks still require explicit recovery.
      for (const attempt of destination!.sqlite.prepare("SELECT a.* FROM attempts a JOIN visits v ON a.visit_id=v.visit_id WHERE a.status IN ('running','interrupted') AND (v.effect='read' OR v.kind IN ('component','map','implementation'))").all()) destination!.put('attempts', { ...attempt, recovery_authorized: 1 })
    })
    const admitted = { request: forkRequest, definition, roles: configuredRoles(request.config), budget: ledgerBudgetFromRow(ledger), registry: options.registry ?? createExecutorRegistry(request.config) }
    runtime = await composeDefinitionRuntime(destination, ledger, admitted, new EngineEventStream(cursor => ledger!.events(cursor), () => {}), new AbortController().signal)
    const heads = new Map<string, CheckpointTuple>()
    for await (const tuple of runtime.saver.list({ configurable: { thread_id: sourceRun.checkpoint_thread_id } })) {
      const namespace = String(tuple.config.configurable?.checkpoint_ns ?? '')
      if (!heads.has(namespace)) heads.set(namespace, tuple)
    }
    for (const binding of restored) {
      if (!existsSync(path.join(binding.target.directory, 'state.json'))) continue
      const scope = binding.source.scopeId + '/' + String(binding.row.visit_id)
      const matching = [...heads.values()].filter(tuple => (tuple.checkpoint.channel_values.$scope as ExecutionScope | undefined)?.id === scope && '$next' in tuple.checkpoint.channel_values)
      if (matching.length !== 1) throw new EngineError('fork_checkpoint_missing', 'Implementation journal has no unique child checkpoint at the selected cut')
      const tuple = matching[0], projection = projectImplementationFork(binding.target)
      const last = destination.sqlite.prepare('SELECT a.node_path FROM attempts a JOIN visits v ON a.visit_id=v.visit_id WHERE a.scope_id=? AND a.terminal_digest IS NOT NULL ORDER BY v.global_transition DESC,a.attempt DESC LIMIT 1').get(scope)
      const writer = last && String(last.node_path).startsWith(binding.source.nodePath + '/') ? String(last.node_path).slice(binding.source.nodePath.length + 1) : undefined
      if (!writer) throw new EngineError('fork_checkpoint_missing', 'Implementation checkpoint has no unambiguous public previous node')
      await runtime.graph.updateState(tuple.config, projection.update, writer)
    }
    if (Object.keys(state).length) {
      const tuple = await runtime.saver.getTuple(targetConfig)
      if (!tuple) throw new EngineError('fork_checkpoint_missing', 'Target checkpoint is not present in the historical cut')
      const values = tuple.checkpoint.channel_values
      const outer = values.$outer as JsonObject | undefined
      const update = outer ? { $outer: { ...outer,
        ...(state.$vars ? { $vars: { ...(outer.$vars as JsonObject), ...state.$vars } } : {}),
        ...(state.$outputs ? { $outputs: { ...(outer.$outputs as JsonObject), ...state.$outputs } } : {}), $verified: null } }
        : { ...state, $verified: null }
      await runtime.graph.updateState(targetConfig, update)
    }
    destination.checkIntegrity()
    const result = projectRunStatus(ledger)
    runtime.close(); runtime = undefined; lease.release(token); ledger = undefined
    destination.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); destination.close(); destination = undefined
    await ensurePrivateDirectory(finalDirectory)
    if (existsSync(path.join(finalDirectory, 'run.sqlite'))) throw new EngineError('run_exists', 'Fork database was concurrently created')
    renameSync(path.join(staging, 'run.sqlite'), path.join(finalDirectory, 'run.sqlite'))
    rmSync(staging, { recursive: true, force: true }); published = true
    return { type: 'runtime-forked' as const, runId: context.runId, forkOf: request.context.runId, fromNodePath: options.fromNodePath,
      scopeId: String(from.scope_id), visit: Number(from.local_visit), directory: finalDirectory, context, revision: result.revision }
  } finally {
    runtime?.close()
    if (ledger) ledger.lease.release(ledger.token)
    destination?.close(); source.close()
    if (!published) for (const target of created.reverse()) rmSync(target, { recursive: true, force: true })
  }
}
function ledgerBudgetFromRow(ledger: RunLedger) {
  const row = ledger.db.get('budget', { run_id: ledger.runId })!
  return { ...(row.max_cost_usd === null ? {} : { maxCostUsd: Number(row.max_cost_usd) }), ...(row.max_tokens === null ? {} : { maxTokens: Number(row.max_tokens) }), ...(row.max_duration_ms === null ? {} : { maxDurationMs: Number(row.max_duration_ms) }) }
}
