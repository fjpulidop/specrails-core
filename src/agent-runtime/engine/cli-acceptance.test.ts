import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pipelineStateDirectory, type PipelineContext } from '../../pipeline/pipeline-state.js'
import { RunDatabase } from './checkpoint/database.js'
import { RunLease } from './checkpoint/lease.js'

/**
 * CLI-level acceptance for the packaged engine v2 verbs through both shipped
 * entry points. Every case spawns the built CLI (dist) exactly as a host does;
 * the definition contains no AI node, so no provider is ever contacted.
 */
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const entries = {
  'bin/specrails-core.mjs runtime': [path.join(packageRoot, 'bin', 'specrails-core.mjs'), 'runtime'],
  'dist/agent-runtime/cli.js': [path.join(packageRoot, 'dist', 'agent-runtime', 'cli.js')],
} as const
type Entry = keyof typeof entries
const fixtures = fileURLToPath(new URL('./__fixtures__/acceptance/', import.meta.url))
const published = JSON.parse(readFileSync(path.join(fixtures, 'question-flow.json'), 'utf8')) as Record<string, unknown> & { version: string; id: string }
const runtimeConfig = JSON.parse(readFileSync(path.join(fixtures, 'runtime-config.json'), 'utf8')) as Record<string, unknown>

type Line = Record<string, any>
interface Invocation { code: number | null; lines: Line[]; last: Line | undefined; stderr: string }
const liveChildren = new Set<ChildProcess>()
let root: string, repository: string, backlogRoot: string, configFile: string, definitionFile: string

function invoke(entry: Entry, args: string[], stdin?: string): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...entries[entry], ...args], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: '1' }, detached: process.platform !== 'win32', stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    liveChildren.add(child)
    child.once('close', () => liveChildren.delete(child))
    let stdout = '', stderr = ''
    child.stdout!.on('data', chunk => { stdout += String(chunk) })
    child.stderr!.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.stdin?.on('error', () => { /* Early validation failures can close stdin. */ })
    if (stdin !== undefined) child.stdin?.end(stdin)
    child.on('close', code => {
      try {
        const lines = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Line)
        resolve({ code, lines, last: lines.at(-1), stderr })
      } catch { reject(new Error('CLI stdout must contain only JSON lines: ' + stdout + '\n' + stderr)) }
    })
  })
}
const context = (runId: string): PipelineContext => ({ schemaVersion: 1, runId, backlogRoot, backlogPath: path.join(backlogRoot, '.specrails', 'local-tickets.json'), artifactRoot: repository, artifactRepositoryId: 'repo',
  repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
  specs: [{ id: 'acceptance', title: 'CLI acceptance', description: 'Provider-free engine v2 acceptance' }] })
function file(name: string, value: unknown): string { const target = path.join(root, name); writeFileSync(target, JSON.stringify(value)); return target }
function contextFile(runId: string): string { return file(runId + '.context.json', context(runId)) }
const database = (runId: string) => path.join(pipelineStateDirectory(context(runId)), 'agent-workflow', 'run.sqlite')
/** The contract emits a single runtime-result line for every fatal error. */
function fatal(result: Invocation): { code?: string; message: string; details?: unknown } {
  expect(result.code, result.stderr).toBe(1)
  expect(result.lines, result.stderr).toHaveLength(1)
  expect(result.last).toMatchObject({ type: 'runtime-result', status: 'failed' })
  const error = result.last!.error
  return typeof error === 'string' ? { message: error } : error
}
async function pausedRun(entry: Entry, runId: string): Promise<{ contextFile: string; result: Invocation }> {
  const target = contextFile(runId)
  const result = await invoke(entry, ['run', '--context', target, '--config', configFile, '--definition', definitionFile])
  expect(result.code, JSON.stringify(result.last) + result.stderr).toBe(2)
  expect(result.last).toMatchObject({ type: 'runtime-result', engineVersion: 2, status: 'paused', pendingQuestion: { stepId: 'ask' }, completion: null })
  return { contextFile: target, result }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'engine cli acceptance ')))
  repository = path.join(root, 'repo'); backlogRoot = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlogRoot)
  const git = spawnSync('git', ['init', '-q', repository], { encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr)
  configFile = file('runtime-config.json', runtimeConfig)
  definitionFile = file('definition.json', published)
})
afterEach(async () => {
  await Promise.all([...liveChildren].map(async child => {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
    else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 10_000))])
  }))
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}, 20_000)

