import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintCandidate, pipelineStateDirectory, validatePipelineContext, type CommandReceipt, type VerificationReceipt } from '../../../pipeline/pipeline-state.js'
import { AgentExecutionError, unknownUsage, type AgentRequest, type AgentResult, type RuntimeConfig } from '../../executor-types.js'
import type { ProviderInvocation } from '../../efficiency-types.js'
import { ExecutorRegistry } from '../../executors.js'
import type { RoleExecutionState } from '../../role-state.js'
import type { WorkflowStepContext } from '../../workflow-types.js'
import type { JsonValue, PieceExecutionContext, PieceResult } from '../contracts.js'
import { SqliteProjectStore } from '../store/sqlite-store.js'
import { capturePattern } from '../regex.js'
import { initialDefinitionState } from '../state.js'
import { createPieceRegistry } from './index.js'
import type { PieceDependencies } from './ports.js'
import { shellCommand } from './shell.js'
import { deriveImplementationBinding } from './implementation-binding.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(respond: (request: AgentRequest, call: number) => AgentResult | Promise<AgentResult> = () => ({ text: 'done', usage: unknownUsage() })) {
  const root = mkdtempSync(path.join(tmpdir(), 'engine-pieces-')); roots.push(root)
  execFileSync('git', ['init', '-q', root])
  writeFileSync(path.join(root, 'input.txt'), 'candidate')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'pieces', backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: root }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Required feature', description: 'Preserve all behavior', acceptanceCriteria: ['Tests must pass'] }] })
  const role = { provider: 'fixture', model: 'base' }
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role },
    roles: { analyst: { ...role, access: 'read', artifacts: 'none', prompt: 'Inspect the actual evidence.' }, writer: { ...role, access: 'write', artifacts: 'none' } }, verification: [] }
  const requests: AgentRequest[] = [], invocations: ProviderInvocation[] = [], evidence: CommandReceipt[] = [], receipts: VerificationReceipt[] = []
  const roleStates = new Map<string, RoleExecutionState>(), notes = new Map<string, JsonValue>()
  const registry = new ExecutorRegistry().register('fixture', {
    capabilities: () => ({ transport: 'fixture', continuation: 'supported', effortSupport: 'supported', supportedEfforts: ['low', 'high'], observedEffort: true, observedModel: true }),
    async execute(request) { requests.push(request); return respond(request, requests.length) },
  })
  const state = initialDefinitionState()
  const execution: PieceExecutionContext = { state, frame: { runId: 'pieces', nodePath: 'node', scope: state.$scope, task: { checkpointThreadId: 'pieces', checkpointId: 'cp', taskCheckpointNs: '', taskId: 'task' },
    visitId: 'visit', visit: 1, transition: 1, attemptId: 'attempt', attempt: 1, leaseEpoch: 1 }, signal: new AbortController().signal, progress: vi.fn(), interrupt: () => { throw new Error('PAUSED') } }
  const scope = { context, scopeHash: 'scope', artifactExclusions: [], runtimeExclusions: [] as string[] }
  const candidate = () => ({ hash: fingerprintCandidate(scope), atTransition: execution.frame.transition, revision: execution.frame.transition })
  let ordinal = 0
  const step = { runId: 'pieces', stepId: 'node', attemptId: 'attempt', attempt: 1, input: null,
    checkpoint: { history: [], events: [], steps: {} }, signal: execution.signal, remainingBudget: () => ({}), reportUsage: vi.fn(),
    reportInvocationStarted: async () => ({ invocationId: 'invocation-' + ++ordinal, ordinal }), reportInvocation: async (invocation: ProviderInvocation) => { invocations.push(invocation) },
  } as unknown as WorkflowStepContext
  const deps: PieceDependencies = { context, config, registry, stepContext: () => step,
    roleState: ctx => { const key = ctx.frame.scope.id + '/' + ctx.frame.nodePath; return { read: () => structuredClone(roleStates.get(key) ?? { sessions: {}, routes: {} }), write: value => { roleStates.set(key, structuredClone(value)) } } },
    memory: () => { throw new Error('Fixture project memory is not enabled') },
    memo: ctx => ({ get: key => notes.get(ctx.frame.attemptId + ':' + key), set: (key, value) => { notes.set(ctx.frame.attemptId + ':' + key, structuredClone(value)) } }),
    settleResult: (ctx, key, value, invocation) => { invocations.push(invocation); notes.set(ctx.frame.attemptId + ':' + key, structuredClone(value)) },
    executionSnapshot: () => ({ candidate: candidate(), verified: execution.state.$verified }), artifactDirectory: () => path.join(pipelineStateDirectory(context), 'node-artifacts'),
    bindImplementation: (execution, change) => deriveImplementationBinding(context, execution, change),
    verification: () => { const hash = candidate().hash; return { candidateHash: hash, scopeHash: 'scope', isCurrent: () => candidate().hash === hash,
      persistCheck: value => { evidence.push(structuredClone(value)) }, commitReceipt: value => { receipts.push(structuredClone(value)); return value } } },
  }
  const pieces = createPieceRegistry(deps)
  const run = async (kind: string, params: Record<string, JsonValue>): Promise<PieceResult> => {
    expect(pieces.validateParams(kind, params, '/test')).toEqual([])
    return pieces.get(kind).execute(params, execution)
  }
  return { root, context, deps, pieces, run, requests, invocations, evidence, receipts, execution, step, roleStates, scope }
}

