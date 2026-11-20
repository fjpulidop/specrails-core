import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validatePipelineContext } from '../../pipeline/pipeline-state.js'
import { AgentExecutionError, type AgentRequest, type RuntimeConfig } from '../executor-types.js'
import { ExecutorRegistry } from '../executors.js'
import { RunDatabase } from './checkpoint/database.js'
import { configuredRoles } from './preflight.js'
import { validateWorkflowDefinition } from './definition-validator.js'
import { validationPieceRegistry } from './pieces/index.js'
import { createRun, definitionRunDirectory, resumeRun } from './runs.js'
import { forkRun } from './fork.js'
import { existsSync } from 'node:fs'
import { definitionFailure, runDefinitionCommand } from './cli.js'
import { applyRouteOverrides, parseRouteOverrideRequest, type RouteOverrideRequest } from './route-overrides.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const usage = { inputTokens: 3, outputTokens: 2, costUsd: 0.01 }

/** builder (write) and observer (read) start on `alpha`, which refuses on its usage limit; `gamma` keeps the auditor. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'route overrides ')); directories.push(root)
  const repository = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlog); execFileSync('git', ['init', '-q', repository])
  writeFileSync(path.join(repository, 'source.txt'), 'fixture')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'switching', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 'goal', title: 'Build', description: 'Build it' }] })
  const role = { provider: 'gamma' }
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [],
    roles: { builder: { provider: 'alpha', model: 'a-large', maxTurns: 7, escalation: { model: 'a-huge' }, access: 'write', artifacts: 'none' },
      observer: { provider: 'alpha', access: 'read', artifacts: 'none' }, auditor: { provider: 'gamma', access: 'read', artifacts: 'none' } } }
  const calls: Array<{ provider: string; request: AgentRequest }> = []
  let alphaLimited = true
  const executor = (provider: string) => ({
    capabilities: () => ({ transport: provider, continuation: 'unsupported' as const, effortSupport: 'supported' as const, supportedEfforts: ['low'], observedModel: false, observedEffort: false }),
    async execute(request: AgentRequest) {
      calls.push({ provider, request })
      if (provider === 'alpha' && alphaLimited) throw new AgentExecutionError('alpha usage limit reached (5h window, resets 2026-11-21T03:00:00.000Z).', 'provider_limit', { inputTokens: 0, outputTokens: 0, costUsd: 0 })
      return { text: `${request.role} on ${provider}`, usage }
    },
  })
  const registry = () => new ExecutorRegistry().register('alpha', executor('alpha')).register('beta', executor('beta')).register('gamma', executor('gamma'))
  const published = validateWorkflowDefinition({ schemaVersion: 1, id: 'switching', title: 'Switching', journal: 'ledger-only', change: 'none', roles: ['builder', 'observer', 'auditor'], entry: 'build', maxTransitions: 20,
    delivery: { requiresVerified: false },
    nodes: {
      build: { kind: 'role-turn', params: { roleId: 'builder', prompt: 'Build', sessionContinuity: 'none' }, ends: { next: 'observe', failed: null } },
      observe: { kind: 'role-turn', params: { roleId: 'observer', prompt: 'Observe' }, ends: { next: 'audit', failed: null } },
      audit: { kind: 'role-turn', params: { roleId: 'auditor', prompt: 'Audit' }, ends: { next: 'done', failed: null } },
      done: { kind: 'end', params: { outcome: 'success' }, ends: {} },
    } }, validationPieceRegistry(), configuredRoles(config))
  if (!published.ok) throw new Error(JSON.stringify(published.errors))
  return { context, config, definition: published.definition, registry, calls, directory: definitionRunDirectory(context), allowAlpha: () => { alphaLimited = false } }
}

const move = (extra: Partial<RouteOverrideRequest> = {}): RouteOverrideRequest => ({ schemaVersion: 1, requestId: 'switch-1', reason: 'provider-limit', fromProvider: 'alpha',
  routes: { builder: { provider: 'beta', model: 'b-small', effort: 'low' }, observer: { provider: 'beta', model: 'b-small' } }, ...extra })

it('moves the refused step and every later step of the moved roles to the new route; the frozen request stays as written', async () => {
  const f = fixture()
  const failed = await createRun({ ...f, registry: f.registry() })
  // A refused write stops interrupted (hosts read it as failed) and resumes without explicit recovery.
  expect(failed.state.status).toBe('interrupted')
  expect(definitionFailure({ status: 'failed', error: { code: 'provider_limit', message: 'codex usage limit reached (5h window, resets 2026-11-21T03:00:00.000Z).' } }).failure).toMatchObject({ kind: 'provider_limit', provider: 'codex', resetsAt: '2026-11-21T03:00:00.000Z' })
  const requestFile = path.join(path.dirname(f.directory), 'agent-runtime-request.json'), frozen = readFileSync(requestFile, 'utf8')
  const events: Array<Record<string, unknown>> = []
  const resumed = await resumeRun(f.directory, { registry: f.registry(), routeOverride: move(), onEvent: value => events.push(value) })
  expect(resumed.state.status).toBe('succeeded')
  // build was refused on alpha, then ran on beta; observe never touched alpha; the auditor kept gamma.
  expect(f.calls.map(call => [call.request.role, call.provider, call.request.model ?? null, call.request.effort ?? null, call.request.maxTurns ?? null])).toEqual([
    ['builder', 'alpha', 'a-large', null, 7], ['builder', 'beta', 'b-small', 'low', 7], ['observer', 'beta', 'b-small', null, null], ['auditor', 'gamma', null, null, null]])
  expect(readFileSync(requestFile, 'utf8')).toBe(frozen)
  const recorded = events.find(event => (event.event as { type?: string } | undefined)?.type === 'routes_overridden')?.event as Record<string, unknown>
  expect(recorded).toMatchObject({ requestId: 'switch-1', fromProvider: 'alpha', routes: { builder: { provider: 'beta', model: 'b-small', effort: 'low' } } })
  // Spend stays with the provider each invocation ran on.
  const database = await RunDatabase.open(path.join(f.directory, 'run.sqlite'), { readOnly: true })
  try {
    expect(database.sqlite.prepare('SELECT role, provider, model FROM invocations ORDER BY ordinal, started_at').all().map(row => `${row.role}:${row.provider}:${row.model ?? ''}`).sort())
      .toEqual(['auditor:gamma:', 'builder:alpha:a-large', 'builder:beta:b-small', 'observer:beta:b-small'])
  } finally { database.close() }
})

it('keeps a recorded override for every later admission of the run and applies a repeated request once', async () => {
  const f = fixture()
  await createRun({ ...f, registry: f.registry() })
  // A second limit, now on beta: the run stops again on the moved route...
  const limitedBeta = () => f.registry().register('beta', { capabilities: async () => ({ transport: 'beta', continuation: 'unsupported' as const, effortSupport: 'supported' as const, supportedEfforts: ['low'], observedModel: false, observedEffort: false }),
    async execute(request) { f.calls.push({ provider: 'beta', request }); throw new AgentExecutionError('beta usage limit reached.', 'provider_limit') } })
  expect((await resumeRun(f.directory, { registry: limitedBeta(), routeOverride: move() })).state.status).toBe('interrupted')
  // The same request id again is idempotent; a different body under it is a conflict.
  expect((await resumeRun(f.directory, { registry: limitedBeta(), routeOverride: move() })).state.status).toBe('interrupted')
  await expect(resumeRun(f.directory, { registry: f.registry(), routeOverride: move({ routes: { builder: { provider: 'gamma' } } }) })).rejects.toMatchObject({ code: 'control_conflict' })
  // ...and a plain resume (the automatic one at the reset) stays on beta, not the frozen alpha.
  f.calls.length = 0
  expect((await resumeRun(f.directory, { registry: f.registry() })).state.status).toBe('succeeded')
  expect(f.calls[0]).toMatchObject({ provider: 'beta', request: { role: 'builder', model: 'b-small' } })
  const database = await RunDatabase.open(path.join(f.directory, 'run.sqlite'), { readOnly: true })
  try { expect(database.sqlite.prepare("SELECT COUNT(*) count FROM events WHERE type='routes_overridden'").get()!.count).toBe(1) } finally { database.close() }
})

it('refuses an unknown role, an unconfirmed effort, an unconfigured provider and a finished run', async () => {
  const f = fixture()
  await createRun({ ...f, registry: f.registry() })
  await expect(resumeRun(f.directory, { registry: f.registry(), routeOverride: move({ routes: { ghost: { provider: 'beta' } } }) })).rejects.toMatchObject({ code: 'invalid_route_override' })
  await expect(resumeRun(f.directory, { registry: f.registry(), routeOverride: move({ routes: { builder: { provider: 'beta', effort: 'high' } } }) })).rejects.toThrow(/effort 'high' is not confirmed/)
  await expect(resumeRun(f.directory, { registry: f.registry(), routeOverride: move({ routes: { builder: { provider: 'nowhere' } } }) })).rejects.toThrow(/nowhere/)
  // Nothing was recorded by the refused requests.
  f.allowAlpha()
  expect((await resumeRun(f.directory, { registry: f.registry(), routeOverride: move({ requestId: 'switch-2' }) })).state.status).toBe('succeeded')
  await expect(resumeRun(f.directory, { registry: f.registry(), routeOverride: move({ requestId: 'switch-3' }) })).rejects.toMatchObject({ code: 'invalid_route_override' })
})

it('validates the request shape and moves built-in roles in both views of a normalized configuration', () => {
  expect(() => parseRouteOverrideRequest({ schemaVersion: 1, requestId: 'x', routes: {} })).toThrow(/at least one role/)
  expect(() => parseRouteOverrideRequest({ schemaVersion: 2, requestId: 'x', routes: { developer: { provider: 'claude' } } })).toThrow(/schemaVersion/)
  expect(() => parseRouteOverrideRequest({ schemaVersion: 1, requestId: 'x', routes: { developer: { provider: 'claude', temperature: 1 } } })).toThrow(/temperature/)
  expect(() => parseRouteOverrideRequest({ schemaVersion: 1, requestId: 'x', routes: { developer: { provider: 'claude' } }, providers: [{ id: 'api', kind: 'openai-compatible' }] })).toThrow(/CLI connection/)
  const frozen: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [{ id: 'codex', kind: 'cli', cli: 'codex' }], verification: [],
    agents: { architect: { provider: 'codex' }, developer: { provider: 'codex', model: 'gpt', effort: 'high', escalation: { model: 'gpt-max' } }, reviewer: { provider: 'codex' } },
    roles: { developer: { provider: 'codex', model: 'gpt', effort: 'high', escalation: { model: 'gpt-max' }, access: 'write', artifacts: 'tasks-checkboxes', openspecSkill: 'openspec-apply-change' } },
    fixer: { provider: 'codex', model: 'gpt' } }
  const moved = applyRouteOverrides(frozen, [parseRouteOverrideRequest({ schemaVersion: 1, requestId: 'x', routes: { developer: { provider: 'claude', model: 'haiku' }, fixer: { provider: 'claude', model: 'haiku' } }, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }] })])
  expect(moved.agents.developer).toEqual({ provider: 'claude', model: 'haiku' })
  expect(moved.roles!.developer).toEqual({ provider: 'claude', model: 'haiku', access: 'write', artifacts: 'tasks-checkboxes', openspecSkill: 'openspec-apply-change' })
  expect(moved.fixer).toEqual({ provider: 'claude', model: 'haiku' })
  expect(moved.providers.map(provider => provider.id)).toEqual(['codex', 'claude'])
  expect(frozen.agents.developer.provider).toBe('codex')
})

it('the CLI reads --route-overrides and refuses combining it with an answer', async () => {
  const f = fixture()
  await createRun({ ...f, registry: f.registry() })
  const file = path.join(path.dirname(f.directory), 'moves.json'), contextFile = path.join(path.dirname(f.directory), 'context.json')
  writeFileSync(file, JSON.stringify(move())); writeFileSync(contextFile, JSON.stringify(f.context))
  await expect(runDefinitionCommand({ context: contextFile, 'route-overrides': file, answer: 'yes' }, ['resume'], () => {})).rejects.toMatchObject({ code: 'invalid_arguments' })
  writeFileSync(file, '{"schemaVersion":1}')
  await expect(runDefinitionCommand({ context: contextFile, 'route-overrides': file }, ['resume'], () => {})).rejects.toMatchObject({ code: 'invalid_route_override' })
})

it('a fork carries route overrides: the new run starts on the moved routes and records them as its own event', async () => {
  const f = fixture()
  // The source stopped at the limit and is never re-opened: the next attempt forks from the refused step.
  await createRun({ ...f, registry: f.registry() })
  const sourceRequest = readFileSync(path.join(path.dirname(f.directory), 'agent-runtime-request.json'), 'utf8')
  const fork = await forkRun(f.directory, { fromNodePath: 'build', runId: 'switching-next', requestId: 'continue-1', routeOverride: move(), registry: f.registry() })
  expect(fork.routesOverridden).toMatchObject({ requestId: 'switch-1', routes: { builder: { provider: 'beta' } } })
  // A lost acknowledgement retried with the same request returns the same child.
  expect(await forkRun(f.directory, { fromNodePath: 'build', runId: 'switching-next', requestId: 'continue-1', routeOverride: move(), registry: f.registry() })).toEqual(fork)
  // The same request id with other routes is another request: refused, not adopted.
  await expect(forkRun(f.directory, { fromNodePath: 'build', runId: 'switching-next', requestId: 'continue-1', routeOverride: move({ routes: { builder: { provider: 'gamma' } } }), registry: f.registry() })).rejects.toMatchObject({ code: 'run_exists' })
  f.calls.length = 0
  // A plain resume of the fork (no override on it) runs the moved roles on beta.
  expect((await resumeRun(fork.directory, { registry: f.registry() })).state.status).toBe('succeeded')
  expect(f.calls.map(call => [call.request.role, call.provider, call.request.model ?? null, call.request.maxTurns ?? null])).toEqual([
    ['builder', 'beta', 'b-small', 7], ['observer', 'beta', 'b-small', null], ['auditor', 'gamma', null, null]])
  const database = await RunDatabase.open(path.join(fork.directory, 'run.sqlite'), { readOnly: true })
  try {
    const events = database.sqlite.prepare("SELECT payload_json, inherited FROM events WHERE type='routes_overridden'").all()
    expect(events).toHaveLength(1)
    expect(Number(events[0].inherited)).toBe(0)
  } finally { database.close() }
  // The source run and its frozen request are untouched.
  expect(readFileSync(path.join(path.dirname(f.directory), 'agent-runtime-request.json'), 'utf8')).toBe(sourceRequest)
  const source = await RunDatabase.open(path.join(f.directory, 'run.sqlite'), { readOnly: true })
  try { expect(source.sqlite.prepare("SELECT COUNT(*) count FROM events WHERE type='routes_overridden'").get()!.count).toBe(0) } finally { source.close() }
})

it('a fork refuses an override a resume would refuse, and publishes nothing', async () => {
  const f = fixture()
  await createRun({ ...f, registry: f.registry() })
  const child = (runId: string) => path.join(path.dirname(path.dirname(f.directory)), runId)
  await expect(forkRun(f.directory, { fromNodePath: 'build', runId: 'next-ghost', routeOverride: move({ routes: { ghost: { provider: 'beta' } } }), registry: f.registry() })).rejects.toMatchObject({ code: 'invalid_route_override' })
  await expect(forkRun(f.directory, { fromNodePath: 'build', runId: 'next-effort', routeOverride: move({ routes: { builder: { provider: 'beta', effort: 'high' } } }), registry: f.registry() })).rejects.toThrow(/effort 'high' is not confirmed/)
  await expect(forkRun(f.directory, { fromNodePath: 'build', runId: 'next-nowhere', routeOverride: move({ routes: { builder: { provider: 'nowhere' } } }), registry: f.registry() })).rejects.toThrow(/nowhere/)
  for (const runId of ['next-ghost', 'next-effort', 'next-nowhere']) expect(existsSync(path.join(child(runId), 'agent-workflow', 'run.sqlite'))).toBe(false)
  // The CLI reads the file and refuses combining it with resume-only controls.
  const file = path.join(path.dirname(f.directory), 'moves.json'), contextFile = path.join(path.dirname(f.directory), 'context.json')
  writeFileSync(file, JSON.stringify(move())); writeFileSync(contextFile, JSON.stringify(f.context))
  await expect(runDefinitionCommand({ context: contextFile, from: 'build', 'run-id': 'next-cli', 'route-overrides': file, answer: 'yes' }, ['fork'], () => {})).rejects.toMatchObject({ code: 'invalid_arguments' })
  writeFileSync(file, '{"schemaVersion":1}')
  await expect(runDefinitionCommand({ context: contextFile, from: 'build', 'run-id': 'next-cli', 'route-overrides': file }, ['fork'], () => {})).rejects.toMatchObject({ code: 'invalid_route_override' })
})

it('a fork of a moved run inherits its routes and adds its own on top', async () => {
  const f = fixture()
  await createRun({ ...f, registry: f.registry() })
  const first = await forkRun(f.directory, { fromNodePath: 'build', runId: 'first-move', routeOverride: move(), registry: f.registry() })
  // The moved builder refuses again (beta is limited too): the next attempt moves it to gamma, the observer stays on beta.
  const limitedBeta = () => f.registry().register('beta', { capabilities: async () => ({ transport: 'beta', continuation: 'unsupported' as const, effortSupport: 'supported' as const, supportedEfforts: ['low'], observedModel: false, observedEffort: false }),
    async execute(request) { f.calls.push({ provider: 'beta', request }); if (request.role === 'builder') throw new AgentExecutionError('beta usage limit reached.', 'provider_limit'); return { text: 'ok', usage } } })
  expect((await resumeRun(first.directory, { registry: limitedBeta() })).state.status).toBe('interrupted')
  const second = await forkRun(first.directory, { fromNodePath: 'build', runId: 'second-move', routeOverride: move({ requestId: 'switch-2', fromProvider: 'beta', routes: { builder: { provider: 'gamma' } } }), registry: f.registry() })
  f.calls.length = 0
  expect((await resumeRun(second.directory, { registry: f.registry() })).state.status).toBe('succeeded')
  expect(f.calls.map(call => [call.request.role, call.provider])).toEqual([['builder', 'gamma'], ['observer', 'beta'], ['auditor', 'gamma']])
})