describe.each(Object.keys(entries) as Entry[])('structured fatal errors through %s', entry => {
  it('emits one runtime-result line with error.code for argument, definition and run lookup failures', async () => {
    const unknown = fatal(await invoke(entry, ['bogus-operation']))
    expect(unknown.message).toContain('Unknown runtime operation: bogus-operation')
    const missing = contextFile('never-created')
    expect(fatal(await invoke(entry, ['run', '--context', missing, '--config', configFile, '--definition', definitionFile, '--workflow', 'specrails-implementation']))).toMatchObject({ code: 'invalid_arguments' })
    expect(existsSync(pipelineStateDirectory(context('never-created')))).toBe(false)
    const tampered = file('tampered.json', { ...published, version: 'f'.repeat(64) })
    const mismatch = fatal(await invoke(entry, ['run', '--context', missing, '--config', configFile, '--definition', tampered]))
    expect(mismatch.code).toBe('invalid_definition')
    expect(mismatch.details).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'definition_hash_mismatch', path: '/version' })]))
    const validated = await invoke(entry, ['workflows', 'validate', '--stdin'], JSON.stringify({ ...published, version: 'f'.repeat(64) }))
    expect(validated.code).toBe(1)
    expect(validated.lines).toHaveLength(1)
    expect(validated.last).toMatchObject({ type: 'runtime-definition-validated', ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'definition_hash_mismatch' })]) })
    expect(fatal(await invoke(entry, ['status', '--run-dir', path.join(root, 'no-such-run')]))).toMatchObject({ code: 'run_not_found' })
    expect(fatal(await invoke(entry, ['fork', '--context', missing, '--from', 'ask', '--run-id', 'never-forked']))).toMatchObject({ code: 'run_not_found' })
    expect(existsSync(pipelineStateDirectory(context('never-forked')))).toBe(false)
  })

  it('rejects resume with a definition and fork under an active lease without touching the run', async () => {
    const { contextFile: source } = await pausedRun(entry, 'leased')
    const bytes = readFileSync(database('leased'))
    expect(fatal(await invoke(entry, ['resume', '--context', source, '--definition', definitionFile]))).toMatchObject({ code: 'invalid_arguments' })
    expect(fatal(await invoke(entry, ['resume', '--context', source, '--config', configFile]))).toMatchObject({ code: 'invalid_arguments' })
    expect(fatal(await invoke(entry, ['resume', '--context', source, '--answer', 'yes', '--recover', 'ask']))).toMatchObject({ code: 'invalid_arguments' })
    expect(fatal(await invoke(entry, ['resume', '--context', source, '--answer', 'yes', '--invalidate', 'check']))).toMatchObject({ code: 'invalid_arguments' })
    expect(fatal(await invoke(entry, ['resume', '--context', source, '--invalidate', 'check', '--recover', 'check']))).toMatchObject({ code: 'invalid_arguments' })
    const db = await RunDatabase.open(database('leased')), lease = new RunLease(db, 'leased'), token = lease.acquire('another-executor')
    try {
      expect(fatal(await invoke(entry, ['fork', '--context', source, '--from', 'ask', '--run-id', 'leased-fork']))).toMatchObject({ code: 'lease_held' })
      expect(fatal(await invoke(entry, ['resume', '--context', source, '--answer', 'yes']))).toMatchObject({ code: 'lease_held' })
      const status = await invoke(entry, ['status', '--context', source, '--compact'])
      expect(status.last).toMatchObject({ type: 'runtime-status', engineVersion: 2, state: { status: 'paused', lease: { owner: 'another-executor', active: true } } })
    } finally { lease.release(token); db.close() }
    expect(existsSync(pipelineStateDirectory(context('leased-fork')))).toBe(false)
    expect(fatal(await invoke(entry, ['fork', '--context', source, '--from', 'ask', '--run-id', 'leased']))).toMatchObject({ code: 'invalid_arguments' })
    expect(fatal(await invoke(entry, ['fork', '--context', source, '--from', 'no-such-node', '--run-id', 'leased-fork']))).toMatchObject({ code: 'fork_ambiguous' })
    expect((await invoke(entry, ['status', '--context', source, '--compact'])).last).toMatchObject({ state: { status: 'paused', lease: null } })
    expect(readFileSync(database('leased')).length).toBe(bytes.length)
    const released = await invoke(entry, ['resume', '--context', source, '--answer', 'yes'])
    expect(released.code, JSON.stringify(released.last) + released.stderr).toBe(0)
    expect(released.last).toMatchObject({ status: 'succeeded', completion: { ok: true } })
  })
})