describe('reviewed piece catalog and control', () => {
  it('registers every implemented kind with exact parameter alternatives', () => {
    const f = fixture()
    expect(f.pieces.catalog()).toHaveLength(16)
    expect(f.pieces.validateParams('prompt', { engine: { provider: 'fixture' }, text: 'hi', nativeCommand: { id: 'opsx:ff' }, access: 'write' }, '')).not.toEqual([])
    expect(f.pieces.validateParams('shell', { repositoryId: 'repo', argv: ['node'], commandLine: 'node' }, '')).not.toEqual([])
    expect(f.pieces.outcomes('prompt', { sentinel: 'verification' })).toEqual(['pass', 'fail', 'failed'])
    expect(f.pieces.outcomes('role-turn', {})).toEqual(['next', 'failed'])
    expect(f.pieces.validateParams('prompt', { engine: { provider: 'fixture' }, text: 'hi', access: 'read', captureVars: [{ name: 'constructor', pattern: '(x)' }] }, '')).not.toEqual([])
  })
  it('interrupts before any question side effects and retains the answered value', async () => {
    const f = fixture()
    await expect(f.run('question', { text: 'Choose a scope' })).rejects.toThrow('PAUSED')
    expect(f.requests).toEqual([])
    f.execution.interrupt = request => { expect(request).toMatchObject({ scopeId: 'root', attemptId: 'attempt', kind: 'question' }); return { answer: 'only app' } }
    expect(await f.run('question', { text: 'Choose a scope' })).toMatchObject({ outcome: 'next', answers: [{ value: { answer: 'only app' }, nodePath: 'node' }] })
  })
  it('uses a current host snapshot for completion and reports condition failures', async () => {
    const f = fixture()
    expect(await f.run('end', { outcome: 'success', requiresVerified: true })).toMatchObject({ completion: { ok: false, verified: false, reasons: ['unverified'] } })
    f.execution.state.$verified = { receiptId: 'receipt', candidateHash: f.deps.executionSnapshot(f.execution).candidate!.hash, atTransition: 1, revision: 1 }
    expect(await f.run('end', { outcome: 'success', requiresVerified: true })).toMatchObject({ completion: { ok: true, verified: true } })
    writeFileSync(path.join(f.root, 'input.txt'), 'changed since verified')
    expect(await f.run('end', { outcome: 'success', requiresVerified: true })).toMatchObject({ completion: { ok: false, verified: false } })
    expect(await f.run('condition', { expr: 'exists($vars.missing)' })).toMatchObject({ outcome: 'false' })
    expect(await f.pieces.get('condition').execute({ expr: 'process.exit()' }, f.execution)).toMatchObject({ outcome: 'false', completion: { reasons: ['condition_error:node'] } })
  })
  it('bounds catastrophic regex matching without accepting user JavaScript', () => {
    expect(capturePattern('change: ([a-z-]+)', 'change: feature-x')).toEqual(['change: feature-x', 'feature-x'])
    const start = Date.now()
    expect(() => capturePattern('a+a+a+a+b', 'a'.repeat(32_000))).toThrow('50 ms')
    expect(Date.now() - start).toBeLessThan(1500)
    expect(() => capturePattern('('.repeat(201), '')).toThrow('200')
    expect(capturePattern('"; process.exit(); //', 'innocent')).toBeNull()
  })
})

