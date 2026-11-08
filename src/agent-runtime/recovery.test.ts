import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Annotation } from '@langchain/langgraph'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as openspec from './openspec.js'
import { EngineError } from './engine/contracts.js'
import * as pipeline from '../pipeline/pipeline-state.js'
import { initializePipeline, pipelineStateDirectory, validatePipelineContext, type PipelineContext } from '../pipeline/pipeline-state.js'
import { acquireWorkflowLease, readWorkflowEnvelope, writeWorkflowEnvelope } from './durable-store.js'
import { initializeVerificationPlan, bindPlan } from './verification-plan.js'
import { runWorkflow } from './workflow.js'
import { createRun, definitionRunDirectory } from './engine/runs.js'
import { validateWorkflowDefinition } from './engine/definition-validator.js'
import { validationPieceRegistry } from './engine/pieces/index.js'
import { ExecutorRegistry } from './executors.js'
import { RunDatabase } from './engine/checkpoint/database.js'
import { RunLease } from './engine/checkpoint/lease.js'
import { runRecovery } from './recovery.js'

let root: string, repo: string, context: PipelineContext
const call = (input: unknown) => runRecovery(context, input) as Promise<Record<string, any>>
const patch = async (extra = {}) => ({ action: 'patch', repositoryId: 'repo', path: 'code.js', operationId: randomUUID(), reason: 'Correct the observed return value', expectedHash: (await call({ action: 'read_file', repositoryId: 'repo', path: 'code.js' })).hash, oldText: 'return 1', newText: 'return 2', ...extra })
beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'recovery-'))); repo = path.join(root, 'repo'); mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'code.js'), 'function value() { return 1 }\n')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'])
  context = { schemaVersion: 1, runId: 'fixture', backlogRoot: root, artifactRoot: repo, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repo }], specs: [{ id: 1, title: 'Fixture', description: 'Repair blocked value', repositoryIds: ['repo'], acceptanceCriteria: ['Returns value'] }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' } }
  context = validatePipelineContext(context)
  initializePipeline(context, 'repair-fixture')
  await runWorkflow({ directory: path.join(pipelineStateDirectory(context), 'agent-workflow'), runId: context.runId, input: {},
    workflow: { id: 'fixture', version: '1', schema: Annotation.Root({}), entry: 'developer', nodes: { developer: { effect: 'read', ends: [], run: async () => ({ status: 'failed', error: 'Fixture failure' }) } } },
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('scoped recovery', () => {
  it('reads the original file, applies a guarded atomic edit, records history and replays without editing twice', async () => {
    const input = await patch()
    expect(await call(input)).toMatchObject({ status: 'applied', beforeHash: input.expectedHash, path: 'code.js' })
    expect(readFileSync(path.join(repo, 'code.js'), 'utf8')).toContain('return 2')
    expect(await call(input)).toMatchObject({ status: 'applied', replayed: true })
    expect((await call({ action: 'history' })).attempts).toHaveLength(1)
    expect((await call({ action: 'diff', repositoryId: 'repo', path: 'code.js' })).diff).toContain('+function value() { return 2 }')
    await expect(call({ ...input, newText: 'return 3' })).rejects.toThrow('different request')
  })

  it('rejects stale files, ambiguous fragments and cross-repository requests', async () => {
    const input = await patch()
    writeFileSync(path.join(repo, 'code.js'), 'return 1; return 1')
    await expect(call(input)).rejects.toThrow('changed since inspection')
    await expect(call(await patch())).rejects.toThrow('exactly one')
    await expect(call({ action: 'read_file', repositoryId: 'other', path: 'code.js' })).rejects.toThrow('does not belong')
    await expect(runRecovery({ ...context, specs: [{ id: 2, title: 'Changed scope', description: '', repositoryIds: ['repo'], acceptanceCriteria: [] }] }, { action: 'inspect' })).rejects.toThrow('frozen journal scope')
  })

  describe.each(['legacy', 'v2'])('file safety (%s)', engine => {
    beforeEach(async () => { if (engine === 'v2') await v2Run() })
    it.each(['../outside', '/tmp/outside', 'C:\\outside', '.GIT/config', '.specrails/state.json', '.env', '.env.local', '.ENV.production', 'node_modules/code', '.git./config', '.specrails /state', 'NUL'])('[spec:guided-run-recovery/safe-preserved-worktree-access] rejects protected or escaping path %s', async unsafe => {
      await expect(call({ action: 'read_file', repositoryId: 'repo', path: unsafe })).rejects.toThrow()
    })

    it('[spec:guided-run-recovery/safe-preserved-worktree-access] refuses symlinks and frozen-plan edits without changing targets', async () => {
      writeFileSync(path.join(root, 'outside'), 'private')
      symlinkSync(path.join(root, 'outside'), path.join(repo, 'link'))
      await expect(call({ action: 'read_file', repositoryId: 'repo', path: 'link' })).rejects.toThrow()
      for (const name of ['openspec/changes/repair-fixture/tasks.md', 'openspec/config.yaml', 'AGENTS.md']) {
        await expect(call(await patch({ path: name }))).rejects.toThrow('frozen plans')
      }
      expect(readFileSync(path.join(root, 'outside'), 'utf8')).toBe('private')
    })
  })

  it('shares the workflow lease and requires acknowledgement of interrupted writes', async () => {
    const directory = path.join(pipelineStateDirectory(context), 'agent-workflow')
    const release = await acquireWorkflowLease(directory, context.runId)
    try { await expect(call({ action: 'inspect' })).rejects.toThrow('lease') } finally { await release() }
    const input = await patch(), envelope = (await readWorkflowEnvelope(directory, context.runId))!
    envelope.state.status = 'running'; envelope.state.steps.developer!.status = 'interrupted'
    await writeWorkflowEnvelope(directory, envelope)
    await expect(call(input)).rejects.toThrow('acknowledge')
    expect(await call({ ...input, acknowledgeInterrupted: true })).toMatchObject({ status: 'applied' })
  })

  it('reconciles a crash after publication and refuses to repeat uncertain checks', async () => {
    const input = await patch(); await call(input)
    const file = path.join(pipelineStateDirectory(context), 'recovery-history.json')
    const history = JSON.parse(readFileSync(file, 'utf8')); history[0].status = 'pending'; writeFileSync(file, JSON.stringify(history))
    expect(await call(input)).toMatchObject({ status: 'applied', replayed: true })
    expect(readFileSync(path.join(repo, 'code.js'), 'utf8')).toContain('return 2')
  })

  it('does not mutate completed runs or a cancelled repair and releases the lease', async () => {
    const input = await patch(), controller = new AbortController(); controller.abort()
    expect(await runRecovery(context, input, controller.signal)).toMatchObject({ status: 'failed' })
    expect(readFileSync(path.join(repo, 'code.js'), 'utf8')).toContain('return 1')
    const directory = path.join(pipelineStateDirectory(context), 'agent-workflow'), envelope = (await readWorkflowEnvelope(directory, context.runId))!
    envelope.state.status = 'succeeded'; await writeWorkflowEnvelope(directory, envelope)
    await expect(call(await patch())).rejects.toThrow('Completed or archived')
    expect(await call({ action: 'inspect' })).toMatchObject({ status: 'succeeded' })
  })

  it('runs only registered checks, stores failures, and requires a changed precondition before repeating', async () => {
    const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("observed failure"); process.exit(1)'] }], [])
    bindPlan(context, plan)
    const input = { action: 'check', kind: 'verification', checkId: plan.entries[0]!.id, operationId: randomUUID(), reason: 'Verify the observed error' }
    expect(await call(input)).toMatchObject({ status: 'failed', output: expect.stringContaining('observed failure') })
    expect(await call(input)).toMatchObject({ status: 'failed', replayed: true })
    const file = path.join(pipelineStateDirectory(context), 'recovery-history.json')
    const history = JSON.parse(readFileSync(file, 'utf8')); history[0].status = 'pending'; writeFileSync(file, JSON.stringify(history))
    expect(await call(input)).toMatchObject({ status: 'interrupted', replayed: true })
    await expect(call({ ...input, operationId: randomUUID() })).rejects.toThrow('changed precondition')
    expect(await call({ ...input, operationId: randomUUID(), changedPrecondition: 'Repaired the external prerequisite' })).toMatchObject({ status: 'failed' })
    await expect(call({ ...input, command: 'arbitrary shell' })).rejects.toThrow()
    expect(await call({ ...input, operationId: randomUUID(), checkId: 'unknown' })).toMatchObject({ status: 'failed', error: expect.stringContaining('saved verification plan') })
    expect((await call({ action: 'inspect' })).checks).toMatchObject([{ id: plan.entries[0]!.id }])
  })

  it('validates real OpenSpec specs after a targeted repair without invoking an agent', async () => {
    const spec = path.join(repo, 'openspec/specs/example'); mkdirSync(spec, { recursive: true })
    writeFileSync(path.join(spec, 'spec.md'), '# Example\n\nThis specification describes the existing feature and the value returned to its callers.\n\n## Requirements\n### Requirement: Example\nThe system SHALL return a value.\n#### Scenario: Read\n- **WHEN** called\n- **THEN** a value is returned\n')
    const check = { action: 'check', kind: 'openspec', operationId: randomUUID(), reason: 'Check spec format' }
    expect(await call(check)).toMatchObject({ status: 'failed', error: expect.stringContaining('Purpose') })
    const read = await call({ action: 'read_file', repositoryId: 'repo', path: 'openspec/specs/example/spec.md' })
    expect(await call({ action: 'patch', repositoryId: 'repo', path: 'openspec/specs/example/spec.md', operationId: randomUUID(), reason: 'Restore required Purpose section', expectedHash: read.hash, oldText: '# Example\n', newText: '# Example\n\n## Purpose\n' })).toMatchObject({ status: 'applied' })
    const result = await call({ ...check, operationId: randomUUID(), changedPrecondition: 'Restored the missing Purpose heading' })
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed' })
  })
})

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}

async function v2Run(journal: 'implementation' | 'ledger-only' = 'implementation') {
  const validation = validateWorkflowDefinition({ schemaVersion: 1, id: 'recovery', title: 'Failed implementation recovery', journal, change: journal === 'implementation' ? 'new' : 'none', roles: [], entry: journal === 'implementation' ? 'verify' : 'fail', maxTransitions: 5, nodes: { ...(journal === 'implementation' ? { verify: { kind: 'implementation-step', params: { phase: 'verify' }, ends: { next: 'fail', incomplete: 'fail', rejected: 'fail', replan: 'fail', reverify: 'fail', rereview: 'fail', failed: 'fail' } } } : {}), fail: { kind: 'end', params: { outcome: 'failure' }, ends: {} } } }, validationPieceRegistry(), {})
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors))
  await createRun({ context, config: { schemaVersion: 1, enabled: true, providers: [], agents: { architect: { provider: 'fixture' }, developer: { provider: 'fixture' }, reviewer: { provider: 'fixture' } }, verification: [] }, definition: validation.definition, change: 'repair-fixture', registry: new ExecutorRegistry().register('fixture', { async execute() { throw new Error('No provider calls allowed') } }) })
  rmSync(path.join(pipelineStateDirectory(context), 'agent-workflow', context.runId), { recursive: true, force: true })
}