describe('status and efficiency summary', () => {
  it('reports engineVersion 2, lease, workflow, completion and an active duration that excludes human wait', async () => {
    const { contextFile: source, result } = await pausedRun('dist/agent-runtime/cli.js', 'timed')
    expect(result.lines[0]).toMatchObject({ type: 'runtime-graph', engineVersion: 2, runId: 'timed', definitionHash: published.version })
    expect(result.last).toMatchObject({ efficiencySummary: { schemaVersion: 1, runId: 'timed', invocations: { total: 0 } }, invocationUsage: { costUsd: 0, inputTokens: 0, outputTokens: 0 } })
    const first = await invoke('bin/specrails-core.mjs runtime', ['status', '--context', source, '--compact'])
    expect(first.code, first.stderr).toBe(0)
    expect(first.lines).toHaveLength(1)
    expect(first.last).toMatchObject({ type: 'runtime-status', engineVersion: 2, workflow: { id: published.id, version: published.version, source: 'definition' }, completion: null,
      state: { runId: 'timed', status: 'paused', lease: null, pendingQuestion: { stepId: 'ask' }, steps: { check: { kind: 'condition', status: 'succeeded', visits: 1 }, ask: { kind: 'question', status: 'paused', visits: 1 } } },
      efficiencySummary: { schemaVersion: 1, runId: 'timed', invocations: { total: 0, byKind: { initial: 0 } } } })
    expect(first.last!.state.pendingInterrupts).toHaveLength(1)
    const pausedActive = first.last!.state.usage.durationMs as number
    expect(pausedActive).toBeGreaterThanOrEqual(0)
    expect(first.last!.metrics.total.durationMs).toBe(pausedActive)
    // Human wait: the run stays paused while nothing executes.
    await new Promise(resolve => setTimeout(resolve, 1200))
    const second = await invoke('dist/agent-runtime/cli.js', ['status', '--context', source, '--compact'])
    expect(second.last!.state.usage.durationMs).toBe(pausedActive)
    const started = Date.now()
    const resumed = await invoke('dist/agent-runtime/cli.js', ['resume', '--context', source, '--answer', 'continue'])
    const wall = Date.now() - started
    expect(resumed.code, JSON.stringify(resumed.last) + resumed.stderr).toBe(0)
    expect(resumed.last).toMatchObject({ type: 'runtime-result', engineVersion: 2, status: 'succeeded', completion: { ok: true, reasons: [], verified: false }, workflow: { version: published.version } })
    const activeAfter = resumed.last!.usage.durationMs as number
    expect(activeAfter).toBeGreaterThanOrEqual(pausedActive)
    expect(activeAfter - pausedActive).toBeLessThanOrEqual(wall)
    expect(activeAfter - pausedActive).toBeLessThan(1200)
    expect(resumed.last!.metrics.total.durationMs).toBe(activeAfter)
    const final = await invoke('dist/agent-runtime/cli.js', ['status', '--context', source, '--compact'])
    expect(final.last).toMatchObject({ completion: { ok: true }, state: { status: 'succeeded', lease: null, usage: { durationMs: activeAfter } }, efficiencySummary: { runId: 'timed' } })
    const again = await invoke('dist/agent-runtime/cli.js', ['resume', '--context', source])
    expect(again.code).toBe(0)
    expect(again.last).toMatchObject({ status: 'succeeded', usage: { durationMs: activeAfter } })
  })
})

