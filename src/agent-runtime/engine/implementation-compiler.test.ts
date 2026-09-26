import { implementationFixture } from './__fixtures__/implementation-fixture.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Command } from '@langchain/langgraph'
import { afterEach, expect, it } from 'vitest'
import { fingerprintCandidate, inspectPipeline, pipelineStateDirectory, readCandidateScope } from '../../pipeline/pipeline-state.js'
import { runCoreWorkflow } from '../core-host.js'
import type { RoleExecutionState } from '../role-state.js'
import { RunDatabase } from './checkpoint/database.js'
import { RunLease } from './checkpoint/lease.js'
import { RunLedger } from './checkpoint/ledger.js'
import { SqliteRunSaver } from './checkpoint/saver.js'
import { compileWorkflowDefinition } from './compiler.js'
import type { NodeExecutionPort } from './contracts.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { EngineEventStream } from './events.js'
import { DefinitionExecution } from './execution.js'
import { invocationStepContext } from './invocation-context.js'
import { createImplementationAdapter } from './pieces/implementation.js'
import { createPieceRegistry } from './pieces/index.js'
import { deriveImplementationBinding, type ImplementationBinding } from './pieces/implementation-binding.js'
import { forkImplementationJournal, type ImplementationJournalSnapshot } from './pieces/implementation-journal.js'
import { readVerificationPlan } from '../verification-plan.js'
import type { PieceDependencies } from './pieces/ports.js'
import { initialDefinitionState } from './state.js'
import { createRun, definitionRunDirectory } from './runs.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const change = 'native-implementation'

function fixture(approval = false) {
  const result = implementationFixture(approval)
  cleanup.push(result.dispose)
  return result
}

async function engine(f: ReturnType<typeof fixture>) {
  const db = await RunDatabase.open(path.join(pipelineStateDirectory(f.context), 'run.sqlite'), { create: true })
  const roles = new Map<string, RoleExecutionState>()
  let ledger: RunLedger
  const deps: PieceDependencies = { ...f,
    stepContext: context => invocationStepContext(ledger, published, context),
    roleState: context => { const key = context.frame.scope.id + '/' + context.frame.nodePath; return { read: () => structuredClone(roles.get(key) ?? { sessions: {}, routes: {} }), write: state => { roles.set(key, structuredClone(state)) } } },
    memory: () => { throw new Error('Fixture project memory is not enabled') },
    memo: context => ({ get: key => ledger.readPieceState(context.frame, 'memo:' + key), set: (key, value) => ledger.writePieceState(context.frame, 'memo:' + key, value) }),
    settleResult: (context, key, value, invocation) => ledger.settleInvocation(context.frame, { ...invocation, invocationId: invocation.invocationId! }, { key: 'memo:' + key, value }),
    executionSnapshot: context => ({ candidate: { hash: fingerprintCandidate(readCandidateScope(f.context)), revision: Number(ledger.run().candidate_revision), atTransition: context.frame.transition }, verified: ledger.scopeSnapshot(context.frame.scope.id).verified }),
    verification: () => { throw new Error('Native implementation uses its real journal adapter') },
    artifactDirectory: () => path.join(pipelineStateDirectory(f.context), 'piece-artifacts'),
    bindImplementation: (context, change) => deriveImplementationBinding(f.context, context, change),
  }
  const registry = createPieceRegistry(deps)
  const validated = validateWorkflowDefinition({ schemaVersion: 1, id: 'implementation', title: 'Implementation', journal: 'implementation', change: 'new', entry: 'implement', maxTransitions: 30, roles: ['architect', 'developer', 'reviewer'],
    nodes: { implement: { kind: 'implementation', params: {}, ends: { next: 'done', rejected: 'failed', failed: 'failed' } }, done: { kind: 'end', params: { outcome: 'success', requiresVerified: true }, ends: {} }, failed: { kind: 'end', params: { outcome: 'failure' }, ends: {} } } }, registry,
  { architect: { access: 'read' }, developer: { access: 'write' }, reviewer: { access: 'read' } })
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors))
  const published = validated.definition
  RunLedger.initialize(db, { runId: f.context.runId, workflowId: published.id, definitionHash: published.version, definition: published, request: {}, runtimeIdentity: {}, source: 'definition' })
  const lease = new RunLease(db, f.context.runId), token = lease.acquire('fixture')
  ledger = new RunLedger(db, token, { maxTransitions: 30 })
  const execution = new DefinitionExecution(ledger, new EngineEventStream(cursor => ledger.events(cursor), () => {}), new AbortController().signal)
  const port: NodeExecutionPort = { enter: input => execution.enter(input), execute: (frame, effect, operation) => execution.execute(frame, effect, operation),
    terminal: (frame, result) => {
      const previous = ledger.run(), scope = readCandidateScope(f.context), hash = fingerprintCandidate(scope)
      const current = previous.candidate_json ? JSON.parse(String(previous.candidate_json)) as { hash: string } : undefined
      const revision = Number(previous.candidate_revision) + (current?.hash !== hash || result.receipt ? 1 : 0)
      return execution.terminal(frame, { ...result, ...(current?.hash !== hash || result.receipt ? { candidate: { hash, revision, atTransition: frame.transition } } : {}),
        ...(result.verified ? { verified: { ...result.verified, revision, atTransition: frame.transition } } : {}) })
    }, interrupted: (frame, error) => execution.interrupted(frame, error), failed: (frame, error, options) => execution.failed(frame, error, options), progress: event => execution.progress(event) }
  const saver = new SqliteRunSaver(db, ledger, { onEvents: events => execution.committed(events) })
  const graph = compileWorkflowDefinition(published, registry, port, { checkpointer: saver, roles: { architect: { access: 'read' }, developer: { access: 'write' }, reviewer: { access: 'read' } }, implementation: params => createImplementationAdapter(deps, { change, params }) })
  cleanup.push(() => { execution.close(); lease.release(token); db.close() })
  return { graph, ledger, db, deps, port }
}