describe('v2 recovery observations', () => {
  beforeEach(() => v2Run())
  it('[spec:guided-run-recovery/inspect-original-run-evidence] inspects original lifecycle, saved checks and parent history without changing SQLite', async () => {
    const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'process.exit(0)'] }], []); bindPlan(context, plan)
    const filename = path.join(definitionRunDirectory(context), 'run.sqlite'), bytes = readFileSync(filename), mode = statSync(filename).mode
    const attempts = Array.from({ length: 25 }, (_, index) => ({ operationId: String(index), status: 'failed' }))
    writeFileSync(path.join(pipelineStateDirectory(context), 'recovery-history.json'), JSON.stringify(attempts))
    expect(await call({ action: 'inspect' })).toMatchObject({ status: 'failed', nextStep: expect.any(String), repositories: context.repositories, checks: [{ id: plan.entries[0]!.id }], verification: { valid: false, reasons: expect.any(Array) }, attempts: attempts.slice(-10) })
    expect(await call({ action: 'history' })).toMatchObject({ total: 25, nextOffset: 20, attempts: [...attempts].reverse().slice(0, 20) })
    expect(await call({ action: 'history', offset: 20 })).toEqual({ total: 25, attempts: [...attempts].reverse().slice(20) })
    expect(await call({ action: 'list_files', repositoryId: 'repo', path: '.' })).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ name: 'code.js' })]) })
    expect(await call({ action: 'read_file', repositoryId: 'repo', path: 'code.js', startLine: 1, endLine: 1 })).toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(await call({ action: 'diff', repositoryId: 'repo', path: 'code.js' })).toMatchObject({ diff: '' })
    expect(readFileSync(filename)).toEqual(bytes); expect(statSync(filename).mode).toBe(mode)
    expect(existsSync(path.join(definitionRunDirectory(context), context.runId, 'checkpoint.json'))).toBe(false)
  })
  it('[spec:guided-run-recovery/safe-preserved-worktree-access] retains symlink, repository and frozen-context containment', async () => {
    writeFileSync(path.join(root, 'private'), 'private'); symlinkSync(path.join(root, 'private'), path.join(repo, 'link'))
    await expect(call({ action: 'read_file', repositoryId: 'repo', path: 'link' })).rejects.toThrow()
    await expect(call({ action: 'read_file', repositoryId: 'wrong', path: 'code.js' })).rejects.toThrow('does not belong')
    await expect(runRecovery({ ...context, specs: [{ ...context.specs[0]!, title: 'Tampered scope' }] }, { action: 'inspect' })).rejects.toMatchObject({ code: 'recovery_unsupported_engine' })
  })
  it('provides diagnostic reads without fabricating a missing journal', async () => {
    context = { ...context, runId: 'journal-less' }; await v2Run('ledger-only')
    const file = path.join(pipelineStateDirectory(context), 'state.json')
    expect(await call({ action: 'inspect' })).toMatchObject({ status: 'failed', verification: { valid: false, reasons: [expect.stringContaining('unavailable')] } })
    expect(await call({ action: 'read_file', repositoryId: 'repo', path: 'code.js' })).toMatchObject({ hash: expect.any(String) })
    expect(existsSync(file)).toBe(false)
  })
  it('refuses observations while an independent executor owns the SQLite lease', async () => {
    const db = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite')), lease = new RunLease(db, context.runId), token = lease.acquire(randomUUID())
    try { await expect(call({ action: 'inspect' })).rejects.toThrow('lease') } finally { lease.release(token); db.close() }
  })
})

