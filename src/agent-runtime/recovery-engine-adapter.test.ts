import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { EngineError } from './engine/contracts.js'
import { afterEach, expect, it, vi } from 'vitest'
import { initializePipeline, pipelineStateDirectory, validatePipelineContext } from '../pipeline/pipeline-state.js'
import { contentDigest } from './engine/canonical-json.js'
import { initializeVerificationPlan, bindPlan } from './verification-plan.js'
import { ExecutorRegistry } from './executors.js'
import { Annotation } from '@langchain/langgraph'
import { runWorkflow } from './workflow.js'
import { createRun, definitionRunDirectory } from './engine/runs.js'
import { validateWorkflowDefinition } from './engine/definition-validator.js'
import { validationPieceRegistry } from './engine/pieces/index.js'
import { RunLease } from './engine/checkpoint/lease.js'
import { RunDatabase } from './engine/checkpoint/database.js'
import { acquireRecoveryExecutionLease, requireRecoveryMutationAuthority, detectRecoveryEngine, readNormalizedRecoveryState, readRecoveryAuthority } from './recovery-engine-adapter.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'recovery-adapter-')); roots.push(root)
  const repo = path.join(root, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'code.js'), 'original\n')
  const context = validatePipelineContext({ schemaVersion: 1, runId: 'adapter', backlogRoot: root, artifactRoot: repo, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repo }], specs: [{ id: 1, title: 'Repair', description: 'Repair original work' }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' } })
  const validation = validateWorkflowDefinition({ schemaVersion: 1, id: 'recovery', title: 'Recovery fixture', journal: 'ledger-only', change: 'none', roles: [], entry: 'fail', maxTransitions: 5, nodes: { fail: { kind: 'end', params: { outcome: 'failure' }, ends: {} } } }, validationPieceRegistry(), {})
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors))
  await createRun({ context, config: { schemaVersion: 1, enabled: true, providers: [], agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } }, verification: [] }, definition: validation.definition, registry: new ExecutorRegistry().register('claude', { async execute() { throw new Error('Provider calls are forbidden in recovery fixtures') } }) })
  const directory = pipelineStateDirectory(context), filename = path.join(definitionRunDirectory(context), 'run.sqlite')
  return { context, directory, filename }
}

it('[spec:guided-run-recovery/engine-aware-saved-run-detection] detects absence and gives SQLite precedence over a legacy checkpoint', async () => {
  const f = await fixture()
  expect(await detectRecoveryEngine(f.directory)).toBe('v2')
  const legacy = path.join(f.directory, 'agent-workflow', f.context.runId); mkdirSync(legacy)
  writeFileSync(path.join(legacy, 'checkpoint.json'), 'not a checkpoint')
  expect(await detectRecoveryEngine(f.directory)).toBe('v2')
  expect(await detectRecoveryEngine(path.join(f.directory, 'absent'))).toBeNull()
})

it('normalizes failed SQLite without changing bytes, mode, revision or fabricating a journal', async () => {
  const f = await fixture(), bytes = readFileSync(f.filename), mode = statSync(f.filename).mode
  const db = await RunDatabase.open(f.filename, { readOnly: true }), revision = db.revision; db.close()
  expect(await readNormalizedRecoveryState(f.directory, 'v2')).toMatchObject({ status: 'failed', candidateHash: null })
  expect(readFileSync(f.filename)).toEqual(bytes); expect(statSync(f.filename).mode).toBe(mode)
  const reopened = await RunDatabase.open(f.filename, { readOnly: true }); expect(reopened.revision).toBe(revision); reopened.close()
  expect(existsSync(path.join(f.directory, 'state.json'))).toBe(false)
})

it('uses a validated root journal to fingerprint the current candidate', async () => {
  const f = await fixture(); initializePipeline(f.context, 'repair-fixture')
  const authority = await readRecoveryAuthority(f.directory, 'v2', 'inspect', f.context)
  expect(authority.state.candidateHash).toMatch(/^[a-f0-9]{64}$/)
  expect(authority.inspection?.runId).toBe(f.context.runId)
})

