import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { validatePipelineContext } from '../../pipeline/pipeline-state.js'
import { ExecutorRegistry } from '../executors.js'
import type { AgentRequest, RuntimeConfig } from '../executor-types.js'
import { configuredRoles } from './preflight.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { validationPieceRegistry } from './pieces/index.js'
import type { DefinitionNode, WorkflowDefinitionDraft } from './definition-types.js'
import { createRun, definitionRunDirectory, resumeRun } from './runs.js'
import { forkRun } from './fork.js'
import { RunDatabase } from './checkpoint/database.js'
import { RunLease } from './checkpoint/lease.js'
import { observeLedger, statusRun } from './run-status.js'
import { implementationFixture } from './__fixtures__/implementation-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const done: DefinitionNode = { kind: 'end', params: { outcome: 'success' }, ends: {} }
const prompt = (text: string, next: string): DefinitionNode => ({ kind: 'prompt', params: { engine: { provider: 'fixture' }, access: 'read', text }, ends: { next, failed: null } })
function journalBytes(root: string, relative = ''): Record<string, Buffer> {
  const result: Record<string, Buffer> = {}
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const key = path.join(relative, entry.name)
    if (entry.isDirectory()) Object.assign(result, journalBytes(root, key))
    else if (!/run\.sqlite-(?:wal|shm)$/.test(key)) result[key] = readFileSync(path.join(root, key))
  }
  return result
}
function fixture(nodes: Record<string, DefinitionNode>, extra: Partial<WorkflowDefinitionDraft> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'real run fork ')); roots.push(root)
  const repository = path.join(root, 'repo'), backlogRoot = path.join(root, 'backlog'); mkdirSync(repository); mkdirSync(backlogRoot)
  execFileSync('git', ['init', '-q', repository]); writeFileSync(path.join(repository, 'source.txt'), 'source remains untouched')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'source', backlogRoot, artifactRoot: repository, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [0, 1, 2].map(id => ({ id, title: 'Ticket ' + id, description: 'Inspect this ticket' })) })
  const role = { provider: 'fixture' }, config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [] }
  const requests: AgentRequest[] = [], registry = new ExecutorRegistry().register('fixture', { execute: async request => { requests.push(request); return { text: 'Prepared', usage: { inputTokens: 2, outputTokens: 1, costUsd: null } } } })
  const validation = validateWorkflowDefinition({ schemaVersion: 1, id: 'fork-fixture', title: 'Fork fixture', journal: 'ledger-only', change: 'none', roles: [], maxTransitions: 50,
    entry: Object.keys(nodes)[0], nodes, ...extra }, validationPieceRegistry(), configuredRoles(config))
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors))
  return { root, context, config, registry, requests, definition: validation.definition, directory: definitionRunDirectory(context) }
}

it('publishes an immutable historical cut, patches only vars/outputs and never reexecutes its completed prefix', async () => {
  const f = fixture({ before: prompt('Before', 'ask'), ask: { kind: 'question', params: { text: 'Continue?' }, ends: { next: 'after' } }, after: prompt('After {{run.word}}', 'done'), done })
  const original = await createRun(f)
  expect(original.state.status).toBe('paused'); expect(f.requests).toHaveLength(1)
  const filename = path.join(f.directory, 'run.sqlite'), bytes = readFileSync(filename)
  await expect(forkRun(f.directory, { fromNodePath: 'ask', runId: 'invalid', state: { $budget: 1 } as never, registry: f.registry })).rejects.toMatchObject({ code: 'invalid_arguments' })
  const fork = await forkRun(f.directory, { fromNodePath: 'ask', runId: 'fork', state: { $vars: { word: 'forked' } }, registry: f.registry })
  expect(readFileSync(filename)).toEqual(bytes)
  expect((await statusRun(f.directory)).state.status).toBe('paused')
  const paused = await resumeRun(fork.directory, { registry: f.registry })
  expect(paused.state.status).toBe('paused'); expect(f.requests).toHaveLength(1)
  const result = await resumeRun(fork.directory, { registry: f.registry, answers: { [paused.state.pendingInterrupts[0].id]: { answer: 'Yes' } } })
  expect(result.state.status).toBe('succeeded'); expect(f.requests).toHaveLength(2)
  expect(f.requests[1].prompt).toContain('After forked')
  expect(result.state.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, costUsd: null })
  expect(readFileSync(filename)).toEqual(bytes)
  const db = await RunDatabase.open(path.join(fork.directory, 'run.sqlite'), { readOnly: true })
  try { expect(observeLedger(db).events().filter(event => event.type === 'efficiency_updated')).toHaveLength(1) } finally { db.close() }
})