describe('v2 mutation admission', () => {
  beforeEach(() => v2Run())
  it.each(['patch', 'check'])('[spec:guided-run-recovery/engine-compatible-write-exclusion-and-lifecycle-guards] refuses %s under an independent live lease even with acknowledgement', async action => {
    const input = action === 'patch' ? await patch({ acknowledgeInterrupted: true }) : { action: 'check', kind: 'openspec', operationId: randomUUID(), reason: 'Inspect validation', acknowledgeInterrupted: true }
    const file = path.join(definitionRunDirectory(context), 'run.sqlite'), db = await RunDatabase.open(file), lease = new RunLease(db, context.runId), token = lease.acquire('live-engine')
    const bytes = readFileSync(file)
    try { await expect(call(input)).rejects.toThrow('lease'); expect(readFileSync(path.join(repo, 'code.js'), 'utf8')).toContain('return 1'); expect(existsSync(path.join(pipelineStateDirectory(context), 'recovery-history.json'))).toBe(false); expect(readFileSync(file)).toEqual(bytes) }
    finally { lease.release(token); db.close() }
  })
  it('[spec:guided-run-recovery/engine-compatible-write-exclusion-and-lifecycle-guards] fails unsupported preflight without changing SQLite, history or original files', async () => {
    context = { ...context, runId: 'unsupported' }; await v2Run('ledger-only')
    const input = await patch(), file = path.join(definitionRunDirectory(context), 'run.sqlite'), bytes = readFileSync(file)
    await expect(call(input)).rejects.toMatchObject({ code: 'recovery_unsupported_engine', action: 'patch', recommendation: expect.stringContaining('fork') })
    expect(readFileSync(file)).toEqual(bytes); expect(existsSync(path.join(pipelineStateDirectory(context), 'recovery-history.json'))).toBe(false)
    expect(readFileSync(path.join(repo, 'code.js'), 'utf8')).toContain('return 1')
  })
  it('[spec:guided-run-recovery/engine-compatible-write-exclusion-and-lifecycle-guards] serializes recovery calls and holds SQLite ownership until a check settles', async () => {
    const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'process.exit(0)'] }], []); bindPlan(context, plan)
    const input = await patch(), ready = deferredSignal(), release = deferredSignal()
    const original = pipeline.verifyPipeline, spy = vi.spyOn(pipeline, 'verifyPipeline').mockImplementation(async (...args) => { ready.resolve(); await release.promise; return original(...args) })
    const checking = call({ action: 'check', kind: 'verification', checkId: plan.entries[0]!.id, operationId: randomUUID(), reason: 'Hold check until released' })
    try {
      await ready.promise
      await expect(call(input)).rejects.toThrow('lease')
      const db = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite')), lease = new RunLease(db, context.runId)
      try { expect(() => lease.acquire('engine-contender')).toThrow('Another executor') } finally { db.close() }
    } finally { release.resolve(); await checking; spy.mockRestore() }
    expect(await call(input)).toMatchObject({ status: 'applied' })
  })
})

