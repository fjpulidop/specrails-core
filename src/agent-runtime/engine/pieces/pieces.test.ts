import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { rolePromptDefaults } from '../../prompts.js'

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
    expect(f.pieces.catalog()).toHaveLength(19)
    expect(f.pieces.validateParams('prompt', { engine: { provider: 'fixture' }, text: 'hi', nativeCommand: { id: 'opsx:ff' }, access: 'write' }, '')).not.toEqual([])
    expect(f.pieces.validateParams('shell', { repositoryId: 'repo', argv: ['node'], commandLine: 'node' }, '')).not.toEqual([])
    expect(f.pieces.outcomes('prompt', { sentinel: 'verification' })).toEqual(['pass', 'fail', 'failed'])
    expect(f.pieces.outcomes('role-turn', {})).toEqual(['next', 'failed'])
    expect(f.pieces.validateParams('prompt', { engine: { provider: 'fixture' }, text: 'hi', access: 'read', captureVars: [{ name: 'constructor', pattern: '(x)' }] }, '')).not.toEqual([])
  })
  it('copies a committed host blocker into the completion when an end names its source node', async () => {
    const f = fixture()
    const blocker = { kind: 'network', reason: 'the Playwright browser download cannot reach its CDN from the verification environment', command: 'npx', args: ['playwright', 'install', 'chromium'], cwd: '.', requiredAction: 'Run `npx playwright install chromium` in . with network access, then retry the run.', evidenceId: 'ev-1' }
    f.execution.state.$outputs.verify = { valid: false, blocker }
    expect(await f.run('end', { outcome: 'failure', reason: 'host blocked', blockerFrom: 'verify' })).toMatchObject({ outcome: 'failure', completion: { ok: false, reasons: ['host blocked'], blocker } })
    // A correction role reports the same shape under its structured JSON, with free-text evidence instead of a host reason.
    f.execution.state.$outputs.correct = { structured: { summary: 'left unchanged on purpose', blocker: { kind: 'toolchain', command: 'npx', cwd: '.', evidence: 'Executable does not exist', requiredAction: 'Install the browser.' } } }
    expect(await f.run('end', { outcome: 'failure', blockerFrom: 'correct' })).toMatchObject({ completion: { blocker: { kind: 'toolchain', reason: 'Executable does not exist', args: [], requiredAction: 'Install the browser.' } } })
    expect((await f.run('end', { outcome: 'failure', blockerFrom: 'missing' })).completion).not.toHaveProperty('blocker')
    expect(f.pieces.validateParams('end', { outcome: 'failure', blockerFrom: 'Not An Id' }, '')).not.toEqual([])
  })
  it('interrupts before any question side effects and retains the answered value', async () => {
    const f = fixture()
    await expect(f.run('question', { text: 'Choose a scope' })).rejects.toThrow('PAUSED')
    expect(f.requests).toEqual([])
    f.execution.interrupt = request => { expect(request).toMatchObject({ scopeId: 'root', attemptId: 'attempt', kind: 'question' }); return { answer: 'only app' } }
    expect(await f.run('question', { text: 'Choose a scope' })).toMatchObject({ outcome: 'next', answers: [{ value: { answer: 'only app' }, nodePath: 'node' }] })
  })
  it('binds approval to the pre-interrupt candidate across a changed workspace', async () => {
    const f = fixture(), before = f.deps.executionSnapshot(f.execution).candidate!.hash
    await expect(f.run('approval', { reason: 'Archive?', bindCandidate: true })).rejects.toThrow('PAUSED')
    writeFileSync(path.join(f.root, 'input.txt'), 'changed after approval request')
    f.execution.interrupt = () => ({ approved: true })
    expect(await f.run('approval', { reason: 'Archive?', bindCandidate: true })).toMatchObject({ output: { candidateHash: before, response: { approved: true } } })
    expect(f.deps.executionSnapshot(f.execution).candidate!.hash).not.toBe(before)
  })
  it('keeps host checks mandatory when an agent proposes alternative commands', async () => {
    const f = fixture()
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.error("actual host failure"); process.exit(9)'] }]
    f.execution.state.$outputs.plan = { structured: { verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'process.exit(0)'] }] } }
    expect(await f.run('verify', { commands: 'configured', additionalCommandsFrom: 'plan' })).toMatchObject({ outcome: 'fail',
      output: { commands: [{ cwd: expect.stringContaining(path.basename(f.root)), exitCode: 9, output: expect.stringContaining('actual host failure'), args: ['-e', 'console.error("actual host failure"); process.exit(9)'] }] } })
    expect(f.receipts.at(-1)?.commands).toHaveLength(1)
    expect(f.receipts.at(-1)?.commands[0].exitCode).toBe(9)
    f.execution.state.$outputs.plan = { structured: { verification: [{ repositoryId: 'outside', command: process.execPath, args: [] }] } }
    await expect(f.run('verify', { commands: 'configured', additionalCommandsFrom: 'plan' })).rejects.toThrow('Unknown verification repository')
  })
  it('adds a proposed run of a script the configured repository declares, and nothing else', async () => {
    const f = fixture()
    writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'node -e "console.log(\'browser suite ran\')"' } }))
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'process.exit(0)'] }]
    f.execution.state.$outputs.plan = { structured: { verification: [
      { repositoryId: 'repo', command: 'npm', args: ['run', 'test:e2e'] },
      // Not declared, not a package script, or a duplicate: the configured plan stays authoritative.
      { repositoryId: 'repo', command: 'npm', args: ['run', 'missing'] },
      { repositoryId: 'repo', command: 'npx', args: ['playwright', 'test'] },
      { repositoryId: 'repo', command: 'npm', args: ['run', 'test:e2e', '--', '--grep', 'x'] },
      { repositoryId: 'repo', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ] } }
    const result = await f.run('verify', { commands: 'configured', additionalCommandsFrom: 'plan' })
    expect(result).toMatchObject({ outcome: 'pass', receipt: { valid: true } })
    expect(f.receipts.at(-1)!.commands.map(command => [command.command, ...command.args].join(' '))).toEqual([`${process.execPath} -e process.exit(0)`, 'npm run test:e2e'])
    expect(f.receipts.at(-1)!.commands[1].output).toContain('browser suite ran')
  }, 60_000)
  it('executes proposed verification for an uncovered repository through the real host checker', async () => {
    const f = fixture()
    f.execution.state.$outputs.plan = { structured: { verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("actual verification")'] }] } }
    expect(await f.run('verify', { commands: 'configured', additionalCommandsFrom: 'plan' })).toMatchObject({ outcome: 'pass', receipt: { valid: true, scope: 'full' } })
    expect(f.receipts.at(-1)?.commands[0].exitCode).toBe(0)
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
  it.each(['LOOP_BLOCKED: Which repository?', '{"verdict":"blocked","reason":"Which repository?"}'])('retains a blocked decider response across its human pause: %s', async response => {
    const f = fixture(() => ({ text: response, usage: unknownUsage() }))
    const params = { roleId: 'analyst', goal: 'Complete the selected scope' }
    await expect(f.run('decider', params)).rejects.toThrow('PAUSED')
    expect(f.requests).toHaveLength(1)
    expect(f.invocations).toHaveLength(1)
    f.execution.interrupt = request => {
      expect(request).toMatchObject({ kind: 'question', prompt: 'Which repository?', attemptId: 'attempt' })
      return { answer: 'Billing repository only' }
    }
    const resumed = await f.run('decider', params)
    expect(resumed).toMatchObject({ outcome: 'continue', answers: [{ value: { answer: 'Billing repository only' } }] })
    expect(JSON.stringify(resumed.history)).toContain('Billing repository only')
    expect(f.requests).toHaveLength(1)
    expect(f.invocations).toHaveLength(1)
  })

  it('pauses a blocked verification turn before accepting its success sentinel', async () => {
    const f = fixture((_request, call) => ({ text: call === 1 ? 'VERIFICATION: PASS\nLOOP_BLOCKED: Which scope?' : 'VERIFICATION: PASS', usage: unknownUsage() }))
    const params = { engine: { provider: 'fixture' }, text: 'Verify the selected scope', access: 'read', sentinel: 'verification' }
    await expect(f.run('prompt', params)).rejects.toThrow('PAUSED')
    expect(f.requests).toHaveLength(1)
    f.execution.interrupt = request => { expect(request).toMatchObject({ kind: 'question', prompt: 'Which scope?' }); return 'Billing only' }
    const resumed = await f.run('prompt', params)
    expect(resumed).toMatchObject({ outcome: 'pass', answers: [{ value: 'Billing only' }] })
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].prompt).toContain('Billing only')
  })

  it('preserves previous no-progress evidence while a decider waits for a human', async () => {
    const f = fixture(() => ({ text: 'LOOP_BLOCKED: Confirm scope?', usage: unknownUsage() }))
    f.execution.state.$outputs.node = { verdict: 'continue', candidateHash: 'previous-candidate', continueCount: 2 }
    f.execution.interrupt = () => 'Proceed'
    expect(await f.run('decider', { roleId: 'analyst', goal: 'Inspect', noProgress: 2, continueWhen: 'true' })).toMatchObject({
      outcome: 'continue', output: { candidateHash: 'previous-candidate', continueCount: 2, blocked: true },
    })
  })

  it.each(['role-turn', 'decider'])('preserves %s timer overrides through structured-response repair', async kind => {
    const f = fixture((_request, call) => ({ text: call === 1 ? 'malformed' : '{"verdict":"stop","reason":"evidence verified"}', usage: unknownUsage() }))
    f.deps.config.limits = { timeoutMs: 1000, idleTimeoutMs: 2000 }
    const params: Record<string, JsonValue> = kind === 'decider' ? { roleId: 'analyst', goal: 'Inspect' } : { roleId: 'analyst', prompt: 'Inspect', structuredOutput: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } }
    expect(await f.run(kind, { ...params, timeoutMs: 180_000, idleTimeoutMs: 0 })).toMatchObject({ outcome: kind === 'decider' ? 'stop' : 'next' })
    expect(f.requests).toHaveLength(2)
    for (const request of f.requests) expect(request).toMatchObject({ timeoutMs: 180_000, idleTimeoutMs: 0, access: 'read' })
    expect(f.deps.config.limits).toEqual({ timeoutMs: 1000, idleTimeoutMs: 2000 })
  })

  it('freezes explicit zero timers instead of inheriting invocation limits', async () => {
    const f = fixture()
    f.deps.config.limits = { timeoutMs: 1000, idleTimeoutMs: 1000 }
    await f.run('prompt', { engine: { provider: 'fixture' }, text: 'inspect', access: 'read', timeoutMs: 0, idleTimeoutMs: 0 })
    expect(f.requests[0]).toMatchObject({ timeoutMs: 0, idleTimeoutMs: 0 })
    expect(f.pieces.validateParams('prompt', { engine: { provider: 'fixture' }, text: 'inspect', access: 'read', timeoutMs: -1 }, '')).not.toEqual([])
  })

  it('keeps an early failed test in bounded diagnostics after hundreds of passing tests', async () => {
    const f = fixture()
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("not ok 1 - save conflict\\n  ---\\n  error: expected canonical code\\n  ...");for(let i=2;i<650;i++)console.log("ok "+i+" - passing test\\n  ---\\n  duration_ms: 0.134292\\n  type: test\\n  ...");console.log("# tests 649\\n# pass 648\\n# fail 1");process.exitCode=1'] }]
    const result = await f.run('verify', { commands: 'configured' })
    expect(result.outcome).toBe('fail')
    const diagnostic = (result.output as { commands: Array<{ output: string }> }).commands[0].output
    expect(diagnostic).toContain('not ok 1 - save conflict')
    expect(diagnostic).toContain('expected canonical code')
    expect(diagnostic).toContain('# fail 1')
    expect(diagnostic.length).toBeLessThanOrEqual(8_000)
    expect(f.evidence.at(-1)!.stdout).toContain('ok 649 - passing test')
  })

  it('retains an early Node spec failure when the output tail contains only passing cases', async () => {
    const f = fixture()
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("✖ cancelling the confirmation\\ntest at lib/reconcileProdGuard.test.ts:52\\nAssertionError: expected Escape guard");process.stdout.write("✔ passing case\\n".repeat(4000));console.log("ℹ fail 1");process.exitCode=1'] }]
    const result = await f.run('verify', { commands: 'configured' })
    const output = (result.output as { commands: Array<{ output: string }> }).commands[0].output
    expect(output).toContain('✖ cancelling the confirmation')
    expect(output).toContain('reconcileProdGuard.test.ts:52')
    expect(output).toContain('expected Escape guard')
    expect(output.length).toBeLessThanOrEqual(8_000)
  })

  it('hands a real formatting assertion failure to the correction role and still rejects a missing safety guard', async () => {
    const f = fixture(request => {
      expect(request.prompt).toContain('failureSummary')
      expect(request.prompt).toContain('evidenceId')
      expect(request.prompt).toContain('guard.test.cjs')
      expect(request.prompt).toContain('ERR_ASSERTION')
      expect(request.prompt).toContain('expected:')
      expect(request.prompt).toContain('An unchanged file or a pre-existing test does not prove')
      const file = path.join(f.root, 'guard.test.cjs')
      writeFileSync(file, readFileSync(file, 'utf8').replace('&& !confirmPending/', '&&\\s*!confirmPending/'))
      return { text: 'Repaired whitespace tolerance while preserving the required safety guard.', usage: unknownUsage() }
    })
    writeFileSync(path.join(f.root, 'modal.txt'), "e.key === 'Escape' &&\n!confirmPending")
    writeFileSync(path.join(f.root, 'guard.test.cjs'), `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\ntest('cancelling confirmation preserves the queue', () => assert.match(fs.readFileSync('modal.txt', 'utf8'), /e\\.key === 'Escape' && !confirmPending/));\n`)
    f.deps.config.roles!.writer!.prompt = rolePromptDefaults().fixer
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['--test', '--test-reporter=spec', 'guard.test.cjs'] }]
    const failed = await f.run('verify', { commands: 'configured' })
    expect(failed.outcome).toBe('fail')
    const command = (failed.output as { commands: Array<{ evidenceId: string; failureSummary: string[] }> }).commands[0]
    expect(command.evidenceId).toBe(f.evidence[0].evidenceId)
    expect(command.failureSummary.join('\n')).toContain('guard.test.cjs:4')
    expect(command.failureSummary.join('\n')).toContain('expected:')
    await f.run('role-turn', { roleId: 'writer', prompt: 'Host verification: ' + JSON.stringify(failed.output) })
    expect(await f.run('verify', { commands: 'configured' })).toMatchObject({ outcome: 'pass', receipt: { valid: true } })
    writeFileSync(path.join(f.root, 'modal.txt'), "e.key === 'Escape' &&\ntrue")
    expect(await f.run('verify', { commands: 'configured' })).toMatchObject({ outcome: 'fail', receipt: { valid: false } })
  })

  it('keeps expected assertions and application locations separate from huge source dumps', async () => {
    const f = fixture()
    const source = ['✖ confirmation stays open ' + 'title '.repeat(100), '✖ second failure ' + 'title '.repeat(100), '✖ third failure ' + 'title '.repeat(100), 'AssertionError [ERR_ASSERTION]: missing required guard ' + 'detail '.repeat(100), 'TypeError: another failure ' + 'detail '.repeat(100), "actual: '" + 'source '.repeat(6000) + "'", "expected: /Escape.*!confirmPending/", 'at TestContext.<anonymous> (/repo/guard.test.ts:52:10)', 'at Test.run (node:internal/test_runner/test:1:2)'].join('\n')
    // Keep the dump out of argv (Windows limits it to ~32 KB), and let Node
    // drain stderr before exiting so pipe output is complete on every platform.
    writeFileSync(path.join(f.root, 'failure.cjs'), 'console.error(' + JSON.stringify(source) + ');process.exitCode=1')
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['failure.cjs'] }]
    const result = await f.run('verify', { commands: 'configured' })
    const summary = (result.output as { commands: Array<{ failureSummary: string[] }> }).commands[0].failureSummary.join('\n')
    expect(summary).toContain('✖ confirmation stays open')
    expect(summary).toContain('ERR_ASSERTION')
    expect(summary).toContain('expected: /Escape.*!confirmPending/')
    expect(summary).toContain('/repo/guard.test.ts:52:10')
    expect(summary).not.toContain('source source')
    expect(summary).not.toContain('node:internal/')
    expect(summary.length).toBeLessThanOrEqual(3_000)
    expect(f.evidence.at(-1)!.stderr).toContain('source source')
  })

  it('keeps compiler failures in summaries and excerpts when lint noise surrounds them', async () => {
    const f = fixture()
    const errors = [
      "src/service.ts(137,36): error TS2551: Property 'NEW_ENDPOINT' does not exist",
      'src/other.ts:207:40 - error TS2339: Property is missing',
      'error TS18003: No inputs were found in the config file',
    ]
    const warning = '✖ 74 problems (0 errors, 74 warnings)'
    const noise = Array.from({ length: 100 }, (_, i) => `${i}:1 warning ${'lint advice '.repeat(20)}`).join('\n')
    const context = 'Checking project: config/tsconfig.json'
    const output = [warning, noise, context, '', ...errors, noise, warning].join('\n')
    writeFileSync(path.join(f.root, 'compiler.cjs'), 'console.log(' + JSON.stringify(output) + ');process.exitCode=2')
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['compiler.cjs'] }]
    const result = await f.run('verify', { commands: 'configured' })
    expect(result).toMatchObject({ outcome: 'fail', receipt: { valid: false } })
    const command = (result.output as { commands: Array<{ exitCode: number; output: string; failureSummary: string[]; truncated: boolean }> }).commands[0]
    expect(command.exitCode).toBe(2)
    expect(command.failureSummary).toEqual(errors)
    expect(command.output.startsWith(errors[0])).toBe(true)
    for (const error of errors) expect(command.output).toContain(error)
    expect(command.output).toContain(context)
    expect(command.output.length).toBeLessThanOrEqual(8_000)
    expect(command.truncated).toBe(true)
    expect(f.evidence.at(-1)!.stdout).toContain(warning)
    expect(f.evidence.at(-1)!.stdout).toContain(errors[0])
  })

  it('stops three failed checks on an unchanged candidate and resets after an edit', async () => {
    const f = fixture()
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("not ok 1 - still broken");process.exit(1)'] }]
    for (let i = 1; i <= 3; i++) {
      const result = await f.run('verify', { commands: 'configured' })
      expect(result.outcome).toBe(i === 3 ? 'failed' : 'fail')
      expect(result.output).toMatchObject({ noProgressCount: i })
      if (i === 3) expect(result.error).toMatchObject({ code: 'verification_no_progress' })
      Object.assign(f.execution.state.$vars, result.vars)
    }
    writeFileSync(path.join(f.root, 'input.txt'), 'a real correction')
    expect(await f.run('verify', { commands: 'configured' })).toMatchObject({ outcome: 'fail', output: { noProgressCount: 1 } })
  })

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
  describe('host environment for writer turns', () => {
    /** A repository whose local Playwright CLI is a fake: dry-run names `cache/chromium-1`, install creates it. */
    function withPlaywright(f: ReturnType<typeof fixture>) {
      writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '^1.0.0' } }))
      mkdirSync(path.join(f.root, 'node_modules/.bin'), { recursive: true })
      mkdirSync(path.join(f.root, 'node_modules/@playwright/test'), { recursive: true })
      const browser = path.join(f.root, 'cache/chromium-1')
      const cli = path.join(f.root, 'node_modules/.bin/playwright')
      writeFileSync(cli, `#!/usr/bin/env node\nconst args = process.argv.slice(2)\nif (args.includes('--dry-run')) console.log('  Install location:    ' + ${JSON.stringify(browser)})\nelse if (args[0] === 'install') require('node:fs').mkdirSync(${JSON.stringify(browser)}, { recursive: true })\n`)
      chmodSync(cli, 0o755)
      return browser
    }
    const blockerSchema = { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' }, blocker: { type: 'object' } } }

    it.skipIf(process.platform === 'win32')('installs a missing browser build before the turn and tells the agent', async () => {
      const f = fixture()
      const browser = withPlaywright(f)
      await f.run('role-turn', { roleId: 'writer', prompt: 'Implement the selector' })
      expect(existsSync(browser)).toBe(true)
      expect(f.requests[0].prompt).toContain('## Host environment')
      expect(f.requests[0].prompt).toContain('The host installed Playwright chromium for this workspace before this turn.')
      expect(vi.mocked(f.execution.progress).mock.calls.map(([event]) => (event.payload as { text: string }).text)).toContain('Environment: installed Playwright chromium in ' + path.basename(f.root))
      // Ready environments add nothing; read-only roles never prepare.
      await f.run('role-turn', { roleId: 'writer', prompt: 'Next task' })
      expect(f.requests[1].prompt).not.toContain('## Host environment')
      rmSync(browser, { recursive: true })
      await f.run('role-turn', { roleId: 'analyst', prompt: 'Inspect' })
      expect(existsSync(browser)).toBe(false)
    }, 30_000)

    it.skipIf(process.platform === 'win32')('repairs an environment blocker the agent reports and reruns the turn once', async () => {
      let browser = ''
      const f = fixture((_request, call) => {
        // The first turn loses the browser (e.g. a cache cleanup) and reports it; the rerun finishes.
        if (call === 1) { rmSync(browser, { recursive: true, force: true }); return { text: JSON.stringify({ summary: 'blocked', blocker: { kind: 'toolchain', evidence: 'chromium executable missing', requiredAction: 'Install Chromium' } }), usage: unknownUsage() } }
        return { text: JSON.stringify({ summary: 'done' }), usage: unknownUsage() }
      })
      browser = withPlaywright(f)
      mkdirSync(browser, { recursive: true })
      const result = await f.run('role-turn', { roleId: 'writer', prompt: 'Implement', structuredOutput: blockerSchema })
      expect(result).toMatchObject({ outcome: 'next', output: { structured: { summary: 'done' } } })
      expect(f.requests).toHaveLength(2)
      expect(existsSync(browser)).toBe(true)
      expect(f.requests[1].prompt).toContain('Your previous turn reported an environment blocker. The host installed Playwright chromium for this workspace: continue the remaining work')
    }, 30_000)

    it.skipIf(process.platform === 'win32')('keeps a blocker the host cannot repair, and never reruns more than once', async () => {
      const f = fixture(() => ({ text: JSON.stringify({ summary: 'blocked', blocker: { kind: 'credential', requiredAction: 'Log in to the registry' } }), usage: unknownUsage() }))
      withPlaywright(f)
      const result = await f.run('role-turn', { roleId: 'writer', prompt: 'Implement', structuredOutput: blockerSchema })
      expect(result).toMatchObject({ output: { structured: { blocker: { kind: 'credential' } } } })
      expect(f.requests).toHaveLength(1)
      const toolchain = fixture(() => ({ text: JSON.stringify({ summary: 'blocked', blocker: { kind: 'toolchain', requiredAction: 'Install Chromium' } }), usage: unknownUsage() }))
      const browser = withPlaywright(toolchain)
      mkdirSync(browser, { recursive: true })
      // Nothing to install: the blocker stands after the single turn.
      expect(await toolchain.run('role-turn', { roleId: 'writer', prompt: 'Implement', structuredOutput: blockerSchema })).toMatchObject({ output: { structured: { blocker: { kind: 'toolchain' } } } })
      expect(toolchain.requests).toHaveLength(1)
    }, 30_000)
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
    expect(second).toMatchObject({ outcome: 'failed', status: 'failed', output: { verdict: 'continue', stalled: true }, completion: { ok: false, reasons: ['no_progress'] } })
    expect(f.requests[0].prompt).toContain('not proof on its own')
    expect(f.requests[0].prompt).toContain('Tests must pass')
  })
  it('keeps required work ahead of a stop proposal and retains no-progress accounting', async () => {
    const f = fixture(() => ({ text: '{"verdict":"stop","reason":"Model claims completion"}', usage: unknownUsage() }))
    f.execution.state.$vars.failedPass = true
    const params = { roleId: 'analyst', goal: 'finish', continueWhen: '$vars.failedPass == true', noProgress: 2 }
    const first = await f.run('decider', params)
    expect(first).toMatchObject({ outcome: 'continue', output: { verdict: 'continue', proposedVerdict: 'stop', requiredContinue: true, continueCount: 1 } })
    f.execution.state.$outputs.node = first.output!
    expect(await f.run('decider', params)).toMatchObject({ outcome: 'failed', output: { continueCount: 2, stalled: true }, completion: { ok: false, reasons: ['no_progress'] } })
    expect(f.requests).toHaveLength(2)
    f.execution.state.$vars.failedPass = false
    expect(await f.run('decider', params)).toMatchObject({ outcome: 'stop', output: { verdict: 'stop', continueCount: 0 } })
    expect(f.requests).toHaveLength(3)
  })
  it('rejects an unsafe decision guard before a physical provider invocation', async () => {
    const f = fixture()
    await expect(f.run('decider', { roleId: 'analyst', goal: 'finish', continueWhen: 'process.exit()' })).rejects.toMatchObject({ code: 'invalid_expression' })
    expect(f.requests).toHaveLength(0)
  })
})

describe('real commands and journal-independent verification', () => {
  it.each(['openspec-validate', 'openspec-archive'])('rejects a mismatched artifact repository before %s can inspect or change files', async kind => {
    const f = fixture()
    await expect(f.run(kind, { change: 'valid-change', repositoryId: 'other', allowArchived: true })).rejects.toMatchObject({ code: 'artifact_scope_mismatch' })
    expect(f.requests).toHaveLength(0)
  })
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
