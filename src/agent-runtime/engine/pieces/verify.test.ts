import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { candidateManifest, fingerprintCandidate, pipelineStateDirectory, validatePipelineContext, type CommandReceipt, type VerificationReceipt } from '../../../pipeline/pipeline-state.js'
import { unknownUsage, type AgentRequest, type RuntimeConfig } from '../../executor-types.js'
import type { ProviderInvocation } from '../../efficiency-types.js'
import { ExecutorRegistry } from '../../executors.js'
import type { WorkflowStepContext } from '../../workflow-types.js'
import type { JsonValue, PieceExecutionContext, PieceResult } from '../contracts.js'
import { validateWorkflowDefinition } from '../definition-validator.js'
import { initialDefinitionState } from '../state.js'
import { createPieceRegistry, validationPieceRegistry } from './index.js'
import type { PieceDependencies } from './ports.js'
import { deriveImplementationBinding } from './implementation-binding.js'

// Host installs go through cross-spawn (environment.ts); verification commands
// do not. The fake answers only the install commands a test registers and
// leaves every other spawn to the real implementation.
type SpawnResult = { status: number; stdout: string; stderr: string }
const installs = vi.hoisted(() => ({ handler: undefined as ((command: string, args: string[], options: { cwd: string; timeout: number }) => SpawnResult | undefined) | undefined, calls: [] as string[][] }))
vi.mock('cross-spawn', async importOriginal => {
  const actual = await importOriginal<{ default: typeof import('cross-spawn') }>()
  const sync = (command: string, args: string[], options: { cwd: string; timeout: number }) => {
    installs.calls.push([command, ...args])
    const faked = installs.handler?.(command, args, options)
    return faked ? { ...faked, pid: 1, output: [], signal: null } : actual.default.sync(command, args, options)
  }
  return { default: Object.assign((...parameters: Parameters<typeof actual.default>) => actual.default(...parameters), { sync, spawn: actual.default.spawn }) }
})