describe('v2 guarded patch', () => {
  beforeEach(() => v2Run())
  it('[spec:guided-run-recovery/guarded-idempotent-patch] repairs only the original file and replays the unchanged Attempt shape', async () => {
    const input = await patch(), db = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite'), { readOnly: true })
    const before = db.sqlite.prepare('SELECT candidate_json,verified_json,completion_json,head_checkpoint_json FROM runs').get(); db.close()
    const result = await call(input)
    expect(result).toMatchObject({ status: 'applied', beforeHash: input.expectedHash, path: 'code.js', repositoryId: 'repo' })
    expect(readFileSync(path.join(repo, 'code.js'), 'utf8')).toBe('function value() { return 2 }\n')
    expect(await call(input)).toMatchObject({ status: 'applied', replayed: true })
    await expect(call({ ...input, newText: 'return 3' })).rejects.toThrow('different request')
    const history = (await call({ action: 'history' })).attempts
    expect(history).toHaveLength(1)
    expect(Object.keys(history[0]).sort()).toEqual(['action', 'afterHash', 'beforeHash', 'candidateHash', 'completedAt', 'operationId', 'path', 'reason', 'repositoryId', 'requestHash', 'startedAt', 'status'].sort())
    const after = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite'), { readOnly: true })
    expect(after.sqlite.prepare('SELECT candidate_json,verified_json,completion_json,head_checkpoint_json FROM runs').get()).toEqual(before); after.close()
  })
  it.each(['published', 'unpublished'])('[spec:guided-run-recovery/guarded-idempotent-patch] reconciles a pending %s patch without applying it twice', async publication => {
    const input = await patch(); await call(input)
    if (publication === 'unpublished') writeFileSync(path.join(repo, 'code.js'), 'function value() { return 1 }\n')
    const file = path.join(pipelineStateDirectory(context), 'recovery-history.json'), history = JSON.parse(readFileSync(file, 'utf8'))
    history[0].status = 'pending'; delete history[0].completedAt; writeFileSync(file, JSON.stringify(history))
    expect(await call(input)).toMatchObject({ status: publication === 'published' ? 'applied' : 'interrupted', replayed: true })
    expect(readFileSync(path.join(repo, 'code.js'), 'utf8')).toContain(publication === 'published' ? 'return 2' : 'return 1')
  })
  it('[spec:guided-run-recovery/guarded-idempotent-patch] refuses stale, duplicate, missing and no-op fragments without changing the file', async () => {
    const input = await patch()
    await expect(call({ ...input, expectedHash: '0'.repeat(64) })).rejects.toThrow('changed since inspection')
    await expect(call({ ...input, oldText: 'missing' })).rejects.toThrow('exactly one')
    await expect(call({ ...input, newText: input.oldText })).rejects.toThrow('actual change')
    writeFileSync(path.join(repo, 'code.js'), 'return 1; return 1')
    await expect(call(await patch())).rejects.toThrow('exactly one')
    expect(readFileSync(path.join(repo, 'code.js'), 'utf8')).toBe('return 1; return 1')
  })
  it.each(['openspec/changes/repair-fixture/tasks.md', 'openspec/config.yaml', 'AGENTS.md'])('refuses frozen target %s', async file => {
    await expect(call(await patch({ path: file }))).rejects.toThrow('frozen plans')
  })
  it.each(['running', 'interrupted'])('[spec:guided-run-recovery/engine-compatible-write-exclusion-and-lifecycle-guards] requires acknowledgement of saved %s work without a live owner', async status => {
    const input = await patch(), db = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite'))
    if (status === 'running') db.sqlite.prepare('UPDATE runs SET status=?').run(status)
    else db.sqlite.prepare('UPDATE steps SET status=?').run(status)
    db.close()
    await expect(call(input)).rejects.toThrow('acknowledge')
    expect(await call({ ...input, acknowledgeInterrupted: true })).toMatchObject({ status: 'applied' })
  })
  it.each(['succeeded', 'archived'])('[spec:guided-run-recovery/engine-compatible-write-exclusion-and-lifecycle-guards] refuses %s repair and retains observational access', async terminal => {
    const input = await patch()
    if (terminal === 'succeeded') { const db = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite')); db.sqlite.prepare('UPDATE runs SET status=?').run('succeeded'); db.close() }
    else { const file = path.join(pipelineStateDirectory(context), 'state.json'), journal = JSON.parse(readFileSync(file, 'utf8')); journal.phases.archive.status = 'done'; writeFileSync(file, JSON.stringify(journal)) }
    await expect(call(input)).rejects.toThrow('Completed or archived')
    expect(await call({ action: 'inspect' })).toMatchObject({ runId: context.runId })
    expect(readFileSync(path.join(repo, 'code.js'), 'utf8')).toContain('return 1')
  })
  it('does not mistake a failed completion record for successful completion', async () => {
    const db = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite'))
    db.sqlite.prepare('UPDATE runs SET completion_json=?').run(JSON.stringify({ ok: false, verified: false })); db.close()
    expect(await call(await patch())).toMatchObject({ status: 'applied' })
  })
})

describe('v2 saved checks', () => {
  beforeEach(() => v2Run())
  it('[spec:guided-run-recovery/safe-preserved-worktree-access] [spec:guided-run-recovery/bounded-saved-checks-and-retry-guard] runs all seven actions on one original SQLite fixture and retries only after a real candidate change', async () => {
    const count = path.join(root, 'executions'), script = 'const fs=require("node:fs");fs.appendFileSync(' + JSON.stringify(count) + ',"run\\n"); console.log("output\\n".repeat(3000));process.exit(fs.readFileSync("code.js","utf8").includes("return 2")?0:7)'
    const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', script] }], []); bindPlan(context, plan)
    const inspect = await call({ action: 'inspect' }), checkId = inspect.checks[0].id
    expect(checkId).toBe(plan.entries[0]!.id)
    expect(await call({ action: 'list_files', repositoryId: 'repo', path: '.' })).toMatchObject({ entries: expect.any(Array) })
    const read = await call({ action: 'read_file', repositoryId: 'repo', path: 'code.js' })
    const input = { action: 'check', kind: 'verification', checkId, operationId: randomUUID(), reason: 'Check original value' }
    const failed = await call(input)
    expect(failed).toMatchObject({ status: 'failed', candidateHash: expect.any(String) }); expect(failed.output.length).toBeLessThanOrEqual(16000)
    expect(await call(input)).toMatchObject({ status: 'failed', replayed: true })
    expect(readFileSync(count, 'utf8')).toBe('run\n')
    await expect(call({ ...input, operationId: randomUUID() })).rejects.toThrow('changed precondition')
    expect(await call(await patch({ expectedHash: read.hash }))).toMatchObject({ status: 'applied' })
    const passed = await call({ ...input, operationId: randomUUID() })
    expect(passed).toMatchObject({ status: 'passed' }); expect(passed.candidateHash).not.toBe(failed.candidateHash)
    expect(await call({ action: 'diff', repositoryId: 'repo', path: 'code.js' })).toMatchObject({ diff: expect.stringContaining('+function value() { return 2 }') })
    expect((await call({ action: 'history' })).attempts).toHaveLength(3)
    const db = await RunDatabase.open(path.join(definitionRunDirectory(context), 'run.sqlite'), { readOnly: true })
    expect(db.sqlite.prepare('SELECT status,verified_json FROM runs').get()).toMatchObject({ status: 'failed', verified_json: null }); expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM receipts').get()!.count).toBe(0); db.close()
    expect(pipeline.inspectPipeline(context).phases.archive.status).not.toBe('done')
  })
  it.each(['pending', 'interrupted'])('[spec:guided-run-recovery/bounded-saved-checks-and-retry-guard] never repeats an unchanged %s check without a changed precondition', async status => {
    const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'process.exit(1)'] }], []); bindPlan(context, plan)
    const input = { action: 'check', kind: 'verification', checkId: plan.entries[0]!.id, operationId: randomUUID(), reason: 'Check observed failure' }
    await call(input)
    const file = path.join(pipelineStateDirectory(context), 'recovery-history.json'), history = JSON.parse(readFileSync(file, 'utf8')); history[0].status = status; writeFileSync(file, JSON.stringify(history))
    expect(await call(input)).toMatchObject({ status: 'interrupted', replayed: true })
    await expect(call({ ...input, operationId: randomUUID() })).rejects.toThrow('changed precondition')
    expect(await call({ ...input, operationId: randomUUID(), changedPrecondition: 'External prerequisite was repaired' })).toMatchObject({ status: 'failed' })
  })
  it('[spec:guided-run-recovery/bounded-saved-checks-and-retry-guard] runs real pinned OpenSpec validation, records failure and passes after a spec repair', async () => {
    const spec = path.join(repo, 'openspec/specs/example'); mkdirSync(spec, { recursive: true })
    writeFileSync(path.join(spec, 'spec.md'), '# Example\n\nThe feature returns the required value to the caller.\n\n## Requirements\n### Requirement: Example\nThe system SHALL return a value.\n#### Scenario: Read\n- **WHEN** called\n- **THEN** a value is returned\n')
    const input = { action: 'check', kind: 'openspec', operationId: randomUUID(), reason: 'Validate the retained specs' }
    expect(await call(input)).toMatchObject({ status: 'failed' })
    const read = await call({ action: 'read_file', repositoryId: 'repo', path: 'openspec/specs/example/spec.md' })
    expect(await call({ action: 'patch', repositoryId: 'repo', path: 'openspec/specs/example/spec.md', operationId: randomUUID(), reason: 'Restore Purpose', expectedHash: read.hash, oldText: '# Example\n', newText: '# Example\n\n## Purpose\n' })).toMatchObject({ status: 'applied' })
    expect(await call({ ...input, operationId: randomUUID() })).toMatchObject({ status: 'passed' })
  })
  it('[spec:guided-run-recovery/bounded-saved-checks-and-retry-guard] rejects empty OpenSpec reports even with a successful subprocess exit', async () => {
    const spy = vi.spyOn(openspec, 'runOpenSpec').mockResolvedValue('{"items":[],"summary":{"totals":{"failed":0}}}')
    try { expect(await call({ action: 'check', kind: 'openspec', operationId: randomUUID(), reason: 'Inspect empty validation' })).toMatchObject({ status: 'failed', error: expect.stringContaining('any specs/changes') }) }
    finally { spy.mockRestore() }
  })
  it('[spec:guided-run-recovery/bounded-saved-checks-and-retry-guard] executes only registered check IDs and rejects caller commands', async () => {
    const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'process.exit(0)'] }], []); bindPlan(context, plan)
    const input = { action: 'check', kind: 'verification', checkId: 'unknown', operationId: randomUUID(), reason: 'Unknown check' }
    expect(await call(input)).toMatchObject({ status: 'failed', error: expect.stringContaining('saved verification plan') })
    await expect(call({ ...input, command: 'arbitrary' })).rejects.toThrow()
  })
  it('fails closed before mutation when a saved plan has lost integrity', async () => {
    const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'process.exit(0)'] }], []); bindPlan(context, plan)
    const file = path.join(pipelineStateDirectory(context), 'verification/plan.json'), saved = JSON.parse(readFileSync(file, 'utf8')); saved.entries[0].command.args = ['-e', 'process.exit(9)']; writeFileSync(file, JSON.stringify(saved))
    const database = path.join(definitionRunDirectory(context), 'run.sqlite'), bytes = readFileSync(database)
    await expect(call({ action: 'check', kind: 'verification', checkId: plan.entries[0]!.id, operationId: randomUUID(), reason: 'Inspect corrupt plan' })).rejects.toMatchObject({ code: 'recovery_unsupported_engine' })
    expect(readFileSync(database)).toEqual(bytes); expect(existsSync(path.join(pipelineStateDirectory(context), 'recovery-history.json'))).toBe(false)
  })
  it('detects candidate drift during a real saved check and retains the 45-second deadline', async () => {
    const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("code.js","changed by check")'] }], []); bindPlan(context, plan)
    const original = pipeline.verifyPipeline, spy = vi.spyOn(pipeline, 'verifyPipeline'), started = Date.now()
    spy.mockImplementation((...args) => original(...args))
    try {
      expect(await call({ action: 'check', kind: 'verification', checkId: plan.entries[0]!.id, operationId: randomUUID(), reason: 'Detect verifier mutation' })).toMatchObject({ status: 'failed' })
      expect(spy.mock.calls[0]![4]!.deadline).toBeGreaterThanOrEqual(started + 45000)
      expect(spy.mock.calls[0]![4]!.deadline).toBeLessThanOrEqual(Date.now() + 45000)
    } finally { spy.mockRestore() }
  })
  it.each(['abort', 'lease-loss'])('[spec:guided-run-recovery/engine-compatible-write-exclusion-and-lifecycle-guards] settles owned subprocesses after %s and leaves honest history', async mode => {
    const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'console.log("ready:"+process.pid);setInterval(()=>{},1000)'] }], []); bindPlan(context, plan)
    const controller = new AbortController(), ready = deferredSignal(), original = pipeline.verifyPipeline
    let pid = 0, lose: ((error: EngineError) => void) | undefined
    const heartbeat = vi.spyOn(RunLease.prototype, 'heartbeat').mockImplementation((_token, onLost) => { lose = onLost; return () => {} })
    const spy = vi.spyOn(pipeline, 'verifyPipeline').mockImplementation((ctx, request, log, signal, options) => original(ctx, request, text => { const match = text.match(/ready:(\d+)/); if (match) { pid = Number(match[1]); ready.resolve() } log?.(text) }, signal, options))
    const input = { action: 'check', kind: 'verification', checkId: plan.entries[0]!.id, operationId: randomUUID(), reason: 'Cancel owned verification' }
    const checking = runRecovery(context, input, controller.signal)
    try {
      await ready.promise
      if (mode === 'abort') controller.abort(new Error('operator cancelled'))
      else lose!(new EngineError('lease_lost', 'heartbeat lost'))
      expect(await checking).toMatchObject({ status: 'failed' })
      expect(() => process.kill(pid, 0)).toThrow()
      expect((await call({ action: 'history' })).attempts[0]).toMatchObject({ status: 'failed' })
      expect(await call(await patch())).toMatchObject({ status: 'applied' })
    } finally { controller.abort(); await checking; spy.mockRestore(); heartbeat.mockRestore() }
  })
})

