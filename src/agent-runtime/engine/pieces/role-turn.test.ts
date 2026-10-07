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
