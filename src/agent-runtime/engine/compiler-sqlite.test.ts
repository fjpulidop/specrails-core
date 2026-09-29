import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Command } from '@langchain/langgraph'
import { afterEach, expect, it } from 'vitest'
import { RunDatabase } from './checkpoint/database.js'
import { RunLease } from './checkpoint/lease.js'
import { RunLedger } from './checkpoint/ledger.js'
import { SqliteRunSaver } from './checkpoint/saver.js'
import { compileWorkflowDefinition } from './compiler.js'
import type { Piece } from './contracts.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { EngineEventStream } from './events.js'
import { DefinitionExecution } from './execution.js'
import { PieceRegistry } from './piece-registry.js'
import { initialDefinitionState } from './state.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('runs compiled Send branches through real SQLite and commit-held permits, then resumes after reopening', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'compiled SQLite map '))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'run.sqlite')
  let active = 0, maximum = 0
  const calls = new Map<number, number>()
  const piece = (kind: string, outcomes: string[], requiresAI: boolean, execute: Piece['execute']): Piece => ({ descriptor: { kind, outcomes, effect: 'read', requiresAI, paramsSchema: { type: 'object' } }, execute })
  const registry = new PieceRegistry([
    piece('map', ['next'], false, async () => { throw new Error('Compiler owns map') }),
    piece('join', ['next', 'fail'], false, async () => { throw new Error('Compiler owns join') }),
    piece('prompt', ['next', 'failed'], true, async (_params, context) => {
      const index = context.state.$item!.index
      calls.set(index, (calls.get(index) ?? 0) + 1)
      active += 1; maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { outcome: 'next', output: 'prepared-' + index }
    }),
    piece('question', ['next'], false, async (_params, context) => {
      const answer = context.state.$item!.index === 1 ? context.interrupt({ kind: 'question', prompt: 'Confirm?', nodePath: context.frame.nodePath, scopeId: context.frame.scope.id, attemptId: context.frame.attemptId }) : 'automatic'
      return { outcome: 'next', output: answer }
    }),
  ])
  const validated = validateWorkflowDefinition({ schemaVersion: 1, id: 'durable-map', title: 'Durable map', journal: 'ledger-only', change: 'none', entry: 'each', maxTransitions: 20, roles: [],
    nodes: { each: { kind: 'map', params: { body: 'body', over: 'tickets', concurrency: 1 }, ends: { next: 'join' } }, join: { kind: 'join', params: { reduce: 'all-ok' }, ends: { next: null, fail: null } } },
    components: { body: { entry: 'prepare', nodes: { prepare: { kind: 'prompt', params: {}, ends: { next: 'ask', failed: null } }, ask: { kind: 'question', params: {}, ends: { next: null } } } } },
  }, registry)
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors))
  let db = await RunDatabase.open(filename, { create: true })
  RunLedger.initialize(db, { runId: 'run', workflowId: validated.definition.id, definitionHash: validated.version, definition: validated.definition, request: {}, runtimeIdentity: {}, source: 'definition' })
  let lease = new RunLease(db, 'run'), token = lease.acquire('first')
  const open = () => {
    const ledger = new RunLedger(db, token, { maxTransitions: 20 })
    const stream = new EngineEventStream(cursor => ledger.events(cursor), () => {})
    const execution = new DefinitionExecution(ledger, stream, new AbortController().signal, 2)
    const saver = new SqliteRunSaver(db, ledger, { onEvents: events => execution.committed(events) })
    const graph = compileWorkflowDefinition(validated.definition, registry, execution, { checkpointer: saver, collections: { tickets: ['a', 'b', 'c'] } })
    return { ledger, execution, graph }
  }
  let runtime = open()
  cleanup.push(async () => { runtime.execution.close(); db.close() })
  const config = { configurable: { thread_id: 'run' }, durability: 'sync' as const }
  await runtime.graph.invoke(initialDefinitionState(), config)
  const state = await runtime.graph.getState(config, { subgraphs: true })
  const interrupts = state.tasks.flatMap(task => task.interrupts)
  expect(interrupts).toHaveLength(1)
  expect(maximum).toBe(1)
  expect([...calls.values()]).toEqual([1, 1, 1])
  expect(runtime.ledger.events().filter(event => event.type === 'workflow_succeeded')).toHaveLength(0)
  runtime.execution.close(); lease.release(token); db.close()
  db = await RunDatabase.open(filename)
  lease = new RunLease(db, 'run'); token = lease.acquire('second')
  runtime = open()
  const result = await runtime.graph.invoke(new Command({ resume: { [interrupts[0].id!]: 'approved' } }), config)
  expect([...calls.values()]).toEqual([1, 1, 1])
  expect(result.$outputs.join).toMatchObject({ total: 3, ok: 3, failed: 0 })
  expect(runtime.ledger.events().filter(event => event.type === 'workflow_succeeded')).toHaveLength(1)
  expect(runtime.ledger.events().filter(event => event.type === 'step_succeeded' && event.nodePath === 'join')).toHaveLength(1)
  expect(db.sqlite.prepare("SELECT count(*) AS count FROM attempts WHERE status='running'").get()?.count).toBe(0)
  db.checkIntegrity()
})
