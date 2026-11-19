import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintCandidate, pipelineStateDirectory, validatePipelineContext } from '../../../pipeline/pipeline-state.js'
import { unknownUsage, type AgentRequest, type RuntimeConfig } from '../../executor-types.js'
import { ExecutorRegistry } from '../../executors.js'
import type { RoleExecutionState } from '../../role-state.js'
import type { WorkflowStepContext } from '../../workflow-types.js'
import type { JsonValue, PieceExecutionContext } from '../contracts.js'
import { initialDefinitionState } from '../state.js'
import { createPieceRegistry } from './index.js'
import type { PieceDependencies } from './ports.js'
import { deriveImplementationBinding } from './implementation-binding.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A minimal role-turn harness: one fixture provider, a write role and a read role, no project memory. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'engine-role-turn-')); roots.push(root)
  execFileSync('git', ['init', '-q', root])
  writeFileSync(path.join(root, 'input.txt'), 'candidate')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'role-turn', backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: root }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Required feature', description: 'Preserve all behavior', acceptanceCriteria: ['Tests must pass'] }] })
  const role = { provider: 'fixture', model: 'base' }
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role },
    roles: { analyst: { ...role, access: 'read', artifacts: 'none', prompt: 'Inspect the actual evidence.' }, writer: { ...role, access: 'write', artifacts: 'none', prompt: 'Build the thing.' } }, verification: [] }
  const requests: AgentRequest[] = []
  const roleStates = new Map<string, RoleExecutionState>(), notes = new Map<string, JsonValue>()
  const registry = new ExecutorRegistry().register('fixture', {
    capabilities: () => ({ transport: 'fixture', continuation: 'supported', effortSupport: 'supported', supportedEfforts: ['low', 'high'], observedEffort: true, observedModel: true }),
    async execute(request) { requests.push(request); return { text: 'done', usage: unknownUsage() } },
  })
  const state = initialDefinitionState()
  const execution: PieceExecutionContext = { state, frame: { runId: 'role-turn', nodePath: 'node', scope: state.$scope, task: { checkpointThreadId: 'role-turn', checkpointId: 'cp', taskCheckpointNs: '', taskId: 'task' },
    visitId: 'visit', visit: 1, transition: 1, attemptId: 'attempt', attempt: 1, leaseEpoch: 1 }, signal: new AbortController().signal, progress: vi.fn(), interrupt: () => { throw new Error('PAUSED') } }
  const scope = { context, scopeHash: 'scope', artifactExclusions: [], runtimeExclusions: [] as string[] }
  const candidate = () => ({ hash: fingerprintCandidate(scope), atTransition: execution.frame.transition, revision: execution.frame.transition })
  let ordinal = 0
  const step = { runId: 'role-turn', stepId: 'node', attemptId: 'attempt', attempt: 1, input: null,
    checkpoint: { history: [], events: [], steps: {} }, signal: execution.signal, remainingBudget: () => ({}), reportUsage: vi.fn(),
    reportInvocationStarted: async () => ({ invocationId: 'invocation-' + ++ordinal, ordinal }), reportInvocation: async () => {},
  } as unknown as WorkflowStepContext
  const deps: PieceDependencies = { context, config, registry, stepContext: () => step,
    roleState: ctx => { const key = ctx.frame.scope.id + '/' + ctx.frame.nodePath; return { read: () => structuredClone(roleStates.get(key) ?? { sessions: {}, routes: {} }), write: value => { roleStates.set(key, structuredClone(value)) } } },
    memory: () => { throw new Error('Fixture project memory is not enabled') },
    memo: ctx => ({ get: key => notes.get(ctx.frame.attemptId + ':' + key), set: (key, value) => { notes.set(ctx.frame.attemptId + ':' + key, structuredClone(value)) } }),
    settleResult: (ctx, key, value) => { notes.set(ctx.frame.attemptId + ':' + key, structuredClone(value)) },
    executionSnapshot: () => ({ candidate: candidate(), verified: execution.state.$verified }), artifactDirectory: () => path.join(pipelineStateDirectory(context), 'node-artifacts'),
    bindImplementation: (execution, change) => deriveImplementationBinding(context, execution, change),
    verification: () => { const hash = candidate().hash; return { candidateHash: hash, scopeHash: 'scope', isCurrent: () => candidate().hash === hash, persistCheck: () => {}, commitReceipt: value => value } },
  }
  const pieces = createPieceRegistry(deps)
  const run = async (params: Record<string, JsonValue>) => {
    expect(pieces.validateParams('role-turn', params, '/test')).toEqual([])
    return pieces.get('role-turn').execute(params, execution)
  }
  return { deps, pieces, run, requests, execution }
}