const roots: string[] = []
afterEach(() => { installs.handler = undefined; installs.calls.length = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const MISSING_BROWSER = "Error: browserType.launch: Executable doesn't exist at /Users/dev/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-mac-arm64/headless_shell\nLooks like Playwright Test or Playwright was just installed or updated."
const OFFLINE_DOWNLOAD = 'Downloading Chromium 131.0.6778.33 (playwright build v1148) from https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1148/chromium-mac-arm64.zip\nFailed to download Chromium 131.0.6778.33 (playwright build v1148), caused by\nError: getaddrinfo ENOTFOUND cdn.playwright.dev'
const REGISTRY_401 = 'npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/@acme%2fui'

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'engine-verify-'))); roots.push(root)
  execFileSync('git', ['init', '-q', root])
  writeFileSync(path.join(root, 'input.txt'), 'candidate')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'verify', backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: root }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Required feature', description: 'Preserve all behavior', acceptanceCriteria: ['Tests must pass'] }] })
  const role = { provider: 'fixture', model: 'base' }
  const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [] }
  const requests: AgentRequest[] = [], invocations: ProviderInvocation[] = [], evidence: CommandReceipt[] = [], receipts: VerificationReceipt[] = []
  const notes = new Map<string, JsonValue>()
  const registry = new ExecutorRegistry().register('fixture', { async execute(request) { requests.push(request); return { text: 'done', usage: unknownUsage() } } })
  const state = initialDefinitionState()
  const progress = vi.fn()
  const execution: PieceExecutionContext = { state, frame: { runId: 'verify', nodePath: 'verify', scope: state.$scope, task: { checkpointThreadId: 'verify', checkpointId: 'cp', taskCheckpointNs: '', taskId: 'task' },
    visitId: 'visit', visit: 1, transition: 1, attemptId: 'attempt', attempt: 1, leaseEpoch: 1 }, signal: new AbortController().signal, progress, interrupt: () => { throw new Error('PAUSED') } }
  const scope = { context, scopeHash: 'scope', artifactExclusions: [], runtimeExclusions: [] as string[] }
  const candidate = () => ({ hash: fingerprintCandidate(scope), atTransition: execution.frame.transition, revision: execution.frame.transition })
  const step = { runId: 'verify', stepId: 'verify', attemptId: 'attempt', attempt: 1, input: null, checkpoint: { history: [], events: [], steps: {} }, signal: execution.signal, remainingBudget: () => ({}), reportUsage: vi.fn(),
    reportInvocationStarted: async () => ({ invocationId: 'invocation-1', ordinal: 1 }), reportInvocation: async (invocation: ProviderInvocation) => { invocations.push(invocation) } } as unknown as WorkflowStepContext
  const deps: PieceDependencies = { context, config, registry, stepContext: () => step,
    roleState: () => ({ read: () => ({ sessions: {}, routes: {} }), write: () => {} }),
    memory: () => { throw new Error('Fixture project memory is not enabled') },
    memo: ctx => ({ get: key => notes.get(ctx.frame.attemptId + ':' + key), set: (key, value) => { notes.set(ctx.frame.attemptId + ':' + key, structuredClone(value)) } }),
    settleResult: (ctx, key, value, invocation) => { invocations.push(invocation); notes.set(ctx.frame.attemptId + ':' + key, structuredClone(value)) },
    executionSnapshot: () => ({ candidate: candidate(), verified: execution.state.$verified }), artifactDirectory: () => path.join(pipelineStateDirectory(context), 'node-artifacts'),
    bindImplementation: (execution, change) => deriveImplementationBinding(context, execution, change),
    verification: () => { const hash = candidate().hash; return { candidateHash: hash, candidateManifest: candidateManifest(scope), currentManifest: () => candidateManifest(scope), scopeHash: 'scope', isCurrent: () => candidate().hash === hash,
      persistCheck: value => { evidence.push(structuredClone(value)) }, commitReceipt: value => { receipts.push(structuredClone(value)); return value } } },
  }
  const pieces = createPieceRegistry(deps)
  const run = async (params: Record<string, JsonValue>): Promise<PieceResult> => {
    expect(pieces.validateParams('verify', params, '/test')).toEqual([])
    return pieces.get('verify').execute(params, execution)
  }
  /** A check whose output is fixed text and exit code, written to a file so argv stays small on every platform. */
  const check = (name: string, text: string, exitCode: number) => {
    writeFileSync(path.join(root, name), `process.stderr.write(${JSON.stringify(text)});process.exitCode=${exitCode}`)
    return { repositoryId: 'repo', command: process.execPath, args: [name] }
  }
  const progressText = () => progress.mock.calls.map(([event]) => (event as { type: string; payload: { text?: string } }).type === 'verification-output' ? (event as { payload: { text: string } }).payload.text : '').filter(Boolean)
  return { root, context, deps, run, check, receipts, evidence, execution, progressText }
}

/** A Playwright-dependent repository whose e2e check passes only once the browser marker exists outside the checkout. */
function playwrightRepository(f: ReturnType<typeof fixture>) {
  const cache = mkdtempSync(path.join(tmpdir(), 'ms-playwright-')); roots.push(cache)
  const marker = path.join(cache, 'chromium_headless_shell-1243')
  writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '^1.48' } }))
  mkdirSync(path.join(f.root, 'node_modules', '@playwright', 'test'), { recursive: true })
  writeFileSync(path.join(f.root, 'e2e.cjs'), `if(!require('fs').existsSync(${JSON.stringify(marker)})){process.stderr.write(${JSON.stringify(MISSING_BROWSER)});process.exitCode=1}else console.log('1 passed')`)
  f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['e2e.cjs'] }]
  return { marker }
}