it('preserves duplicate node paths from every scope', async () => {
  const f = await fixture(), db = await RunDatabase.open(f.filename)
  db.sqlite.prepare('INSERT INTO steps(run_id,node_path,scope_id,kind,status,updated_at) VALUES (?,?,?,?,?,?)').run(f.context.runId, 'same', 'left', 'assign', 'interrupted', new Date().toISOString())
  db.sqlite.prepare('INSERT INTO steps(run_id,node_path,scope_id,kind,status,updated_at) VALUES (?,?,?,?,?,?)').run(f.context.runId, 'same', 'right', 'assign', 'succeeded', new Date().toISOString()); db.close()
  const state = await readNormalizedRecoveryState(f.directory, 'v2')
  expect(Object.values(state.steps)).toEqual(expect.arrayContaining([{ status: 'interrupted' }, { status: 'succeeded' }]))
})

it('rejects a different frozen caller context with an actionable typed error', async () => {
  const f = await fixture()
  await expect(readRecoveryAuthority(f.directory, 'v2', 'patch', { ...f.context, specs: [] })).rejects.toMatchObject({ code: 'recovery_unsupported_engine', action: 'patch', recommendation: expect.stringContaining('fork') })
})

it('[spec:guided-run-recovery/engine-aware-saved-run-detection] does not fall back from a corrupt SQLite store and closes failed reads', async () => {
  const f = await fixture(); writeFileSync(f.filename, 'corrupt sqlite')
  await expect(readRecoveryAuthority(f.directory, 'v2', 'inspect', f.context)).rejects.toMatchObject({ code: 'recovery_unsupported_engine', action: 'inspect' })
  rmSync(f.filename)
  expect(existsSync(f.filename)).toBe(false)
})

it('[spec:guided-run-recovery/engine-aware-saved-run-detection] normalizes a checksum-validated legacy envelope and current journal candidate', async () => {
  const f = await fixture(); rmSync(f.filename)
  initializePipeline(f.context, 'repair-fixture')
  await runWorkflow({ directory: path.join(f.directory, 'agent-workflow'), runId: f.context.runId, input: {}, workflow: { id: 'legacy', version: '1', schema: Annotation.Root({}), entry: 'fail', nodes: { fail: { effect: 'read', ends: [], run: async () => ({ status: 'failed', error: 'fixture' }) } } } })
  expect(await detectRecoveryEngine(f.directory)).toBe('legacy')
  expect(await readNormalizedRecoveryState(f.directory, 'legacy')).toMatchObject({ status: 'failed', candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
})

it.each(['schema', 'directory', 'symlink', 'run-id'])('[spec:guided-run-recovery/engine-aware-saved-run-detection] rejects unsafe or incompatible %s stores without fallback', async kind => {
  const f = await fixture()
  if (kind === 'schema' || kind === 'run-id') {
    const db = await RunDatabase.open(f.filename)
    if (kind === 'schema') db.sqlite.exec('PRAGMA user_version=999')
    else db.sqlite.prepare('UPDATE runs SET request_json=?').run(JSON.stringify({ context: { ...f.context, runId: 'other' } }))
    db.close()
  } else {
    rmSync(f.filename)
    if (kind === 'directory') mkdirSync(f.filename)
    else { const target = path.join(path.dirname(f.filename), 'target'); writeFileSync(target, 'not SQLite'); symlinkSync(target, f.filename) }
  }
  expect(await detectRecoveryEngine(f.directory)).toBe('v2')
  await expect(readRecoveryAuthority(f.directory, 'v2', 'inspect', f.context)).rejects.toMatchObject({ code: 'recovery_unsupported_engine', message: expect.not.stringContaining('Recovery requires an existing saved run') })
  rmSync(f.filename, { recursive: true })
})

it('does not repair broad file permissions during observations', async () => {
  const f = await fixture()
  if (process.platform !== 'win32') chmodSync(f.filename, 0o644)
  const mode = statSync(f.filename).mode
  await readNormalizedRecoveryState(f.directory, 'v2')
  expect(statSync(f.filename).mode).toBe(mode)
})

async function bindJournal(f: Awaited<ReturnType<typeof fixture>>, scopeId: string) {
  const nodePath = 'implementation', digest = contentDigest({ parentRunId: f.context.runId, scopeId, nodePath }).slice(0, 24)
  const context = { ...f.context, runId: f.context.runId + '-impl-' + digest }
  initializePipeline(context, 'bound-fixture')
  const plan = initializeVerificationPlan(context, [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'process.exit(0)'] }], []); bindPlan(context, plan)
  const db = await RunDatabase.open(f.filename)
  db.sqlite.prepare('INSERT INTO piece_state(run_id,scope_id,node_path,key,value_json,updated_at) VALUES (?,?,?,?,?,?)').run(f.context.runId, scopeId, nodePath, 'binding:implementation', JSON.stringify({ context, change: 'bound-fixture', parentRunId: f.context.runId, scopeId, nodePath, directory: pipelineStateDirectory(context) }), new Date().toISOString()); db.close()
  return context
}