it('rejects v2 verification without a saved plan before writing lease metadata or history', async () => {
  await v2Run()
  rmSync(path.join(pipelineStateDirectory(context), 'verification/plan.json'), { force: true })
  const file = path.join(definitionRunDirectory(context), 'run.sqlite'), bytes = readFileSync(file)
  await expect(call({ action: 'check', kind: 'verification', checkId: 'missing', operationId: randomUUID(), reason: 'Inspect unavailable plan' })).rejects.toMatchObject({ code: 'recovery_unsupported_engine', action: 'check' })
  expect(readFileSync(file)).toEqual(bytes); expect(existsSync(path.join(pipelineStateDirectory(context), 'recovery-history.json'))).toBe(false)
})

it('keeps v2 file and history observations available when a bound journal is missing', async () => {
  await v2Run()
  rmSync(path.join(pipelineStateDirectory(context), 'state.json'))
  expect(await call({ action: 'read_file', repositoryId: 'repo', path: 'code.js' })).toMatchObject({ hash: expect.any(String) })
  expect(await call({ action: 'list_files', repositoryId: 'repo', path: '.' })).toMatchObject({ entries: expect.any(Array) })
  expect(await call({ action: 'diff', repositoryId: 'repo', path: 'code.js' })).toMatchObject({ diff: '' })
  expect(await call({ action: 'history' })).toEqual({ attempts: [], total: 0 })
  await expect(call({ action: 'inspect' })).rejects.toMatchObject({ code: 'recovery_unsupported_engine', action: 'inspect' })
  expect(existsSync(path.join(pipelineStateDirectory(context), 'state.json'))).toBe(false)
})