describe('engine v2 environment repair', () => {
  it('repairs a missing Playwright browser on the host, narrates the install and lets the second receipt decide', async () => {
    const f = fixture()
    const { marker } = playwrightRepository(f)
    installs.handler = (command, args, options) => {
      expect([command, ...args]).toEqual(['npx', 'playwright', 'install', 'chromium'])
      expect(options).toMatchObject({ cwd: f.root, timeout: 600_000 })
      writeFileSync(marker, 'browser')
      return { status: 0, stdout: 'Chromium 131.0.6778.33 downloaded', stderr: '' }
    }
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'pass', receipt: { valid: true, scope: 'full' }, output: { valid: true, noProgressCount: 0, environmentRepair: { attempted: true, reverified: true, installs: [{ command: 'npx', args: ['playwright', 'install', 'chromium'], root: '.', ok: true }] } } })
    expect(result.verified).not.toBeNull()
    expect(result.output).not.toHaveProperty('blocker')
    expect(f.receipts.map(receipt => receipt.valid)).toEqual([false, true])
    expect(installs.calls).toEqual([['npx', 'playwright', 'install', 'chromium']])
    const text = f.progressText()
    expect(text).toContain(`[environment] npx playwright install chromium (${path.basename(f.root)})`)
    expect(text).toContain(`Environment: installed Playwright chromium in ${path.basename(f.root)}`)
    expect(text.some(line => line.startsWith('[environment] Verification failed on the environment'))).toBe(true)
  })

  it('blocks instead of starting a correction round when the browser download cannot reach its CDN', async () => {
    const f = fixture()
    playwrightRepository(f)
    installs.handler = () => ({ status: 1, stdout: '', stderr: OFFLINE_DOWNLOAD })
    const blocked = await f.run({ commands: 'configured', hostBlockers: true })
    expect(blocked).toMatchObject({ outcome: 'blocked', status: 'blocked', error: { code: 'verification_host_precondition' }, verified: null,
      output: { valid: false, environmentRepair: { attempted: true, reverified: false, installs: [{ command: 'npx', ok: false }] },
        blocker: { kind: 'network', command: 'npx', args: ['playwright', 'install', 'chromium'], cwd: '.', requiredAction: 'Run `npx playwright install chromium` in . with network access, then retry the run.' } } })
    expect(blocked.error!.message).toContain('npx playwright install chromium')
    expect(f.receipts).toHaveLength(1)
    // Without the opt-in outcome the same structured blocker travels through `fail`, so a free-prompt fixer still receives it.
    installs.calls.length = 0
    const legacy = await f.run({ commands: 'configured' })
    expect(legacy).toMatchObject({ outcome: 'fail', output: { blocker: { kind: 'network' } } })
    expect(legacy).not.toHaveProperty('status')
    expect(installs.calls).toEqual([['npx', 'playwright', 'install', 'chromium']])
  })

  it('reports a host precondition on the first run as a blocker without installing anything', async () => {
    const f = fixture()
    f.deps.config.verification = [f.check('install.cjs', REGISTRY_401, 1)]
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'blocked', status: 'blocked', output: { blocker: { kind: 'credential', command: process.execPath, args: ['install.cjs'], cwd: '.' } } })
    expect((result.output as { blocker: { evidenceId: string } }).blocker.evidenceId).toBe(f.evidence[0].evidenceId)
    expect(result.output).not.toHaveProperty('environmentRepair')
    expect(installs.calls).toEqual([])
    f.deps.config.verification = [f.check('yarn.cjs', 'Usage Error: Environment variable not found (NODE_AUTH_TOKEN) in /w/app/.yarnrc.yml', 1)]
    expect(await f.run({ commands: 'configured', hostBlockers: true })).toMatchObject({ outcome: 'blocked', output: { blocker: { kind: 'environment-variable' } } })
  })

  it('leaves an ordinary assertion failure exactly as before: no install, no blocker, outcome fail', async () => {
    const f = fixture()
    f.deps.config.verification = [f.check('unit.cjs', 'FAIL src/game.spec.ts\n  ● clears lines\n    expect(received).toBe(expected)', 1)]
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'fail', receipt: { valid: false }, verified: null, output: { valid: false, noProgressCount: 1 } })
    expect(result).not.toHaveProperty('status')
    expect(result.output).not.toHaveProperty('blocker')
    expect(result.output).not.toHaveProperty('environmentRepair')
    expect(installs.calls).toEqual([])
  })

  it('does not install when the environment-repair guardrail is off, while precondition classification still applies', async () => {
    const f = fixture()
    f.deps.config.guardrails = { 'environment-repair': false }
    writeFileSync(path.join(f.root, 'package.json'), '{"devDependencies":{"jest":"^29"}}')
    f.deps.config.verification = [f.check('jest.cjs', 'sh: jest: command not found', 127)]
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'fail' })
    expect(result.output).not.toHaveProperty('blocker')
    expect(result.output).not.toHaveProperty('environmentRepair')
    expect(installs.calls).toEqual([])
    f.deps.config.verification = [f.check('install.cjs', REGISTRY_401, 1)]
    expect(await f.run({ commands: 'configured', hostBlockers: true })).toMatchObject({ outcome: 'blocked', output: { blocker: { kind: 'credential' } } })
  })

  it('keeps the no-progress stop as the loop bound when a blocker repeats without the opt-in outcome', async () => {
    const f = fixture()
    f.deps.config.verification = [f.check('install.cjs', REGISTRY_401, 1)]
    for (let i = 1; i <= 3; i++) {
      const result = await f.run({ commands: 'configured' })
      expect(result).toMatchObject({ outcome: i === 3 ? 'failed' : 'fail', output: { noProgressCount: i, blocker: { kind: 'credential' } } })
      if (i === 3) expect(result.error).toMatchObject({ code: 'verification_no_progress' })
      Object.assign(f.execution.state.$vars, result.vars)
    }
  })
})