it('uses a unique validated full-scope bound journal and its saved checks', async () => {
  const f = await fixture(), context = await bindJournal(f, 'child')
  const authority = await readRecoveryAuthority(f.directory, 'v2', 'inspect', f.context)
  expect(authority.journalContext).toEqual(context)
  expect(authority.state.candidateHash).toMatch(/^[a-f0-9]{64}$/)
  expect(authority.plan?.entries).toHaveLength(1)
  expect(existsSync(path.join(f.directory, 'state.json'))).toBe(false)
})

it('rejects conflicting bound authority without creating a parent journal', async () => {
  const f = await fixture(); await bindJournal(f, 'left'); await bindJournal(f, 'right')
  await expect(readRecoveryAuthority(f.directory, 'v2', 'patch', f.context)).rejects.toMatchObject({ code: 'recovery_unsupported_engine', message: expect.stringContaining('Multiple implementation journals') })
  expect(existsSync(path.join(f.directory, 'state.json'))).toBe(false)
})

it('keeps mutation preflight read-only when candidate/archive authority is unavailable', async () => {
  const f = await fixture(), bytes = readFileSync(f.filename)
  const authority = await readRecoveryAuthority(f.directory, 'v2', 'patch', f.context)
  expect(() => requireRecoveryMutationAuthority(authority, 'patch')).toThrow('candidate/archive')
  expect(readFileSync(f.filename)).toEqual(bytes)
  expect(existsSync(path.join(f.directory, 'recovery-history.json'))).toBe(false)
})

it('holds the execution lease until release and permits subsequent ownership', async () => {
  const f = await fixture(); initializePipeline(f.context, 'repair-fixture')
  const authority = await readRecoveryAuthority(f.directory, 'v2', 'patch', f.context)
  const owned = await acquireRecoveryExecutionLease(f.directory, f.context, authority, 'patch')
  const db = await RunDatabase.open(f.filename), contender = new RunLease(db, f.context.runId)
  try { expect(() => contender.acquire('independent-engine')).toThrow('Another executor'); owned.assert() }
  finally { owned.release(); db.close() }
  const reopened = await RunDatabase.open(f.filename), lease = new RunLease(reopened, f.context.runId), token = lease.acquire('subsequent-engine')
  lease.release(token); reopened.close()
})

it('blocks authority drift between preflight and ownership and releases acquisition resources', async () => {
  const f = await fixture(); initializePipeline(f.context, 'repair-fixture')
  const before = await readRecoveryAuthority(f.directory, 'v2', 'patch', f.context)
  writeFileSync(path.join(f.context.artifactRoot, 'code.js'), 'changed after preflight')
  await expect(acquireRecoveryExecutionLease(f.directory, f.context, before, 'patch')).rejects.toThrow('changed')
  const db = await RunDatabase.open(f.filename), lease = new RunLease(db, f.context.runId), token = lease.acquire('after-failure'); lease.release(token); db.close()
})

it('links cancellation to lease ownership and releases after cancellation', async () => {
  const f = await fixture(); initializePipeline(f.context, 'repair-fixture')
  const controller = new AbortController(), before = await readRecoveryAuthority(f.directory, 'v2', 'check', f.context)
  const owned = await acquireRecoveryExecutionLease(f.directory, f.context, before, 'check', controller.signal)
  controller.abort(new Error('caller cancelled'))
  expect(owned.signal.aborted).toBe(true)
  expect(() => owned.assert()).toThrow('caller cancelled'); owned.release()
  const db = await RunDatabase.open(f.filename), lease = new RunLease(db, f.context.runId), token = lease.acquire('after-cancel'); lease.release(token); db.close()
})