it('rejects an active source lease and ambiguous visits without leaving a destination', async () => {
  const f = fixture({ ask: { kind: 'question', params: { text: 'Continue?' }, ends: { next: 'done' } }, done })
  await createRun(f)
  const db = await RunDatabase.open(path.join(f.directory, 'run.sqlite')), lease = new RunLease(db, 'source'), token = lease.acquire('active')
  try { await expect(forkRun(f.directory, { fromNodePath: 'ask', runId: 'rejected', registry: f.registry })).rejects.toMatchObject({ code: 'lease_held' }) }
  finally { lease.release(token); db.close() }
  expect(existsSync(path.join(f.context.backlogRoot, '.specrails/pipeline/rejected'))).toBe(false)
  await expect(forkRun(f.directory, { fromNodePath: 'missing', runId: 'rejected', registry: f.registry })).rejects.toMatchObject({ code: 'fork_ambiguous' })
})

it('preserves completed siblings and a nested child checkpoint when applying a branch-local state patch', async () => {
  const f = fixture({ each: { kind: 'map', params: { over: 'tickets', body: 'body', concurrency: 1 }, ends: { next: 'join' } },
    join: { kind: 'join', params: { reduce: 'all-ok' }, ends: { next: 'done', fail: null } }, done }, {
    components: { body: { entry: 'prepare', nodes: { prepare: prompt('Prepare {{run.index}}', 'decide'),
      decide: { kind: 'condition', params: { expr: '$item.index == 1' }, ends: { true: 'ask', false: 'finish' } },
      ask: { kind: 'question', params: { text: 'Approve branch one?' }, ends: { next: 'finish' } }, finish: done } } },
  })
  expect((await createRun(f)).state.status).toBe('paused')
  const beforeZero = f.requests.filter(request => request.prompt.startsWith('Prepare 0')).length
  const beforeOne = f.requests.filter(request => request.prompt.startsWith('Prepare 1')).length
  const bytes = readFileSync(path.join(f.directory, 'run.sqlite'))
  const fork = await forkRun(f.directory, { fromNodePath: 'each/ask', runId: 'nested-fork', state: { $vars: { branchHint: 'fork only' } }, registry: f.registry })
  const paused = await resumeRun(fork.directory, { registry: f.registry })
  expect(paused.state.status, JSON.stringify(paused)).toBe('paused')
  const result = await resumeRun(fork.directory, { registry: f.registry, answers: { [paused.state.pendingInterrupts[0].id]: { answer: 'Approved' } } })
  expect(result.state.status, JSON.stringify(result)).toBe('succeeded')
  expect(f.requests.filter(request => request.prompt.startsWith('Prepare 0'))).toHaveLength(beforeZero)
  expect(f.requests.filter(request => request.prompt.startsWith('Prepare 1'))).toHaveLength(beforeOne)
  expect(readFileSync(path.join(f.directory, 'run.sqlite'))).toEqual(bytes)
})