describe('verification repair of version drift', () => {
  /** busuu-courses: lint fails on an untouched file because node_modules holds 5.23.0 against ^5.24.0. */
  const drifted = (f: ReturnType<typeof fixture>) => {
    writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ dependencies: { '@busuu/experiments': '^5.24.0' } }))
    mkdirSync(path.join(f.root, 'node_modules', '@busuu', 'experiments'), { recursive: true })
    const manifest = path.join(f.root, 'node_modules', '@busuu', 'experiments', 'package.json')
    writeFileSync(manifest, JSON.stringify({ version: '5.23.0' }))
    writeFileSync(path.join(f.root, 'lint.cjs'), `const v=require(${JSON.stringify(manifest)}).version;if(v!=='5.24.1'){process.stderr.write('src/untouched.ts\\n  3:7  error  Unsafe call of an any typed value  @typescript-eslint/no-unsafe-call');process.exitCode=1}`)
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['lint.cjs'] }]
    return manifest
  }

  it('installs once, verifies again and records the drifted packages when lint fails on a stale package', async () => {
    const f = fixture()
    const manifest = drifted(f)
    installs.handler = (command, args) => { expect([command, ...args]).toEqual(['npm', 'install', '--no-audit', '--no-fund', '--loglevel=error']); writeFileSync(manifest, JSON.stringify({ version: '5.24.1' })); return { status: 0, stdout: '', stderr: '' } }
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'pass', output: { valid: true, environmentRepair: { attempted: true, reverified: true, installs: [{ command: 'npm', ok: true }],
      drift: [{ root: '.', name: '@busuu/experiments', declared: '^5.24.0', installed: '5.23.0' }] } } })
    expect(installs.calls).toHaveLength(1)
    expect(f.receipts.map(receipt => receipt.valid)).toEqual([false, true])
    expect(f.progressText().some(line => line.includes('@busuu/experiments 5.23.0 does not satisfy ^5.24.0'))).toBe(true)
  })

  it('does not install twice when the lockfile keeps the drifted version, and says so', async () => {
    const f = fixture()
    drifted(f)
    installs.handler = () => ({ status: 0, stdout: '', stderr: '' })
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'fail', output: { valid: false, environmentRepair: { reverified: true, drift: [{ name: '@busuu/experiments' }] } } })
    expect(installs.calls).toHaveLength(1)
    expect(f.receipts).toHaveLength(2)
    expect(f.progressText().some(line => line.includes('the lockfile still resolves the drifted version'))).toBe(true)
  })

  it('changes nothing with the environment-repair guardrail off or without drift', async () => {
    const off = fixture()
    off.deps.config.guardrails = { 'environment-repair': false }
    drifted(off)
    const unrepaired = await off.run({ commands: 'configured', hostBlockers: true })
    expect(unrepaired).toMatchObject({ outcome: 'fail' })
    expect(unrepaired.output).not.toHaveProperty('environmentRepair')
    expect(installs.calls).toEqual([])
    const healthy = fixture()
    const manifest = drifted(healthy)
    writeFileSync(manifest, JSON.stringify({ version: '5.24.0' }))
    const plain = await healthy.run({ commands: 'configured', hostBlockers: true })
    expect(plain).toMatchObject({ outcome: 'fail' })
    expect(plain.output).not.toHaveProperty('environmentRepair')
    expect(installs.calls).toEqual([])
  })
})