const PLAN_HEADING = 'Core owns these complete verification commands and will run them after your turn.'

describe('role-turn host plan visibility', () => {
  it('shows a custom write role the configured checks plus the proposals named by verificationProposalsFrom, deduplicated and only for repositories without a configured check', async () => {
    const f = fixture()
    f.deps.config.verification = [{ repositoryId: 'repo', command: 'npm', args: ['test'] }, { repositoryId: 'other', command: 'cargo', args: ['test'] }]
    f.execution.state.$outputs.architect = { structured: { verification: [
      { repositoryId: 'repo', command: 'npm', args: ['run', 'test:e2e'] },
      { repositoryId: 'repo', command: 'npm', args: ['run', 'test:e2e'] },
      { repositoryId: 'unknown', command: 'npm', args: ['run', 'lint'] },
    ] } }
    // Configured repository: proposals are ignored, exactly as the verify piece does.
    expect(await f.run({ roleId: 'writer', prompt: 'Implement', verificationProposalsFrom: 'architect' })).toMatchObject({ outcome: 'next' })
    const configured = f.requests[0].prompt
    expect(configured).toContain(PLAN_HEADING)
    expect(configured).toContain('- repository `repo`: `npm test`')
    expect(configured).not.toContain('`cargo test`')
    expect(configured).not.toContain('test:e2e')
    expect(configured).not.toContain('run lint')
    expect(configured.indexOf(PLAN_HEADING)).toBeLessThan(configured.indexOf('## Current workflow task'))
    // No configured check for the repository: the proposal is admitted once.
    f.deps.config.verification = [{ repositoryId: 'other', command: 'cargo', args: ['test'] }]
    f.execution.frame.nodePath = 'developer'
    await f.run({ roleId: 'writer', prompt: 'Implement', verificationProposalsFrom: 'architect' })
    const proposed = f.requests[1].prompt
    expect(proposed).toContain(PLAN_HEADING)
    expect(proposed.split('- repository `repo`: `npm run test:e2e`')).toHaveLength(2)
    expect(proposed).not.toContain('`cargo test`')
    expect(proposed).not.toContain('run lint')
  })

  it('omits the plan without a configured check or a proposals source, ignores a missing or malformed source, and never shows it to a read-only role', async () => {
    const f = fixture()
    f.deps.config.verification = [{ repositoryId: 'repo', command: 'npm', args: ['test'] }]
    f.execution.state.$outputs.architect = { structured: { verification: 'not-an-array' } }
    await f.run({ roleId: 'writer', prompt: 'Implement', verificationProposalsFrom: 'architect' })
    expect(f.requests[0].prompt).toContain('- repository `repo`: `npm test`')
    f.execution.frame.nodePath = 'missing-source'
    await f.run({ roleId: 'writer', prompt: 'Implement', verificationProposalsFrom: 'nobody' })
    expect(f.requests[1].prompt).toContain('- repository `repo`: `npm test`')
    f.execution.frame.nodePath = 'reader'
    await f.run({ roleId: 'analyst', prompt: 'Inspect', verificationProposalsFrom: 'architect' })
    expect(f.requests[2].prompt).not.toContain(PLAN_HEADING)
    expect(f.requests[2].prompt).not.toContain('npm test')
    f.deps.config.verification = []
    f.execution.frame.nodePath = 'empty'
    await f.run({ roleId: 'writer', prompt: 'Implement' })
    expect(f.requests[3].prompt).not.toContain(PLAN_HEADING)
    expect(f.pieces.validateParams('role-turn', { roleId: 'writer', prompt: 'x', verificationProposalsFrom: '' }, '/test')).not.toEqual([])
  })
})

