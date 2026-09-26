import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validatePipelineContext } from '../../pipeline/pipeline-state.js'
import type { AgentRequest, RuntimeConfig } from '../executor-types.js'
import { ExecutorRegistry } from '../executors.js'
import { configuredRoles } from './preflight.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { validationPieceRegistry } from './pieces/index.js'
import type { DefinitionNode, WorkflowDefinitionDraft } from './definition-types.js'
import { cancelRun, createRun, definitionRunDirectory, resumeRun, signalRun } from './runs.js'
import { statusRun } from './run-status.js'
import { RunDatabase } from './checkpoint/database.js'
import { RunLease } from './checkpoint/lease.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const done: DefinitionNode = { kind: 'end', params: { outcome: 'success' }, ends: {} }
const prompt: DefinitionNode = { kind: 'prompt', params: { engine: { provider: 'fixture' }, text: 'Read the project', access: 'read' }, ends: { next: 'done', failed: null } }

function fixture(nodes: Record<string, DefinitionNode> = { done }, extra: Partial<WorkflowDefinitionDraft> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'definition runtime ')); directories.push(root)
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlog); execFileSync('git', ['init', '-q', repository])
  writeFileSync(path.join(repository, 'source.txt'), 'frozen fixture')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'definition', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 'goal', title: 'Inspect project', description: 'Execute the selected workflow' }] })
  const role = { provider: 'fixture' }, config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [] }
  const requests: AgentRequest[] = []
  const registry = new ExecutorRegistry().register('fixture', { async execute(request) { requests.push(request); return { text: 'Inspected', usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 } } } })
  const published = validateWorkflowDefinition({ schemaVersion: 1, id: 'runtime-test', title: 'Runtime test', journal: 'ledger-only', change: 'none', roles: [],
    entry: Object.keys(nodes)[0], maxTransitions: 20, nodes, ...extra }, validationPieceRegistry(), configuredRoles(config))
  if (!published.ok) throw new Error(JSON.stringify(published.errors))
  return { root, context, config, definition: published.definition, registry, requests, directory: definitionRunDirectory(context) }
}

it('executes a published graph and status remains read-only with no implementation journal', async () => {
  const f = fixture(), events: unknown[] = []
  const result = await createRun({ ...f, onEvent: value => events.push(value) })
  expect(result.state.status).toBe('succeeded')
  expect(result.completion).toMatchObject({ ok: true, verified: false })
  const filename = path.join(f.directory, 'run.sqlite'), bytes = readFileSync(filename), before = statSync(filename)
  expect(await statusRun(f.directory)).toMatchObject({ engineVersion: 2, state: { status: 'succeeded' } })
  expect(readFileSync(filename)).toEqual(bytes); expect(statSync(filename).mtimeMs).toBe(before.mtimeMs)
  expect(existsSync(path.join(path.dirname(f.directory), 'state.json'))).toBe(false)
  expect(events.filter(value => (value as { event?: { type: string } }).event?.type === 'workflow_succeeded')).toHaveLength(1)
  expect(events.filter(value => (value as { type: string }).type === 'runtime-graph')).toHaveLength(1)
  expect(result.efficiencySummary.invocations).toMatchObject({ total: 0, complete: true })
})

it('answers a durable question after closing SQLite without repeating a provider call', async () => {
  const f = fixture({ inspect: { ...prompt, ends: { next: 'ask', failed: null } }, ask: { kind: 'question', params: { text: 'Continue?' }, ends: { next: 'done' } }, done })
  const first = await createRun(f)
  expect(first.state.status).toBe('paused'); expect(f.requests).toHaveLength(1)
  const question = first.state.pendingInterrupts[0]
  const resumed = await resumeRun(f.directory, { registry: f.registry, answers: { [question.id]: { answer: 'Continue' } } })
  expect(resumed.state.status).toBe('succeeded'); expect(f.requests).toHaveLength(1)
  expect(resumed.state.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, costUsd: 0.01 })
})

it('rejects an answer for the wrong interrupt without altering its pending question', async () => {
  const f = fixture({ ask: { kind: 'question', params: { text: 'Continue?' }, ends: { next: 'done' } }, done })
  await createRun(f)
  await expect(resumeRun(f.directory, { registry: f.registry, answers: { unknown: { answer: 'No' } } })).rejects.toMatchObject({ code: 'interrupt_not_found' })
  expect((await statusRun(f.directory)).state.status).toBe('paused')
  expect((await statusRun(f.directory)).state.pendingInterrupts).toHaveLength(1)
})

it('enforces global visits on a cycle and leaves an inspectable failure', async () => {
  const f = fixture({ cycle: { kind: 'condition', params: { expr: 'true == true' }, ends: { true: 'cycle', false: 'done' } }, done }, { maxTransitions: 3 })
  const result = await createRun(f)
  expect(result.state.status).toBe('failed')
  expect(result).toMatchObject({ error: { code: 'recursion_limit' } })
})