describe('verification output adoption', () => {
  /** A check that exits 0 after writing `gen/mappings.js`: the same content every run (idempotent) or a fresh one (timestamp). */
  const generator = (f: ReturnType<typeof fixture>, stable: boolean, exitCode = 0) => {
    writeFileSync(path.join(f.root, 'lint.cjs'), `const fs=require('fs');fs.mkdirSync('gen',{recursive:true});fs.writeFileSync('gen/mappings.js',${stable ? "'module.exports = {}'" : 'String(Date.now()+Math.random())'});process.exitCode=${exitCode}`)
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['lint.cjs'], label: 'yarn test' }]
  }

  it('adopts deterministic output: one more run on the mutated candidate passes and certifies it', async () => {
    const f = fixture()
    generator(f, true)
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'pass', receipt: { valid: true }, output: { valid: true, noProgressCount: 0, adoptedOutputs: [{ repositoryId: 'repo', path: 'gen/mappings.js', change: 'added' }] } })
    expect(f.receipts.map(receipt => receipt.valid)).toEqual([false, true])
    expect(f.receipts[0].selfMutation).toMatchObject({ files: [{ path: 'gen/mappings.js' }], commands: [{ repositoryId: 'repo', label: 'yarn test' }] })
    expect(result.verified).toMatchObject({ receiptId: f.receipts[1].id, candidateHash: f.receipts[1].candidateHash })
    expect((result.output as { candidateHash: string }).candidateHash).toBe(f.receipts[1].candidateHash)
    expect(f.progressText()).toContain('[verification] adopted 1 generated file(s): gen/mappings.js')
    // Adopted output stays adopted on later passes that no longer mutate, so no role is invited to revert it.
    Object.assign(f.execution.state.$vars, result.vars)
    const later = await f.run({ commands: 'configured', hostBlockers: true })
    expect(later).toMatchObject({ outcome: 'pass', output: { adoptedOutputs: [{ path: 'gen/mappings.js' }] } })
    expect(later.output).not.toHaveProperty('selfMutation')
    expect(f.receipts).toHaveLength(3)
  })

  it('returns the typed blocker when the re-run modifies the candidate again, with and without host blockers', async () => {
    const f = fixture()
    generator(f, false)
    const blocked = await f.run({ commands: 'configured', hostBlockers: true })
    expect(blocked).toMatchObject({ outcome: 'blocked', status: 'blocked', verified: null, error: { code: 'verification_nondeterministic_output' },
      output: { valid: false, selfMutation: { files: [{ path: 'gen/mappings.js', change: 'modified' }] },
        blocker: { kind: 'nondeterministic-output', command: process.execPath, args: ['lint.cjs'], cwd: '.', requiredAction: 'Commit the generated output on the base branch or make the generator idempotent, then retry the run.' } } })
    expect((blocked.output as { blocker: { reason: string } }).blocker.reason).toContain('gen/mappings.js')
    expect(blocked.output).not.toHaveProperty('adoptedOutputs')
    expect(f.receipts).toHaveLength(2)
    const failed = await f.run({ commands: 'configured' })
    expect(failed).toMatchObject({ outcome: 'failed', status: 'failed', error: { code: 'verification_nondeterministic_output' }, output: { blocker: { kind: 'nondeterministic-output' } } })
    expect(f.receipts).toHaveLength(4)
  })

  it('blocks without a re-run when the verification-output-adoption guardrail is off', async () => {
    const f = fixture()
    f.deps.config.guardrails = { 'verification-output-adoption': false }
    generator(f, true)
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'blocked', error: { code: 'verification_nondeterministic_output' }, output: { blocker: { kind: 'nondeterministic-output' } } })
    expect((result.output as { blocker: { reason: string } }).blocker.reason).toContain('verification-output-adoption guardrail')
    expect(f.receipts).toHaveLength(1)
  })

  it('never masks a failing command: no adoption re-run, the fixer gets the failure and the mutation stays recorded', async () => {
    const f = fixture()
    generator(f, true, 1)
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'fail', verified: null, output: { valid: false, noProgressCount: 1, selfMutation: { files: [{ path: 'gen/mappings.js' }] }, commands: [{ exitCode: 1 }] } })
    expect((result.output as { reason: string }).reason).toMatch(/^A verification command failed\. Verification commands modified 1 candidate file: gen\/mappings\.js/)
    expect(result).not.toHaveProperty('status')
    expect(result.output).not.toHaveProperty('blocker')
    expect(result.output).not.toHaveProperty('adoptedOutputs')
    expect(f.receipts).toHaveLength(1)
  })

  it('leaves a run without mutation exactly as before', async () => {
    const f = fixture()
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("ok")'] }]
    const result = await f.run({ commands: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'pass', output: { valid: true } })
    for (const field of ['selfMutation', 'adoptedOutputs', 'blocker']) expect(result.output).not.toHaveProperty(field)
    expect(f.receipts).toHaveLength(1)
    expect(f.progressText().some(line => line.startsWith('[verification]'))).toBe(false)
  })
})