describe('free prompts and declared roles', () => {
  it('passes explicit free policy, native arguments and actual unknown usage', async () => {
    const f = fixture(() => ({ text: 'CHANGE: feature-x\nVERIFICATION: PASS\nVERIFICATION: FAIL', usage: unknownUsage(), sessionId: 'session-1' }))
    const result = await f.run('prompt', { engine: { provider: 'fixture', model: 'base', effort: 'low' }, nativeCommand: { id: 'opsx:ff', args: 'user $(literal)' }, access: 'write', sentinel: 'verification', captureVars: [{ name: 'changeId', pattern: 'CHANGE: ([a-z-]+)' }] })
    expect(f.requests[0]).toMatchObject({ prompt: '', nativeCommand: { id: 'opsx:ff', args: 'user $(literal)' }, access: 'write', instructions: 'none', artifacts: 'none' })
    expect(f.requests[0].openspec).toBeUndefined()
    expect(result).toMatchObject({ outcome: 'fail', vars: { changeId: 'feature-x' }, session: { sessionId: 'session-1' } })
    expect(f.invocations).toHaveLength(1)
    expect(f.invocations[0].usage.costUsd).toBeNull()
    expect(result.usage).toBeUndefined()
  })
  it('evaluates the last sentinel before bounding provider text', async () => {
    const f = fixture(() => ({ text: 'VERIFICATION: PASS\n' + 'x'.repeat(40_000) + '\nVERIFICATION: FAIL', usage: unknownUsage() }))
    const result = await f.run('prompt', { engine: { provider: 'fixture' }, text: 'check', access: 'read', sentinel: 'verification' })
    expect(result.outcome).toBe('fail')
    expect((result.output as { text: string }).text.length).toBeLessThanOrEqual(32_000)
  })
  it('fails verification without a sentinel and never invents a captured variable', async () => {
    const f = fixture()
    expect(await f.run('prompt', { engine: { provider: 'fixture' }, text: 'check', access: 'read', sentinel: 'verification', captureVars: [{ name: 'missing', pattern: '(absent)' }] })).toMatchObject({ outcome: 'fail', output: { reasons: ['missing_sentinel'] }, vars: {} })
  })
  it('memoizes before interrupt, then resumes with one additional invocation and the human answer', async () => {
    const f = fixture((_request, call) => ({ text: call === 1 ? 'LOOP_BLOCKED: Which module?' : 'Implemented requested module', usage: unknownUsage(), sessionId: 'session-1' }))
    const params = { engine: { provider: 'fixture' }, text: 'Implement', access: 'write', sentinel: 'blocked' } as const
    await expect(f.run('prompt', params)).rejects.toThrow('PAUSED')
    expect(f.invocations).toHaveLength(1)
    f.execution.interrupt = () => ({ answer: 'only billing' })
    const result = await f.run('prompt', params)
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].prompt).toContain('only billing')
    expect(f.requests[1].resumeSessionId).toBe('session-1')
    expect(f.invocations).toHaveLength(2)
    expect(result).toMatchObject({ outcome: 'next', answers: [{ value: { answer: 'only billing' } }] })
    await f.run('prompt', params)
    expect(f.requests).toHaveLength(2)
  })
  it('enforces budget before inference and settles provider errors once', async () => {
    const f = fixture(() => { throw new AgentExecutionError('missing session', 'provider_execution_error') })
    f.step.remainingBudget = () => ({ maxTokens: 0 })
    await expect(f.run('prompt', { engine: { provider: 'fixture' }, text: 'hello', access: 'read' })).rejects.toMatchObject({ code: 'budget_exhausted' })
    expect(f.requests).toHaveLength(0)
    f.step.remainingBudget = () => ({})
    await expect(f.run('prompt', { engine: { provider: 'fixture' }, text: 'hello', access: 'read' })).rejects.toMatchObject({ code: 'provider_execution_error' })
    expect(f.invocations).toHaveLength(1)
    expect(f.invocations[0]).toMatchObject({ status: 'failed', usage: unknownUsage() })
  })
  it('repairs structured custom output exactly once and isolates sessions by node', async () => {
    const f = fixture((_request, call) => ({ text: call === 1 ? '{"ok":"wrong"}' : '{"ok":true}', sessionId: 'session-1', usage: { inputTokens: 3, outputTokens: 1, costUsd: 0 } }))
    const params = { roleId: 'analyst', prompt: 'Inspect', structuredOutput: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } }
    expect(await f.run('role-turn', params)).toMatchObject({ outcome: 'next', output: { structured: { ok: true } } })
    expect(f.requests).toHaveLength(2)
    expect(f.requests[0]).toMatchObject({ role: 'analyst', access: 'read', artifacts: 'none', instructions: 'role' })
    expect(f.requests[0].prompt).toContain('Tests must pass')
    expect(f.invocations).toHaveLength(2)
    f.execution.frame.nodePath = 'sibling'
    await f.run('role-turn', params)
    expect(f.requests[2].resumeSessionId).toBeUndefined()
    expect(f.roleStates.size).toBe(2)
    expect(existsSync(path.join(pipelineStateDirectory(f.context), 'agent-workflow/role-execution.json'))).toBe(false)
  })
  it('returns invalid after the one bounded repair and rejects write deciders', async () => {
    const f = fixture(() => ({ text: '{"ok":"wrong"}', usage: unknownUsage() }))
    expect(await f.run('role-turn', { roleId: 'analyst', prompt: 'Inspect', structuredOutput: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } })).toMatchObject({ outcome: 'invalid', error: { code: 'invalid_role_output' } })
    expect(f.requests).toHaveLength(2)
    await expect(f.run('decider', { roleId: 'writer', goal: 'finish' })).rejects.toMatchObject({ code: 'invalid_role_access' })
  })
  it('stops unchanged continue decisions with an explicit unsuccessful no-progress reason', async () => {
    const f = fixture(() => ({ text: '{"verdict":"continue","reason":"Still missing tests"}', usage: unknownUsage() }))
    const first = await f.run('decider', { roleId: 'analyst', goal: 'finish', noProgress: 2 })
    expect(first.outcome).toBe('continue')
    f.execution.state.$outputs.node = first.output!
    const second = await f.run('decider', { roleId: 'analyst', goal: 'finish', noProgress: 2 })
    expect(second).toMatchObject({ outcome: 'stop', output: { stalled: true }, completion: { ok: false, reasons: ['no_progress'] } })
    expect(f.requests[0].prompt).toContain('not proof on its own')
    expect(f.requests[0].prompt).toContain('Tests must pass')
  })
})

