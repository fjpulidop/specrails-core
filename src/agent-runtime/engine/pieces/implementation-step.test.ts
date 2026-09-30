import path from 'node:path'
import { AgentExecutionError } from '../../executor-types.js'
import { pipelineStateDirectory } from '../../../pipeline/pipeline-state.js'
import { afterEach, expect, it } from 'vitest'
import { implementationFixture } from '../__fixtures__/implementation-fixture.js'
import { forkRun } from '../fork.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRun, resumeRun } from '../runs.js'
import { IMPLEMENTATION_STEP_OUTCOMES } from './implementation-step.js'
import { validateWorkflowDefinition } from '../definition-validator.js'
import { validationPieceRegistry } from './index.js'

const fixtures: ReturnType<typeof implementationFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose() })
function definition() {
  const nodes: Record<string, unknown> = {}
  for (const [phase, next] of Object.entries({ architect: 'developer', developer: 'verify', fixer: 'verify', verify: 'reviewer', reviewer: 'archive', archive: 'done' })) {
    nodes[phase] = { kind: 'implementation-step', params: { phase }, ends: Object.fromEntries(IMPLEMENTATION_STEP_OUTCOMES.map(outcome => [outcome,
      ({ next, incomplete: 'developer', rejected: 'fixer', replan: 'architect', reverify: 'verify', rereview: 'reviewer', failed: 'failed' })[outcome]])) }
  }
  nodes.done = { kind: 'end', params: { outcome: 'success', requiresVerified: true }, ends: {} }
  nodes.failed = { kind: 'end', params: { outcome: 'failure' }, ends: {} }
  return { schemaVersion: 1, id: 'desktop-implement', title: 'Desktop Implement', journal: 'implementation', change: 'new', entry: 'architect', maxTransitions: 50,
    roles: ['architect', 'developer', 'reviewer'], nodes, delivery: { requiresVerified: true } }
}

function published(raw = definition()) {
  const result = validateWorkflowDefinition(raw, validationPieceRegistry(), {}, { structural: true })
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.definition
}

it('executes distinct host-authored phases with real acceptance and archive gates', async () => {
  const f = implementationFixture(); fixtures.push(f)
  const result = await createRun({ ...f, definition: published(), change: 'native-implementation' })
  expect(result, JSON.stringify({ state: result.state, error: (result as unknown as {error?: unknown}).error })).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(f.requests.map(request => request.role)).toEqual(['architect', 'developer', 'reviewer'])
})