it('excludes a child-process engine contender with a ready/release handshake', async () => {
  const f = await fixture(); initializePipeline(f.context, 'repair-fixture')
  const before = await readRecoveryAuthority(f.directory, 'v2', 'patch', f.context)
  const owned = await acquireRecoveryExecutionLease(f.directory, f.context, before, 'patch')
  const databaseModule = new URL('../../dist/agent-runtime/engine/checkpoint/database.js', import.meta.url).href
  const leaseModule = new URL('../../dist/agent-runtime/engine/checkpoint/lease.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { RunDatabase } from ${JSON.stringify(databaseModule)};
    import { RunLease } from ${JSON.stringify(leaseModule)};
    const db = await RunDatabase.open(process.argv[1]);
    const lease = new RunLease(db, process.argv[2]);
    try { lease.acquire('child-contender'); process.stdout.write('unexpected\\n'); }
    catch (error) { process.stdout.write(error.code + '\\n'); }
    process.stdin.once('data', () => {
      const token = lease.acquire('child-after-release'); lease.release(token); db.close();
      process.stdout.write('acquired\\n'); process.stdin.destroy();
    });
  `, f.filename, f.context.runId], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  try {
    expect((await lines.next()).value).toBe('lease_held')
    owned.release(); child.stdin.end('release\n')
    expect((await lines.next()).value).toBe('acquired')
    expect(await closed).toBe(0)
  } finally { owned.release(); child.kill(); await closed }
})

it('allows expired ownership and cleans up a failed acquisition', async () => {
  const f = await fixture(); initializePipeline(f.context, 'repair-fixture')
  const db = await RunDatabase.open(f.filename), lease = new RunLease(db, f.context.runId, () => 1000)
  lease.acquire('expired-engine', 1)
  const before = await readRecoveryAuthority(f.directory, 'v2', 'patch', f.context)
  const owned = await acquireRecoveryExecutionLease(f.directory, f.context, before, 'patch'); owned.release()
  const current = new RunLease(db, f.context.runId), token = current.acquire('live-engine')
  try { await expect(acquireRecoveryExecutionLease(f.directory, f.context, before, 'patch')).rejects.toMatchObject({ code: 'lease_held' }) }
  finally { current.release(token); db.close() }
})

it('aborts on heartbeat loss and releases its token after settlement', async () => {
  const f = await fixture(); initializePipeline(f.context, 'repair-fixture')
  const before = await readRecoveryAuthority(f.directory, 'v2', 'patch', f.context)
  const heartbeat = vi.spyOn(RunLease.prototype, 'heartbeat')
  let lose: ((error: EngineError) => void) | undefined
  heartbeat.mockImplementation((_token, onLost) => { lose = onLost; return () => {} })
  try {
    const owned = await acquireRecoveryExecutionLease(f.directory, f.context, before, 'patch')
    lose!(new EngineError('lease_lost', 'heartbeat failed'))
    expect(owned.signal.aborted).toBe(true); expect(() => owned.assert()).toThrow('heartbeat failed')
    owned.release()
    const db = await RunDatabase.open(f.filename), lease = new RunLease(db, f.context.runId), token = lease.acquire('after-loss'); lease.release(token); db.close()
  } finally { heartbeat.mockRestore() }
})

it('considers archive evidence from every validated bound journal even with root authority', async () => {
  const f = await fixture(); initializePipeline(f.context, 'repair-fixture')
  const bound = await bindJournal(f, 'child'), filename = path.join(pipelineStateDirectory(bound), 'state.json'), journal = JSON.parse(readFileSync(filename, 'utf8'))
  journal.phases.archive.status = 'done'; writeFileSync(filename, JSON.stringify(journal))
  const authority = await readRecoveryAuthority(f.directory, 'v2', 'patch', f.context)
  expect(authority.journalContext).toEqual(f.context)
  expect(authority.archived).toBe(true)
})

it('blocks successful completion published after preflight even if the saved status has not changed', async () => {
  const f = await fixture(); initializePipeline(f.context, 'repair-fixture')
  const before = await readRecoveryAuthority(f.directory, 'v2', 'patch', f.context)
  const db = await RunDatabase.open(f.filename); db.sqlite.prepare('UPDATE runs SET completion_json=?').run(JSON.stringify({ ok: true })); db.close()
  await expect(acquireRecoveryExecutionLease(f.directory, f.context, before, 'patch')).rejects.toThrow('authority changed')
})