describe('role-turn fixer stance', () => {
  // The built-in developer's FIXER instructions, host fixer prompt and fixer engine need a real OpenSpec change: derive-change.test.ts covers them end to end.

  it('accepts only the fixer stance in the closed params schema', () => {
    const f = fixture()
    expect(f.pieces.validateParams('role-turn', { roleId: 'writer', prompt: 'Fix', stance: 'fixer' }, '/test')).toEqual([])
    for (const stance of ['developer', '', 1, null]) expect(f.pieces.validateParams('role-turn', { roleId: 'writer', prompt: 'Fix', stance } as Record<string, JsonValue>, '/test')).toEqual([expect.objectContaining({ code: 'invalid_piece_params', path: '/test/params/stance' })])
  })

  it('rejects the fixer stance on a read role before any provider call', async () => {
    const f = fixture()
    await expect(f.run({ roleId: 'analyst', prompt: 'Fix', stance: 'fixer' })).rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('write access') })
    expect(f.requests).toHaveLength(0)
  })

  it('labels a custom write role as the fixer without changing its instructions or engine', async () => {
    const f = fixture()
    const events: JsonValue[] = []
    f.execution.progress = vi.fn(event => { events.push(event.payload as JsonValue) })
    const registry = f.deps.registry
    f.deps.registry = new ExecutorRegistry().register('fixture', { capabilities: () => registry.capabilities('fixture'),
      async execute(request) { f.requests.push(request); request.onEvent?.({ kind: 'text', text: 'working' }); return { text: 'done', usage: unknownUsage() } } })
    expect(await f.run({ roleId: 'writer', prompt: 'Fix the findings', stance: 'fixer' })).toMatchObject({ outcome: 'next' })
    expect(f.requests[0]).toMatchObject({ role: 'writer', stance: 'fixer', model: 'base' })
    expect(f.requests[0].prompt).toContain('## Your task: writer')
    expect(f.requests[0].prompt).toContain('Build the thing.')
    expect(events).toContainEqual(expect.objectContaining({ role: 'fixer', event: { kind: 'text', text: 'working' } }))
  })
})

describe('role-turn skipped OpenSpec workflow (contract 5.16)', () => {
  it('fails the turn with code openspec_workflow_omitted after one corrective turn, never as an unknown invalid reply', async () => {
    const f = fixture()
    const stateDirectory = path.join(f.deps.context.artifactRoot, '.plan-state')
    f.deps.config.roles!.plan = { provider: 'fixture', model: 'small', access: 'write', artifacts: 'all', prompt: 'Plan the change.', openspecSkill: 'openspec-ff-change' }
    // The binding is never executed here: the fixture role makes no workflow calls at all.
    f.deps.openspec = () => ({ plan: { root: f.deps.context.artifactRoot, change: 'skipped', stateDirectory, cli: '/unused/openspec.js', skillPath: '/unused/SKILL.md', skillHash: 'unused',
      role: 'plan', access: 'write', artifacts: 'all', openspecSkill: 'openspec-ff-change' } }) as never
    const schema = { type: 'object', required: ['confidence'], properties: { confidence: { type: 'string' } } }
    const result = await f.run({ roleId: 'plan', prompt: 'Plan', structuredOutput: schema })
    expect(result).toMatchObject({ outcome: 'invalid', error: { code: 'openspec_workflow_omitted',
      message: expect.stringContaining('the plan model (fixture/small) skipped the required OpenSpec steps again after one corrective reminder') } })
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]!.prompt).toContain('Your turn ended without these required steps: load_skill, instructions tasks.')
    expect(f.requests[1]!.prompt).toContain('1. {"action":"load_skill"}\n2. {"action":"new"}')
  })
})