it('resumes an archive approval using committed phase state without repeating the agents', async () => {
  const f = implementationFixture(true); fixtures.push(f)
  const result = await createRun({ ...f, definition: published(), change: 'native-implementation' })
  expect(result, JSON.stringify({ state: result.state, error: (result as unknown as {error?: unknown}).error })).toMatchObject({ state: { status: 'paused' } })
  const resumed = await resumeRun(path.join(pipelineStateDirectory(f.context), 'agent-workflow'), { registry: f.registry, answers: Object.fromEntries((result.state.pendingInterrupts ?? []).map(item => [item.id, { approved: true }])) })
  expect(resumed, JSON.stringify(resumed.state)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(f.requests.filter(request => request.role === 'developer')).toHaveLength(1)
})

it('refuses mixed wrapper/operation journals and ambiguous phase scopes', () => {
  const raw = definition()
  raw.nodes.other = { kind: 'implementation', params: {}, ends: { next: 'done', rejected: 'failed', failed: 'failed' } }
  expect(validateWorkflowDefinition(raw, validationPieceRegistry(), {}, { structural: true })).toMatchObject({ ok: false })
})

it('rebinds a fork before verification without mutating its source or trusting patched outputs', async () => {
  const f = implementationFixture(); fixtures.push(f)
  const source = await createRun({ ...f, definition: published(), change: 'native-implementation' })
  expect(source.state.status).toBe('succeeded')
  const directory = path.join(pipelineStateDirectory(f.context), 'agent-workflow')
  const before = readFileSync(path.join(directory, 'run.sqlite'))
  const fork = await forkRun(directory, { fromNodePath: 'verify', runId: 'forked-phases', registry: f.registry, state: { $outputs: { reviewer: { approved: true, score: 100 } } } })
  const result = await resumeRun(fork.directory, { registry: f.registry })
  expect(result, JSON.stringify({ state: result.state, error: 'error' in result ? result.error : undefined })).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(readFileSync(path.join(directory, 'run.sqlite'))).toEqual(before)
  expect(f.requests.filter(request => request.role === 'reviewer')).toHaveLength(2)
}, 90000)

it('executes renamed phases inside a component with isolated private state', async () => {
  const f = implementationFixture(); fixtures.push(f)
  const body = definition()
  body.nodes.done = { kind: 'end', params: { outcome: 'success', requiresVerified: false, exit: 'next' }, ends: {} }
  const names = Object.fromEntries(Object.keys(body.nodes).map(id => [id, 'custom-' + id]))
  const nodes = Object.fromEntries(Object.entries(body.nodes).map(([id, raw]) => {
    const node = raw as { ends: Record<string, string> }
    return [names[id], { ...node, ends: Object.fromEntries(Object.entries(node.ends).map(([outcome, target]) => [outcome, names[target]])) }]
  }))
  const graph = { ...body, entry: 'pipeline', nodes: {
    pipeline: { kind: 'component', params: { ref: 'recipe' }, ends: { next: 'global-check', failed: 'failed' } },
    'global-check': { kind: 'verify', params: { commands: 'configured' }, ends: { pass: 'done', fail: 'failed', failed: 'failed' } },
    done: { kind: 'end', params: { outcome: 'success', requiresVerified: true }, ends: {} }, failed: body.nodes.failed,
  }, components: { recipe: { entry: names.architect, nodes, outputs: ['next', 'failed'] } } }
  const result = await createRun({ ...f, definition: published(graph), change: 'native-implementation' })
  expect(result, JSON.stringify({ state: result.state, error: 'error' in result ? result.error : undefined })).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
}, 90000)

it('cannot certify implementation delivery by routing around acceptance and archive', async () => {
  const f = implementationFixture(); fixtures.push(f)
  const raw = definition()
  ;(raw.nodes.verify as { ends: Record<string, string> }).ends.next = 'done'
  const result = await createRun({ ...f, definition: published(raw), change: 'native-implementation' })
  expect(result.state.status).toBe('failed')
  expect(result.completion?.verified).toBe(false)
  expect(f.requests.map(request => request.role)).toEqual(['architect', 'developer'])
}, 60000)

it('routes real verification failure through the independent fixer and verifies its new candidate', async () => {
  const f = implementationFixture(); fixtures.push(f)
  const executor = f.registry.get('fixture'), execute = executor.execute.bind(executor)
  executor.execute = async request => {
    const result = await execute(request)
    if (request.role === 'developer' && f.requests.filter(item => item.role === 'developer').length === 1) writeFileSync(path.join(f.repository, 'code.cjs'), 'module.exports = 1\n')
    return result
  }
  const result = await createRun({ ...f, definition: published(), change: 'native-implementation' })
  expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(f.requests.map(request => request.role)).toEqual(['architect', 'developer', 'developer', 'reviewer'])
  expect(result.state.steps.fixer.status).toBe('succeeded')
}, 90000)

it('inherits archived evidence for a late fork without creating another implementation', async () => {
  const f = implementationFixture(); fixtures.push(f)
  await createRun({ ...f, definition: published(), change: 'native-implementation' })
  const directory = path.join(pipelineStateDirectory(f.context), 'agent-workflow')
  const calls = f.requests.length
  const fork = await forkRun(directory, { fromNodePath: 'done', runId: 'late-forked-phases', registry: f.registry })
  const result = await resumeRun(fork.directory, { registry: f.registry })
  expect(result, JSON.stringify(result)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(f.requests).toHaveLength(calls)
}, 90000)

it('requires explicit recovery for an interrupted developer write and retains committed architecture', async () => {
  const f = implementationFixture(); fixtures.push(f)
  const executor = f.registry.get('fixture'), execute = executor.execute.bind(executor)
  let interrupted = false
  executor.execute = async request => {
    const result = await execute(request)
    if (request.role === 'developer' && !interrupted) {
      interrupted = true
      throw new AgentExecutionError('Lost response after writing files', 'timeout', result.usage)
    }
    return result
  }
  const first = await createRun({ ...f, definition: published(), change: 'native-implementation' })
  expect(first.state.recoverableSteps.map(step => step.nodePath)).toContain('developer')
  const directory = path.join(pipelineStateDirectory(f.context), 'agent-workflow')
  const refused = await resumeRun(directory, { registry: f.registry })
  expect(refused).toMatchObject({ error: { code: 'recover_required' } })
  const resumed = await resumeRun(directory, { registry: f.registry, recover: ['developer'] })
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ state: { status: 'succeeded' }, completion: { ok: true, verified: true } })
  expect(f.requests.filter(request => request.role === 'architect')).toHaveLength(1)
}, 90000)