describe('real commands and journal-independent verification', () => {
  it('runs structured argv, captures text and preserves literal metacharacters', async () => {
    const f = fixture()
    const result = await f.run('shell', { repositoryId: 'repo', argv: [process.execPath, '-e', 'console.log(process.argv[1]);console.log("VALUE: answer")', '$(literal); a b'], captureVars: [{ name: 'value', pattern: 'VALUE: ([a-z]+)' }] })
    expect(result).toMatchObject({ outcome: 'ok', output: { exitCode: 0, stdout: '$(literal); a b\nVALUE: answer\n' }, vars: { value: 'answer' } })
    expect(f.receipts).toHaveLength(0)
    expect(existsSync(path.join(pipelineStateDirectory(f.context), 'state.json'))).toBe(false)
    expect(shellCommand({ repositoryId: 'repo', commandLine: 'echo a & echo b' }, 'win32')).toMatchObject({ args: ['/d', '/s', '/c', 'echo a & echo b'] })
  })
  it('distinguishes nonzero checks from infrastructure failures and bounded shell output', async () => {
    const f = fixture()
    expect(await f.run('shell', { repositoryId: 'repo', argv: [process.execPath, '-e', 'process.exit(4)'] })).toMatchObject({ outcome: 'fail', output: { exitCode: 4 } })
    expect(await f.run('shell', { repositoryId: 'repo', argv: [process.execPath, '-e', 'setInterval(()=>{}, 1000)'], timeoutMs: 100 })).toMatchObject({ outcome: 'failed', error: { code: 'timeout' } })
    const result = await f.run('shell', { repositoryId: 'repo', argv: [process.execPath, '-e', 'process.stdout.write("🙂".repeat(1000))'], outputCapBytes: 129 })
    const output = result.output as { stdout: string; outputTruncated: boolean }
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(129)
    expect(output.stdout).not.toContain('\ufffd')
    expect(output.outputTruncated).toBe(true)
    await expect(f.run('shell', { repositoryId: 'repo', cwd: '..', argv: [process.execPath, '-e', '0'] })).rejects.toThrow('escapes')
  })
  it('records start and completion evidence without a journal and binds a real receipt', async () => {
    const f = fixture()
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("checked")'] }]
    const result = await f.run('verify', { commands: 'configured' })
    expect(result).toMatchObject({ outcome: 'pass', receipt: { valid: true, scope: 'full' }, verified: { receiptId: f.receipts[0].id } })
    expect(f.evidence).toHaveLength(2)
    expect(f.evidence[0].pending).toBe(true)
    expect(f.evidence[1].stdout).toBe('checked\n')
    expect(f.evidence[1].environmentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(path.join(pipelineStateDirectory(f.context), 'state.json'))).toBe(false)
  })
  it('does not accept a changed candidate or mark explicit no-check exceptions verified', async () => {
    const f = fixture()
    const changed = await f.run('verify', { commands: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'require("fs").writeFileSync("input.txt","changed")'] }] })
    expect(changed).toMatchObject({ outcome: 'fail', verified: null, receipt: { valid: false } })
    expect(await f.run('verify', { commands: [], unverified: true })).toMatchObject({ outcome: 'pass', verified: null, receipt: { evidence: { unverifiedRepositories: ['repo'] } } })
  })
  it('shell evidence remains evidence without installing the verified channel', async () => {
    const f = fixture()
    const result = await f.run('shell', { repositoryId: 'repo', argv: [process.execPath, '-e', 'console.log("checked")'], evidence: true })
    expect(result).toMatchObject({ outcome: 'ok', receipt: { valid: true, scope: 'scoped' }, output: { stdout: 'checked\n' } })
    expect(result.verified).toBeUndefined()
  })
})