describe('fork and invalidate through the CLI', () => {
  it('forks a historical cut, resumes the fork and leaves the source database byte-identical', async () => {
    const { contextFile: source } = await pausedRun('dist/agent-runtime/cli.js', 'source')
    const bytes = readFileSync(database('source'))
    const forked = await invoke('bin/specrails-core.mjs runtime', ['fork', '--context', source, '--from', 'ask', '--run-id', 'copy'])
    expect(forked.code, JSON.stringify(forked.last) + forked.stderr).toBe(0)
    expect(forked.lines).toHaveLength(1)
    expect(forked.last).toMatchObject({ type: 'runtime-forked', runId: 'copy', forkOf: 'source', fromNodePath: 'ask', scopeId: 'root', visit: 1, context: { runId: 'copy' } })
    expect(forked.last!.directory).toBe(path.dirname(database('copy')))
    const copy = contextFile('copy')
    const status = await invoke('dist/agent-runtime/cli.js', ['status', '--context', copy, '--compact'])
    expect(status.last).toMatchObject({ engineVersion: 2, forkOf: 'source', state: { runId: 'copy', status: 'paused', lease: null, pendingQuestion: { stepId: 'ask' } } })
    const stillPaused = await invoke('dist/agent-runtime/cli.js', ['resume', '--context', copy])
    expect(stillPaused.code, stillPaused.stderr).toBe(2)
    expect(stillPaused.last).toMatchObject({ runId: 'copy', forkOf: 'source', status: 'paused' })
    const done = await invoke('dist/agent-runtime/cli.js', ['resume', '--context', copy, '--answer', 'fork'])
    expect(done.code, JSON.stringify(done.last) + done.stderr).toBe(0)
    expect(done.last).toMatchObject({ runId: 'copy', forkOf: 'source', status: 'succeeded', completion: { ok: true } })
    expect(readFileSync(database('source')).equals(bytes)).toBe(true)
    expect((await invoke('dist/agent-runtime/cli.js', ['status', '--context', source, '--compact'])).last).toMatchObject({ state: { status: 'paused' } })
    expect(fatal(await invoke('dist/agent-runtime/cli.js', ['fork', '--context', source, '--from', 'ask', '--run-id', 'copy']))).toMatchObject({ code: 'run_exists' })
    // A validated $vars patch applies to the destination only.
    const patched = await invoke('dist/agent-runtime/cli.js', ['fork', '--context', source, '--from', 'check', '--run-id', 'patched', '--state', file('patch.json', { $vars: { stop: true } })])
    expect(patched.code, JSON.stringify(patched.last) + patched.stderr).toBe(0)
    const stopped = await invoke('dist/agent-runtime/cli.js', ['resume', '--context', contextFile('patched')])
    expect(stopped.code, JSON.stringify(stopped.last) + stopped.stderr).toBe(1)
    expect(stopped.last).toMatchObject({ runId: 'patched', forkOf: 'source', status: 'failed', completion: { ok: false, reasons: ['stopped_by_fork_patch'] } })
    expect(fatal(await invoke('dist/agent-runtime/cli.js', ['fork', '--context', source, '--from', 'check', '--run-id', 'budget', '--state', file('bad-patch.json', { $budget: 1 })]))).toMatchObject({ code: 'invalid_arguments' })
    expect(existsSync(pipelineStateDirectory(context('budget')))).toBe(false)
    expect(readFileSync(database('source')).equals(bytes)).toBe(true)
  })

  it('invalidates by forking a new historical run and continues there', async () => {
    const { contextFile: source } = await pausedRun('dist/agent-runtime/cli.js', 'history')
    const bytes = readFileSync(database('history'))
    const invalidated = await invoke('dist/agent-runtime/cli.js', ['resume', '--context', source, '--invalidate', 'check', '--run-id', 'history-again'])
    expect(invalidated.code, JSON.stringify(invalidated.last) + invalidated.stderr).toBe(2)
    expect(invalidated.lines[0]).toMatchObject({ type: 'runtime-forked', runId: 'history-again', forkOf: 'history', fromNodePath: 'check' })
    expect(invalidated.lines[1]).toMatchObject({ type: 'runtime-graph', runId: 'history-again' })
    expect(invalidated.last).toMatchObject({ type: 'runtime-result', runId: 'history-again', forkOf: 'history', status: 'paused', pendingQuestion: { stepId: 'ask' }, completion: null })
    expect(invalidated.last!.steps).toMatchObject({ check: { status: 'succeeded', visits: 1 }, ask: { status: 'paused', visits: 1 } })
    expect(readFileSync(database('history')).equals(bytes)).toBe(true)
    const original = await invoke('bin/specrails-core.mjs runtime', ['status', '--context', source, '--compact'])
    expect(original.last).toMatchObject({ state: { runId: 'history', status: 'paused' } })
    expect(original.last).not.toHaveProperty('forkOf')
    const generated = await invoke('dist/agent-runtime/cli.js', ['resume', '--context', source, '--invalidate', 'ask'])
    expect(generated.code, JSON.stringify(generated.last) + generated.stderr).toBe(2)
    expect(generated.lines[0]).toMatchObject({ type: 'runtime-forked', forkOf: 'history', fromNodePath: 'ask' })
    expect(generated.lines[0].runId).toMatch(/^history-invalidate-[0-9a-f]{8}$/)
    expect(existsSync(database(generated.lines[0].runId as string))).toBe(true)
    const finished = await invoke('dist/agent-runtime/cli.js', ['resume', '--context', contextFile('history-again'), '--answer', 'after invalidation'])
    expect(finished.code, JSON.stringify(finished.last) + finished.stderr).toBe(0)
    expect(finished.last).toMatchObject({ runId: 'history-again', forkOf: 'history', status: 'succeeded', completion: { ok: true } })
    expect(readFileSync(database('history')).equals(bytes)).toBe(true)
    const workflows = await invoke('bin/specrails-core.mjs runtime', ['workflows', 'list'])
    expect(workflows.code, workflows.stderr).toBe(0)
    expect(workflows.last).toMatchObject({ type: 'runtime-workflows', nodeKindsVersion: 1, builtins: [{ id: 'specrails-implementation', deprecated: false }] })
    expect(workflows.last!.nodeKinds).toHaveLength(16)
  })
})