describe("role-turn decisions: 'ask' (capability roleDecisions)", () => {
  const implementation = { type: 'object', additionalProperties: false, required: ['summary', 'incomplete'], properties: { summary: { type: 'string' }, incomplete: { type: 'array', items: { type: 'string' } } } }
  /** Replies in order; each reply is the structured JSON the role returns. */
  function scripted(f: ReturnType<typeof fixture>, replies: Array<Record<string, unknown>>) {
    const registry = f.deps.registry
    f.deps.registry = new ExecutorRegistry().register('fixture', { capabilities: () => registry.capabilities('fixture'),
      async execute(request) { f.requests.push(request); const reply = replies.shift(); if (!reply) throw new Error('unexpected provider call'); return { text: JSON.stringify(reply), usage: unknownUsage() } } })
  }
  const contradiction = 'Task 2.1 requires touch controls, but design.md lists touch controls as a non-goal. Implement them (option A) or drop task 2.1 (option B)?'

  it('asks the person the contradiction, memoizes the turn before pausing, and reruns once with the answer', async () => {
    const f = fixture()
    scripted(f, [{ summary: 'Did the keyboard part', incomplete: ['2.1 touch controls'], decisionNeeded: contradiction },
      { summary: 'Implemented touch controls as the person decided', incomplete: [], decisionNeeded: '' }])
    const params = { roleId: 'writer', prompt: 'Implement every task', structuredOutput: implementation, decisions: 'ask' } as Record<string, JsonValue>
    await expect(f.run(params)).rejects.toThrow('PAUSED')
    expect(f.requests).toHaveLength(1)
    // The role sees the rule and the extra field; the host's own schema stays untouched.
    expect(f.requests[0].prompt).toContain('## A decision only the person can make')
    expect(f.requests[0].prompt).toContain('Never write such a decision into `incomplete`')
    expect(JSON.stringify(f.requests[0].outputSchema)).toContain('decisionNeeded')
    expect(JSON.stringify(implementation)).not.toContain('decisionNeeded')
    const asked: unknown[] = []
    f.execution.interrupt = request => { asked.push(request); return { answer: 'Option A: implement them.' } }
    const result = await f.run(params)
    // The resume replays the memoized first round instead of calling the provider again.
    expect(f.requests).toHaveLength(2)
    expect(asked).toEqual([expect.objectContaining({ kind: 'question', prompt: contradiction, nodePath: 'node' })])
    expect(f.requests[1].prompt).toContain("## The person's decision 1")
    expect(f.requests[1].prompt).toContain('Option A: implement them.')
    expect(result).toMatchObject({ outcome: 'next', answers: [{ value: { answer: 'Option A: implement them.' } }],
      output: { structured: { summary: 'Implemented touch controls as the person decided', incomplete: [] }, decisions: [{ question: contradiction, answer: 'Option A: implement them.' }] } })
    expect((result.output as { structured: Record<string, unknown> }).structured).not.toHaveProperty('decisionNeeded')
    // Later turns read the question and the answer through {{history.text}}.
    expect(result.history?.map(entry => entry.text).join('\n')).toContain('Human decision requested: ' + contradiction)
    expect(new Set(result.history?.map(entry => entry.id)).size).toBe(result.history?.length)
  })

  it('questionOptions: offers the role\'s choices with its question and removes them from the committed output', async () => {
    const f = fixture()
    scripted(f, [{ summary: 'Keyboard part', incomplete: ['2.1'], decisionNeeded: contradiction, decisionOptions: [{ id: 'a', label: 'Implement touch', meaning: 'Adds it.' }, { id: 'b', label: 'Drop 2.1', meaning: 'Keeps the non-goal.' }], decisionRecommended: 'b' },
      { summary: 'Dropped', incomplete: [], decisionNeeded: '', decisionOptions: [], decisionRecommended: '' }])
    const params = { roleId: 'writer', prompt: 'Implement', structuredOutput: implementation, decisions: 'ask', stance: 'fixer' } as Record<string, JsonValue>
    const asked: unknown[] = []
    f.execution.interrupt = request => { asked.push(request); return { answer: 'Drop 2.1', optionId: 'b' } }
    const result = await f.run(params).catch(() => f.run(params))
    expect(f.requests[0].prompt).toContain('decisionOptions')
    expect(asked[0]).toMatchObject({ kind: 'question', text: contradiction, asker: 'fixer', recommended: 'b', options: [{ id: 'a' }, { id: 'b', label: 'Drop 2.1' }] })
    expect(f.requests[1].prompt).toContain('The person chose \\"Drop 2.1\\" (Keeps the non-goal.).')
    expect((result.output as { structured: Record<string, unknown> }).structured).toEqual({ summary: 'Dropped', incomplete: [] })
  })

  it('stays autonomous when the role needs no decision: one call, the host schema shape, no answers', async () => {
    const f = fixture()
    scripted(f, [{ summary: 'All done', incomplete: [], decisionNeeded: '' }])
    f.execution.interrupt = () => { throw new Error('must not ask') }
    const result = await f.run({ roleId: 'writer', prompt: 'Implement', structuredOutput: implementation, decisions: 'ask' })
    expect(f.requests).toHaveLength(1)
    expect(result).toMatchObject({ outcome: 'next', output: { structured: { summary: 'All done', incomplete: [] } } })
    expect(result.answers).toBeUndefined()
    expect(result.output).not.toHaveProperty('decisions')
    expect((result.output as { structured: Record<string, unknown> }).structured).not.toHaveProperty('decisionNeeded')
  })

  it('bounds the questions: after the last allowed answer the role must finish without asking', async () => {
    const f = fixture()
    scripted(f, [...Array.from({ length: 3 }, (_, index) => ({ summary: 'stuck', incomplete: ['x'], decisionNeeded: 'Question ' + index })), { summary: 'finished', incomplete: [] }])
    let asked = 0
    f.execution.interrupt = () => 'answer ' + asked++
    const result = await f.run({ roleId: 'writer', prompt: 'Implement', structuredOutput: implementation, decisions: 'ask' })
    expect(asked).toBe(3)
    expect(f.requests).toHaveLength(4)
    expect(f.requests[3].prompt).not.toContain('## A decision only the person can make')
    expect(JSON.stringify(f.requests[3].outputSchema)).not.toContain('decisionNeeded')
    expect(f.requests[3].prompt).toContain('answer 2')
    expect(result).toMatchObject({ outcome: 'next', output: { structured: { summary: 'finished' } } })
    expect((result.output as { decisions: unknown[] }).decisions).toHaveLength(3)
  })

  it('validates the opt-in: only an object schema with properties, never one already declaring the field', async () => {
    const f = fixture()
    expect(f.pieces.validateParams('role-turn', { roleId: 'writer', prompt: 'x', decisions: 'always' }, '/test')).not.toEqual([])
    await expect(f.run({ roleId: 'writer', prompt: 'x', decisions: 'ask' })).rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(f.run({ roleId: 'writer', prompt: 'x', decisions: 'ask', structuredOutput: { type: 'object', properties: { decisionNeeded: { type: 'string' } } } })).rejects.toMatchObject({ code: 'invalid_arguments' })
    expect(f.requests).toHaveLength(0)
  })
})

