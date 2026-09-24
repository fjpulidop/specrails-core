import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Annotation } from '@langchain/langgraph'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializePipeline, pipelineStateDirectory, validatePipelineContext, type PipelineContext } from '../installer/runtime/pipeline-state.js'
import { acquireWorkflowLease, readWorkflowEnvelope, writeWorkflowEnvelope } from './durable-store.js'
import { initializeVerificationPlan, bindPlan } from './verification-plan.js'
import { runWorkflow } from './workflow.js'
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

  it.each(['../outside', '/tmp/outside', 'C:\\outside', '.GIT/config', '.specrails/state.json', '.env', '.env.local', '.git./config', '.specrails /state', 'NUL'])('rejects protected or escaping path %s', async unsafe => {
    await expect(call({ action: 'read_file', repositoryId: 'repo', path: unsafe })).rejects.toThrow()
  })

  it('refuses symlinks and frozen-plan edits without changing targets', async () => {
    writeFileSync(path.join(root, 'outside'), 'private')
    symlinkSync(path.join(root, 'outside'), path.join(repo, 'link'))
    await expect(call({ action: 'read_file', repositoryId: 'repo', path: 'link' })).rejects.toThrow()
    for (const name of ['openspec/changes/repair-fixture/tasks.md', 'openspec/config.yaml', 'AGENTS.md']) {
      await expect(call(await patch({ path: name }))).rejects.toThrow('frozen plans')
    }
    expect(readFileSync(path.join(root, 'outside'), 'utf8')).toBe('private')
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