it.each(['ask', 'done'])('inherits completed implementation evidence at %s without repeating provider calls, and invalidates it after a code edit', async fromNodePath => {
  const f = implementationFixture(); roots.push(f.root)
  const validated = validateWorkflowDefinition({ schemaVersion: 1, id: 'late-fork', title: 'Late implementation fork', journal: 'implementation', change: 'new',
    roles: ['architect', 'developer', 'reviewer'], maxTransitions: 30, entry: 'implement', nodes: {
      implement: { kind: 'implementation', params: {}, ends: { next: 'ask', rejected: 'failed', failed: 'failed' } },
      ask: { kind: 'question', params: { text: 'Finish?' }, ends: { next: 'done' } },
      done: { kind: 'end', params: { outcome: 'success', requiresVerified: true }, ends: {} },
      failed: { kind: 'end', params: { outcome: 'failure' }, ends: {} },
    } }, validationPieceRegistry(), configuredRoles(f.config))
  if (!validated.ok) throw Error(JSON.stringify(validated.errors))
  const directory = definitionRunDirectory(f.context)
  const original = await createRun({ ...f, definition: validated.definition, change: 'native-implementation' })
  expect(original.state.status, JSON.stringify(original)).toBe('paused')
  expect((await resumeRun(directory, { registry: f.registry, answers: { [original.state.pendingInterrupts[0].id]: { answer: 'Yes' } } })).completion?.ok).toBe(true)
  const calls = f.requests.length, bytes = readFileSync(path.join(directory, 'run.sqlite')), sourceJournal = journalBytes(path.dirname(directory))
  const fork = await forkRun(directory, { fromNodePath, runId: 'late-' + fromNodePath, registry: f.registry })
  let result = await resumeRun(fork.directory, { registry: f.registry })
  if (result.state.status === 'paused') result = await resumeRun(fork.directory, { registry: f.registry,
    answers: { [result.state.pendingInterrupts[0].id]: { answer: 'Yes' } } })
  expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(f.requests).toHaveLength(calls)
  expect(readFileSync(path.join(directory, 'run.sqlite'))).toEqual(bytes)
  expect(journalBytes(path.dirname(directory))).toEqual(sourceJournal)
  if (fromNodePath === 'done') {
    const patched = await forkRun(directory, { fromNodePath, runId: 'patched-done', registry: f.registry, state: { $vars: { verificationInput: 'changed' } } })
    const unverified = await resumeRun(patched.directory, { registry: f.registry })
    expect(unverified.completion).toMatchObject({ ok: false, verified: false, reasons: ['unverified'] })
    expect(f.requests).toHaveLength(calls)
  }
  const edited = await forkRun(directory, { fromNodePath, runId: 'edited-' + fromNodePath, registry: f.registry })
  writeFileSync(path.join(f.repository, 'code.cjs'), 'module.exports = 3\n')
  let failed = await resumeRun(edited.directory, { registry: f.registry })
  if (failed.state.status === 'paused') failed = await resumeRun(edited.directory, { registry: f.registry,
    answers: { [failed.state.pendingInterrupts[0].id]: { answer: 'Yes' } } })
  expect(failed.completion?.verified).not.toBe(true)
  expect(failed.state.status).not.toBe('succeeded')
  expect(f.requests).toHaveLength(calls)
  expect(readFileSync(path.join(directory, 'run.sqlite'))).toEqual(bytes)
  expect(journalBytes(path.dirname(directory))).toEqual(sourceJournal)
}, process.platform === 'win32' ? 180_000 : 120_000)

it('restores the exact incomplete implementation journal and preserves its completed architect', async () => {
  const f = implementationFixture(); roots.push(f.root)
  const definition = JSON.parse(readFileSync(new URL('./__fixtures__/implementation.json', import.meta.url), 'utf8'))
  const original = await createRun({ ...f, definition, change: 'native-implementation' })
  expect(original, JSON.stringify(original)).toMatchObject({ completion: { ok: true, verified: true } })
  const directory = definitionRunDirectory(f.context), bytes = readFileSync(path.join(directory, 'run.sqlite'))
  const roles = f.requests.map(request => request.role)
  const fork = await forkRun(directory, { fromNodePath: 'implement/developer', runId: 'unfinished-fork', registry: f.registry })
  const resumed = await resumeRun(fork.directory, { registry: f.registry })
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ completion: { ok: true, verified: true } })
  expect(f.requests.slice(roles.length).map(request => request.role)).toEqual(['developer', 'reviewer'])
  expect(readFileSync(path.join(directory, 'run.sqlite'))).toEqual(bytes)
}, process.platform === 'win32' ? 180_000 : 120_000)