it('executes the real implementation nodes on one SQLite saver with legacy acceptance parity', async () => {
  const legacy = fixture()
  const old = await runCoreWorkflow({ context: legacy.context, config: legacy.config, change, registry: legacy.registry })
  expect(old.status).toBe('succeeded')
  const fresh = fixture(), runtime = await engine(fresh)
  const result = await runtime.graph.invoke(initialDefinitionState(), { configurable: { thread_id: fresh.context.runId }, durability: 'sync', recursionLimit: 31 })
  expect(result.$outputs.implement).toMatchObject({ completion: inspectPipeline(legacy.context).completion })
  expect(result.$exit?.completion).toMatchObject({ ok: true, verified: true })
  expect(fresh.requests.map(request => request.role)).toEqual(legacy.requests.map(request => request.role))
  expect(runtime.ledger.usage()).toMatchObject({ invocations: 3, costUsd: expect.closeTo(0.3) })
  expect(runtime.db.sqlite.prepare("SELECT count(*) count FROM attempts WHERE status='running'").get()?.count).toBe(0)
  expect(runtime.ledger.events().filter(event => event.type === 'step_succeeded').map(event => event.nodePath)).toEqual(['implement/architect', 'implement/developer', 'implement/verify', 'implement/reviewer', 'implement/archive', 'implement', 'done'])
  expect(existsSync(path.join(pipelineStateDirectory(fresh.context), 'agent-workflow/workflow.json'))).toBe(false)
  expect(existsSync(path.join(pipelineStateDirectory(fresh.context), 'state.json'))).toBe(true)
  runtime.db.checkIntegrity()
  const terminal = JSON.parse(String(runtime.db.sqlite.prepare("SELECT output_json FROM attempts WHERE node_path='implement/architect'").get()!.output_json))
  const source: ImplementationBinding = { context: fresh.context, change, parentRunId: fresh.context.runId, scopeId: 'root', nodePath: 'implement', directory: pipelineStateDirectory(fresh.context) }
  const forkContext = { ...fresh.context, runId: 'forked-implementation' }
  const target: ImplementationBinding = { ...source, context: forkContext, parentRunId: forkContext.runId, change: 'forked-implementation', directory: pipelineStateDirectory(forkContext) }
  forkImplementationJournal(terminal.childUpdate.journal as ImplementationJournalSnapshot, source, target)
  expect(inspectPipeline(fresh.context).phases.archive.status).toBe('done')
  expect(inspectPipeline(forkContext)).toMatchObject({ phases: { architect: { status: 'done' }, developer: { status: 'pending' }, reviewer: { status: 'pending' } }, verification: { valid: false } })
  expect(readVerificationPlan(forkContext)?.runId).toBe(forkContext.runId)
  expect(readFileSync(path.join(fresh.repository, 'openspec/changes/forked-implementation/tasks.md'), 'utf8')).toContain('- [ ]')
}, 60_000)