describe('role-turn review triage (capability reviewTriage)', () => {
  const reviewSchema = { type: 'object', additionalProperties: false, required: ['approved', 'summary', 'issues', 'score', 'brief'], properties: { approved: { type: 'boolean' }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } }, score: { type: 'number' },
    brief: { type: 'object', additionalProperties: false, required: ['humanChecks'], properties: { humanChecks: { type: 'array', items: { type: 'string' } } } } } }
  function scripted(f: ReturnType<typeof fixture>, replies: Array<Record<string, unknown>>) {
    const registry = f.deps.registry
    f.deps.registry = new ExecutorRegistry().register('fixture', { capabilities: () => registry.capabilities('fixture'),
      async execute(request) { f.requests.push(request); const reply = replies.shift(); if (!reply) throw new Error('unexpected provider call'); return { text: JSON.stringify(reply), usage: unknownUsage() } } })
  }
  const lockfile = 'Delete src-tauri/Cargo.lock: it is out-of-scope churn.'
  const frozen = 'Amend design.md to record the cargo manifest path.'

  it('re-judges a rejection made only of issues the run cannot act on, and hands them to the person as notes (the Tauri run)', async () => {
    const f = fixture()
    scripted(f, [{ approved: false, summary: 'Churn', issues: [lockfile, frozen], score: 60, brief: { humanChecks: ['Open the window on macOS'] } },
      { approved: true, summary: 'Search works and is tested', issues: [], score: 88, brief: { humanChecks: ['Open the window on macOS'] } }])
    const result = await f.run({ roleId: 'analyst', prompt: 'Review the change', structuredOutput: reviewSchema })
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].prompt).toContain('## Core review triage')
    expect(f.requests[1].prompt).toContain(lockfile)
    const output = result.output as { structured: { approved: boolean; issues: string[]; score: number; brief: { humanChecks: string[] } }; reviewNotes: Array<{ kind: string }> }
    expect(output.structured).toMatchObject({ approved: true, issues: [], score: 88 })
    expect(output.structured.brief.humanChecks[0]).toBe('Open the window on macOS')
    expect(output.structured.brief.humanChecks.slice(1)).toEqual([expect.stringContaining(lockfile), expect.stringContaining(frozen)])
    expect(output.reviewNotes.map(note => note.kind)).toEqual(['regenerated-lockfile', 'frozen-artifact'])
    expect(result.history?.map(entry => entry.text).join('\n')).toContain('Core review triage')
  })

  it('keeps a genuine rejection: only the non-actionable issue leaves, no second review', async () => {
    const f = fixture()
    const genuine = 'The search handler ignores an empty query; return every item and add a test for it.'
    scripted(f, [{ approved: false, summary: 'Bug', issues: [genuine, lockfile], score: 55, brief: { humanChecks: [] } }])
    const result = await f.run({ roleId: 'analyst', prompt: 'Review', structuredOutput: reviewSchema })
    expect(f.requests).toHaveLength(1)
    expect(result.output).toMatchObject({ structured: { approved: false, issues: [genuine], score: 55, brief: { humanChecks: [expect.stringContaining(lockfile)] } } })
  })

  it('stays rejected when the re-judged review still rejects, without a third call', async () => {
    const f = fixture()
    scripted(f, [{ approved: false, summary: 'x', issues: [frozen], score: 50, brief: { humanChecks: [] } },
      { approved: false, summary: 'Missing test', issues: ['No test covers the empty query; add one to the vitest suite.'], score: 60, brief: { humanChecks: [] } }])
    const result = await f.run({ roleId: 'analyst', prompt: 'Review', structuredOutput: reviewSchema })
    expect(f.requests).toHaveLength(2)
    expect(result.output).toMatchObject({ structured: { approved: false, issues: ['No test covers the empty query; add one to the vitest suite.'] }, reviewNotes: [{ kind: 'frozen-artifact' }] })
  })

  it('drops an issue about a criterion the person withdrew in an answer from an approving review', async () => {
    const f = fixture()
    f.execution.state.$answers = [{ id: 'a', transition: 1, attempt: 1, ordinal: 0, nodePath: 'clarify', value: { answer: 'Drop O(1) and uniqueness.' } }]
    scripted(f, [{ approved: true, summary: 'ok', issues: ['Lookup is O(n), the spec requires O(1).'], score: 80, brief: { humanChecks: [] } }])
    const result = await f.run({ roleId: 'analyst', prompt: 'Review', structuredOutput: reviewSchema })
    expect(f.requests).toHaveLength(1)
    expect(result.output).toMatchObject({ structured: { approved: true, issues: [] }, reviewNotes: [{ kind: 'withdrawn-criterion' }] })
  })

  it('leaves write roles and reviews without such issues exactly as returned', async () => {
    const f = fixture()
    const reply = { approved: false, summary: 'Bug', issues: ['Fix paginate() off-by-one and add a test.'], score: 40, brief: { humanChecks: [] } }
    scripted(f, [reply, { ...reply, issues: [lockfile] }])
    expect((await f.run({ roleId: 'analyst', prompt: 'Review', structuredOutput: reviewSchema })).output).toEqual(expect.objectContaining({ structured: reply }))
    f.execution.frame.nodePath = 'writer-node'
    const written = await f.run({ roleId: 'writer', prompt: 'Build', structuredOutput: reviewSchema })
    expect(written.output).toMatchObject({ structured: { issues: [lockfile] } })
    expect(written.output).not.toHaveProperty('reviewNotes')
    expect(f.requests).toHaveLength(2)
  })
})