describe('project memory integration', () => {
  it('uses bounded review notes with exact candidate/role identity, without reviving provider sessions or extra turns', async () => {
    const f = fixture(() => ({ text: 'Review input.txt boundary behavior.', usage: unknownUsage(), sessionId: 'session-one' }))
    const memory = await SqliteProjectStore.open(f.root)
    f.scope.runtimeExclusions.push(...['', '-wal', '-shm'].map(suffix => memory.filename + suffix))
    f.deps.memory = () => memory.forAccess('write')
    try {
      await f.run('role-turn', { roleId: 'analyst', prompt: 'Review current candidate' })
      expect((await memory.search(['roles', 'analyst', 'sessions']))[0].value).toMatchObject({ roleId: 'analyst', sessionId: 'session-one' })
      expect(await memory.search(['review', 'notes'])).toHaveLength(1)
      f.roleStates.clear()
      await f.run('role-turn', { roleId: 'analyst', prompt: 'Review current candidate' })
      expect(f.requests).toHaveLength(2)
      expect(f.requests[1].prompt).toContain('Prior project review note')
      expect(f.requests[1].resumeSessionId).toBeUndefined()
      writeFileSync(path.join(f.root, 'input.txt'), 'a genuinely different candidate')
      f.roleStates.clear()
      await f.run('role-turn', { roleId: 'analyst', prompt: 'Review new candidate' })
      expect(f.requests[2].prompt).not.toContain('Prior project review note')
      expect(f.invocations).toHaveLength(3)
    } finally { memory.close() }
  })

  it('records known command observations while physically running fresh verification each time', async () => {
    const f = fixture(), memory = await SqliteProjectStore.open(f.root)
    f.scope.runtimeExclusions.push(...['', '-wal', '-shm'].map(suffix => memory.filename + suffix))
    f.deps.memory = () => memory.forAccess('write')
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("physical check")'] }]
    try {
      await f.run('verify', { commands: 'configured' })
      await f.run('verify', { commands: 'configured' })
      expect(f.evidence.filter(item => !item.pending)).toHaveLength(2)
      expect(f.receipts).toHaveLength(2)
      expect((await memory.search(['verification', 'known-commands']))[0].value).toMatchObject({ observations: 2, lastValid: true })
      expect(f.requests).toHaveLength(0)
    } finally { memory.close() }
  })

  it('never turns advisory store failure after a provider response into a paid retry', async () => {
    const f = fixture()
    expect(await f.run('role-turn', { roleId: 'analyst', prompt: 'Review once' })).toMatchObject({ outcome: 'next' })
    expect(f.requests).toHaveLength(1)
    expect(f.invocations).toHaveLength(1)
    expect(f.execution.progress).toHaveBeenCalledWith(expect.objectContaining({ type: 'span', payload: expect.objectContaining({ name: 'project-memory', status: 'unavailable' }) }))
  })
})