it('intersects provider budgets and persists billed usage exactly once', async () => {
  const f = fixture({ inspect: prompt, done }, { budget: { maxTokens: 80, maxCostUsd: 0.5 } })
  f.config.limits = { maxTokens: 50, maxCostUsd: 0.2 }
  const result = await createRun(f)
  expect(result.state.status).toBe('succeeded')
  expect(f.requests[0]).toMatchObject({ maxTokens: 50, maxCostUsd: 0.2 })
  expect(result.state.usage).toMatchObject({ knownTokens: 5, costUsd: 0.01 })
  expect(result.efficiencySummary.invocations.total).toBe(1)
  expect(result.efficiencySummary.reservations.pendingInvocations).toBe(0)
})

it('claims operator steering once for the next AI attempt', async () => {
  const f = fixture({ ask: { kind: 'question', params: { text: 'Start?' }, ends: { next: 'inspect' } }, inspect: prompt, done })
  const first = await createRun(f)
  const message = await signalRun(f.directory, 'Focus on the parser', 'host-control-1')
  expect((await signalRun(f.directory, 'Focus on the parser', 'host-control-1')).id).toBe(message.id)
  await resumeRun(f.directory, { registry: f.registry, answers: { [first.state.pendingInterrupts[0].id]: { answer: 'Start' } } })
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].prompt).toContain('Focus on the parser')
})

it('delivers claimed steering to an open role while preserving its frozen instructions', async () => {
  const f = fixture()
  f.config.roles = { observer: { provider: 'fixture', access: 'read', artifacts: 'none', prompt: 'Inspect only; never edit the project.' } }
  const { version: _version, ...draft } = f.definition
  void _version
  const published = validateWorkflowDefinition({ ...draft, entry: 'ask', roles: ['observer'], nodes: {
    ask: { kind: 'question', params: { text: 'Begin?' }, ends: { next: 'observe' } },
    observe: { kind: 'role-turn', params: { roleId: 'observer', prompt: 'Describe the selected files' }, ends: { next: 'done', failed: null } }, done,
  } }, validationPieceRegistry(), configuredRoles(f.config))
  if (!published.ok) throw new Error(JSON.stringify(published.errors))
  f.definition = published.definition
  const paused = await createRun(f)
  await signalRun(f.directory, 'Inspect the public parser API', 'role-note')
  const result = await resumeRun(f.directory, { registry: f.registry, answers: { [paused.state.pendingInterrupts[0].id]: { answer: 'Begin' } } })
  expect(result.state.status).toBe('succeeded')
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({ role: 'observer', access: 'read', artifacts: 'none' })
  expect(f.requests[0].prompt).toContain('Inspect the public parser API')
  expect(f.requests[0].prompt).toContain('Inspect only; never edit the project.')
  expect(f.requests[0].prompt).toContain('Current frozen acceptance obligations')
})

it('cancels an inactive human pause and rejects subsequent provider execution', async () => {
  const f = fixture({ ask: { kind: 'approval', params: { reason: 'Proceed?' }, ends: { next: 'inspect' } }, inspect: prompt, done })
  await createRun(f); await cancelRun(f.directory, 'cancel-1')
  expect((await resumeRun(f.directory, { registry: f.registry })).state.status).toBe('cancelled')
  expect(f.requests).toHaveLength(0)
})

it('does not duplicate the terminal cancellation event when its request is retried', async () => {
  const f = fixture({ ask: { kind: 'approval', params: { reason: 'Proceed?' }, ends: { next: 'inspect' } }, inspect: prompt, done })
  await createRun(f)
  const accepted = await cancelRun(f.directory, 'cancel-retry')
  expect(await cancelRun(f.directory, 'cancel-retry')).toEqual(accepted)
  const database = await RunDatabase.open(path.join(f.directory, 'run.sqlite'), { readOnly: true })
  try {
    const rows = database.sqlite.prepare('SELECT payload_json FROM events WHERE run_id=?').all(f.context.runId)
    expect(rows.filter(row => JSON.parse(String(row.payload_json)).type === 'workflow_cancelled')).toHaveLength(1)
  } finally { database.close() }
})

it('rejects an incompatible definition before creating a run database', async () => {
  const f = fixture()
  await expect(createRun({ ...f, definition: { ...f.definition, title: 'Tampered' } })).rejects.toMatchObject({ code: 'invalid_definition' })
  expect(existsSync(f.directory)).toBe(false)
})

it('refuses a second executor while the existing lease is current', async () => {
  const f = fixture({ ask: { kind: 'question', params: { text: 'Continue?' }, ends: { next: 'done' } }, done })
  await createRun(f)
  const database = await RunDatabase.open(path.join(f.directory, 'run.sqlite')), lease = new RunLease(database, f.context.runId), token = lease.acquire('another-process')
  try { await expect(resumeRun(f.directory, { registry: f.registry })).rejects.toMatchObject({ code: 'lease_held' }) }
  finally { lease.release(token); database.close() }
})