describe('setup commands', () => {
  it('runs setup sequentially before the plan, keeps its receipt out of certification and records it in the output', async () => {
    const f = fixture()
    f.deps.config.setup = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("prepared")'] }]
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("ok")'] }]
    const result = await f.run({ commands: 'configured', setup: 'configured', hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'pass', receipt: { valid: true, scope: 'full' }, output: { valid: true, setup: { commands: [{ exitCode: 0, args: ['-e', 'console.log("prepared")'] }] } } })
    expect((result.output as { setup: { commands: Array<{ output: string }> } }).setup.commands[0].output).toContain('prepared')
    expect(result.verified).toMatchObject({ receiptId: f.receipts[1].id })
    expect(f.receipts.map(receipt => receipt.kind)).toEqual(['scoped', 'full'])
    // An inline list with a `policy` is accepted; the policy never applies to setup.
    const inline = await f.run({ commands: 'configured', setup: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("inline")'], policy: { reuse: 'snapshot-local' } }] })
    expect(inline).toMatchObject({ outcome: 'pass', output: { setup: { commands: [{ exitCode: 0 }] } } })
    expect(f.progressText().some(line => line.includes('inline'))).toBe(true)
  })

  it('blocks on a failing setup command before any verification command runs', async () => {
    const f = fixture()
    f.deps.config.verification = [f.check('never.cjs', 'must not run', 1)]
    const setup = { repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.error("browser cache is read-only");process.exit(3)'] }
    const result = await f.run({ commands: 'configured', setup: [setup], hostBlockers: true })
    expect(result).toMatchObject({ outcome: 'blocked', status: 'blocked', error: { code: 'verification_host_precondition' }, verified: null,
      output: { valid: false, reason: 'A setup command failed', setup: { commands: [{ exitCode: 3 }] }, blocker: { kind: 'setup', command: process.execPath, args: setup.args, cwd: '.' } } })
    const blocker = (result.output as { blocker: { reason: string; requiredAction: string; evidenceId: string } }).blocker
    expect(blocker.reason).toContain('exit 3')
    expect(blocker.requiredAction).toMatch(/^Fix or remove the setup command/)
    expect(blocker.evidenceId).toBe(f.evidence[0].evidenceId)
    expect(result).not.toHaveProperty('receipt')
    expect(f.receipts).toHaveLength(1)
    expect(f.receipts[0].commands).toHaveLength(1)
    expect(await f.run({ commands: 'configured', setup: [setup] })).toMatchObject({ outcome: 'fail', output: { blocker: { kind: 'setup' } } })
    expect(f.receipts).toHaveLength(2)
  })

  it('rejects a setup command that escapes the admitted workspace with the scoped-command validation error', async () => {
    const f = fixture()
    f.deps.config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', '0'] }]
    await expect(f.run({ commands: 'configured', setup: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', '0'], cwd: '..' }] })).rejects.toThrow('Verification cwd escapes selected repository')
    expect(f.receipts).toHaveLength(0)
  })
})

describe('definition admission', () => {
  const definition = (params: Record<string, JsonValue>, ends: Record<string, string | null>) => ({ schemaVersion: 1, id: 'checks', title: 'Checks', journal: 'ledger-only', change: 'none', entry: 'verify', maxTransitions: 10, roles: [], nodes: {
    verify: { kind: 'verify', params, ends },
    done: { kind: 'end', params: { outcome: 'success', requiresVerified: true }, ends: {} },
    stop: { kind: 'end', params: { outcome: 'failure', reason: '{{outputs.verify.blocker.requiredAction}}', blockerFrom: 'verify' }, ends: {} },
  } })
  const codes = (value: unknown) => { const result = validateWorkflowDefinition(value, validationPieceRegistry(), {}); return result.ok ? [] : result.errors.map(error => error.code) }

  it('keeps the three legacy outcomes without the flag and requires `blocked` to be mapped with it', () => {
    const registry = validationPieceRegistry()
    expect(registry.outcomes('verify', { commands: 'configured' })).toEqual(['pass', 'fail', 'failed'])
    expect(registry.outcomes('verify', { commands: 'configured', hostBlockers: true })).toEqual(['pass', 'fail', 'failed', 'blocked'])
    expect(codes(definition({ commands: 'configured' }, { pass: 'done', fail: 'stop', failed: 'stop' }))).toEqual([])
    expect(codes(definition({ commands: 'configured', hostBlockers: true }, { pass: 'done', fail: 'stop', failed: 'stop' }))).toContain('invalid_outcomes')
    expect(codes(definition({ commands: 'configured', hostBlockers: true }, { pass: 'done', fail: 'stop', failed: 'stop', blocked: 'stop' }))).toEqual([])
    expect(codes(definition({ commands: 'configured', setup: 'configured', hostBlockers: false }, { pass: 'done', fail: 'stop', failed: 'stop' }))).toEqual([])
    expect(codes(definition({ commands: 'configured', setup: [{ repositoryId: 'repo', command: 'npx', args: ['playwright', 'install'] }] }, { pass: 'done', fail: 'stop', failed: 'stop' }))).toEqual([])
    expect(codes(definition({ commands: 'configured', setup: [{ command: 'npx' }] }, { pass: 'done', fail: 'stop', failed: 'stop' }))).not.toEqual([])
  })
})