describe("role-turn machineInstalls: 'ask' (capability machineInstalls)", () => {
  const blocker = { type: 'object', properties: { kind: { type: 'string' }, command: { type: 'string' }, evidence: { type: 'string' }, requiredAction: { type: 'string' }, install: { type: 'string' } }, required: ['kind', 'requiredAction'] }
  const implementation = { type: 'object', additionalProperties: false, required: ['summary', 'incomplete'], properties: { summary: { type: 'string' }, incomplete: { type: 'array', items: { type: 'string' } }, blocker } }
  function scripted(f: ReturnType<typeof fixture>, replies: Array<Record<string, unknown>>) {
    const registry = f.deps.registry
    f.deps.registry = new ExecutorRegistry().register('fixture', { capabilities: () => registry.capabilities('fixture'),
      async execute(request) { f.requests.push(request); const reply = replies.shift(); if (!reply) throw new Error('unexpected provider call'); return { text: JSON.stringify(reply), usage: unknownUsage() } } })
  }
  const needsTerraform = { summary: 'Module written; terraform validate could not run', incomplete: ['3.1 validate the module'],
    blocker: { kind: 'toolchain', command: 'terraform validate', evidence: 'terraform: command not found', requiredAction: 'Install terraform with `brew install terraform`.', install: 'brew install terraform' } }
  const params = { roleId: 'writer', prompt: 'Implement every task', structuredOutput: implementation, machineInstalls: 'ask' } as Record<string, JsonValue>

  it('asks once with the exact command and options, memoizes the turn, and reruns it after the host installed the tool', async () => {
    const f = fixture()
    scripted(f, [needsTerraform, { summary: 'Validated the module', incomplete: [] }])
    await expect(f.run(params)).rejects.toThrow('PAUSED')
    expect(f.requests).toHaveLength(1)
    const asked: unknown[] = []
    f.execution.interrupt = request => { asked.push(request); return { answer: 'installed' } }
    const result = await f.run(params)
    expect(asked).toEqual([expect.objectContaining({ kind: 'question', prompt: 'This run needs terraform. Install it with `brew install terraform`?', nodePath: 'node',
      options: [{ id: 'install', label: 'Install', meaning: expect.any(String) }, { id: 'self', label: "I'll do it myself", meaning: expect.any(String) }],
      data: { kind: 'machine-install', command: 'brew install terraform', tool: 'terraform' } })])
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].prompt).toContain('## Host install')
    expect(f.requests[1].prompt).toContain('The person approved `brew install terraform` and the host ran it outside the run')
    expect(result).toMatchObject({ outcome: 'next', output: { structured: { summary: 'Validated the module', incomplete: [] } }, answers: [{ value: { answer: 'installed' } }] })
    expect(result.history?.map(entry => entry.text).join('\n')).toContain('Machine-wide install requested: brew install terraform')
  })

  it("commits the blocker with the person's step on 'I'll do it myself' or a failed install, without another provider call", async () => {
    for (const [answer, action] of [['declined', 'Run `brew install terraform` yourself'], ['failed: Error: No available formula', 'The approved install `brew install terraform` failed (Error: No available formula)'], ['refused: it needs an administrator password', 'Specrails cannot run `brew install terraform` for you (it needs an administrator password)']]) {
      const f = fixture()
      scripted(f, [needsTerraform])
      f.execution.interrupt = () => ({ answer })
      const result = await f.run(params)
      expect(f.requests).toHaveLength(1)
      expect((result.output as { structured: { blocker: { requiredAction: string; install: string } } }).structured.blocker).toMatchObject({ install: 'brew install terraform', requiredAction: expect.stringContaining(action) })
    }
  })

  it('stays autonomous without an install, without the opt-in and for a read role', async () => {
    const f = fixture()
    scripted(f, [{ summary: 'done', incomplete: [] }, needsTerraform])
    f.execution.interrupt = () => { throw new Error('must not ask') }
    await f.run(params)
    const plain = await f.run({ roleId: 'writer', prompt: 'Implement', structuredOutput: implementation })
    expect((plain.output as { structured: { blocker: unknown } }).structured.blocker).toMatchObject({ install: 'brew install terraform' })
    expect(f.pieces.validateParams('role-turn', { roleId: 'writer', prompt: 'x', machineInstalls: 'always' }, '/test')).not.toEqual([])
  })

  it('composes with decisions: an install asked inside a decision round keeps its own memo', async () => {
    const f = fixture()
    scripted(f, [needsTerraform, { summary: 'Validated', incomplete: [], decisionNeeded: '' }])
    const asked: Array<{ data?: unknown }> = []
    f.execution.interrupt = request => { asked.push(request as { data?: unknown }); return { answer: 'installed' } }
    const result = await f.run({ ...params, decisions: 'ask' })
    expect(asked).toHaveLength(1)
    expect(asked[0].data).toMatchObject({ kind: 'machine-install' })
    expect(result).toMatchObject({ outcome: 'next', output: { structured: { summary: 'Validated' } } })
  })
})