it('revalidates verification and review after native archive approval with legacy parity', async () => {
  const f = fixture(true), runtime = await engine(f)
  const config = { configurable: { thread_id: f.context.runId }, durability: 'sync' as const, recursionLimit: 31 }
  await runtime.graph.invoke(initialDefinitionState(), config)
  const snapshot = await runtime.graph.getState(config, { subgraphs: true })
  const pending = snapshot.tasks.flatMap(task => task.interrupts)
  expect(pending).toHaveLength(1)
  expect(pending[0].value).toMatchObject({ nodePath: 'implement/archive', kind: 'approval' })
  expect(f.requests).toHaveLength(3)
  const result = await runtime.graph.invoke(new Command({ resume: { [pending[0].id!]: { approved: true } } }), config)
  expect(f.requests.map(request => request.role)).toEqual(['architect', 'developer', 'reviewer', 'reviewer'])
  expect(result.$exit?.completion.ok).toBe(true)
  expect(runtime.ledger.events().filter(event => event.type === 'workflow_succeeded')).toHaveLength(1)
}, process.platform === 'win32' ? 180_000 : 40_000)

it('executes Batch with distinct native journals and certifies only the global verification after join', async () => {
  const f = fixture()
  f.context.specs.push({ ...f.context.specs[0]!, id: 8, title: 'Second obligation' })
  const definition = JSON.parse(readFileSync(new URL('./__fixtures__/batch-implementation.json', import.meta.url), 'utf8'))
  const result = await createRun({ ...f, definition, change })
  expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(f.requests.map(request => request.role).sort()).toEqual(['architect', 'architect', 'developer', 'developer', 'reviewer', 'reviewer'])
  const database = await RunDatabase.open(path.join(definitionRunDirectory(f.context), 'run.sqlite'))
  try {
    const bindings = database.sqlite.prepare("SELECT value_json FROM piece_state WHERE key='binding:implementation'").all().map(row => JSON.parse(String(row.value_json)) as ImplementationBinding)
    expect(bindings).toHaveLength(2)
    expect(new Set(bindings.map(binding => binding.directory)).size).toBe(2)
    expect(bindings.map(binding => binding.context.specs.map(spec => spec.id))).toEqual(expect.arrayContaining([[7], [8]]))
    for (const binding of bindings) expect(inspectPipeline(binding.context).phases.archive.status).toBe('done')
    const implementationResults = database.sqlite.prepare("SELECT output_json FROM attempts WHERE node_path='work/implement'").all().map(row => JSON.parse(String(row.output_json)))
    expect(implementationResults).toHaveLength(2)
    for (const result of implementationResults) expect(result).toMatchObject({ receipt: { scope: 'scoped' }, verified: null })
    expect(database.sqlite.prepare("SELECT count(*) count FROM attempts WHERE node_path='verify' AND status='succeeded'").get()?.count).toBe(1)
    expect(database.sqlite.prepare('SELECT count(*) count FROM invocations').get()?.count).toBe(6)
  } finally { database.close() }
}, 60_000)
