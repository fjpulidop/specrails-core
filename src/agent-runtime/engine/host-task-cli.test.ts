import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PipelineContext } from '../../pipeline/pipeline-state.js'
import { definitionVersion } from './canonical-json.js'

/**
 * Durable host-task behaviour through the packaged CLI (dist), exactly as Desktop
 * drives it: run → exit 2 with a machine interrupt → resume --host-result. The
 * definition has no AI node, so no provider is contacted.
 */
const cli = fileURLToPath(new URL('../../../dist/agent-runtime/cli.js', import.meta.url))
const runtimeConfig = JSON.parse(readFileSync(fileURLToPath(new URL('./__fixtures__/acceptance/runtime-config.json', import.meta.url)), 'utf8')) as Record<string, unknown>
type Line = Record<string, any>
interface Invocation { code: number | null; lines: Line[]; last: Line | undefined; stderr: string }
let root: string, repository: string, backlogRoot: string, configFile: string, definitionFile: string

function invoke(args: string[]): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
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
  specs: [{ id: 'host-task', title: 'Host task', description: 'Provider-free host task acceptance' }] })
function file(name: string, value: unknown): string { const target = path.join(root, name); writeFileSync(target, JSON.stringify(value)); return target }
const contextFile = (runId: string) => file(runId + '.context.json', context(runId))

function definition() {
  const body = {
    schemaVersion: 1, id: 'host-task-acceptance', title: 'Host task acceptance', journal: 'ledger-only', change: 'none', entry: 'init', maxTransitions: 30, roles: [],
    nodes: {
      init: { kind: 'assign', params: { set: { rounds: 0 } }, ends: { next: 'checks', failed: 'failed' } },
      checks: { kind: 'host-task', params: { task: 'pr.checks', input: { round: '{{run.rounds}}' }, outcomes: ['green', 'red'], effect: 'read', timeoutMs: 3_600_000 }, ends: { green: 'done', red: 'count', failed: 'failed' } },
      count: { kind: 'assign', params: { increment: { rounds: 1 } }, ends: { next: 'checks', failed: 'failed' } },
      done: { kind: 'end', params: { outcome: 'success', reason: 'Checks {{outputs.checks.outcome}} after {{run.rounds}} round(s)' }, ends: {} },
      failed: { kind: 'end', params: { outcome: 'failure' }, ends: {} },
    },
  }
  return { ...body, version: definitionVersion(body) }
}
function pending(result: Invocation) { return result.last!.pendingInterrupts as Array<{ id: string; kind: string; value: Record<string, any> }> }
async function paused(runId: string) {
  const target = contextFile(runId)
  const result = await invoke(['run', '--context', target, '--config', configFile, '--definition', definitionFile])
  expect(result.code, JSON.stringify(result.last) + result.stderr).toBe(2)
  expect(result.last).toMatchObject({ type: 'runtime-result', status: 'paused', completion: null })
  expect(result.last).not.toHaveProperty('pendingQuestion')
  expect(result.last).not.toHaveProperty('pendingApproval')
  return { target, result, interrupt: pending(result)[0] }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'engine host task ')))
  repository = path.join(root, 'repo'); backlogRoot = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlogRoot)
  const git = spawnSync('git', ['init', '-q', repository], { encoding: 'utf8' })
  if (git.status !== 0) throw new Error(git.stderr)
  configFile = file('runtime-config.json', runtimeConfig)
  definitionFile = file('definition.json', definition())
})
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

describe('host-task through the CLI', () => {
  it('pauses on a machine interrupt, survives reopen and resumes with the host result', async () => {
    const { target, interrupt } = await paused('loop')
    expect(interrupt).toMatchObject({ kind: 'host-task', value: { kind: 'host-task', task: 'pr.checks', input: { round: '0' }, outcomes: ['green', 'red'], effect: 'read', timeoutMs: 3_600_000, candidate: { verified: false } } })
    expect(typeof interrupt.value.candidate.hash).toBe('string')
    // Durable reopen: a fresh process reads the same pending machine interrupt.
    const status = await invoke(['status', '--context', target, '--compact'])
    expect(status.last).toMatchObject({ state: { status: 'paused', lease: null, pendingInterrupts: [{ id: interrupt.id, kind: 'host-task' }] } })
    // A bare resume keeps the run paused on the same interrupt.
    const still = await invoke(['resume', '--context', target])
    expect(still.code, still.stderr).toBe(2)
    expect(pending(still)[0].id).toBe(interrupt.id)

    const red = await invoke(['resume', '--context', target, '--interrupt-id', interrupt.id, '--host-result', file('red.json', { outcome: 'red', output: { failures: [{ name: 'test', log: 'Authorization: Bearer abcdefghijklmnop1234' }] } })])
    expect(red.code, JSON.stringify(red.last) + red.stderr).toBe(2)
    const second = pending(red)[0]
    expect(second.id).not.toBe(interrupt.id)
    expect(second.value.input).toEqual({ round: '1' })
    const full = await invoke(['status', '--context', target])
    expect(JSON.stringify(full.last)).not.toContain('abcdefghijklmnop1234')

    const green = await invoke(['resume', '--context', target, '--interrupt-id', second.id, '--host-result', file('green.json', { outcome: 'green' })])
    expect(green.code, JSON.stringify(green.last) + green.stderr).toBe(0)
    expect(green.last).toMatchObject({ status: 'succeeded', completion: { ok: true, reasons: ['Checks green after 1 round(s)'] } })
  })

  it('validates host results before persisting and refuses human flags', async () => {
    const { target, interrupt } = await paused('validate')
    const fail = (result: Invocation) => { expect(result.code).toBe(1); return result.last!.error as { code: string } }
    expect(fail(await invoke(['resume', '--context', target, '--interrupt-id', interrupt.id, '--host-result', file('bad.json', { outcome: 'purple' })]))).toMatchObject({ code: 'invalid_resume' })
    expect(fail(await invoke(['resume', '--context', target, '--interrupt-id', interrupt.id, '--host-result', file('big.json', { outcome: 'green', output: 'x'.repeat(300_000) })]))).toMatchObject({ code: 'invalid_resume' })
    expect(fail(await invoke(['resume', '--context', target, '--host-result', file('ok.json', { outcome: 'green' })]))).toMatchObject({ code: 'invalid_arguments' })
    expect(fail(await invoke(['resume', '--context', target, '--interrupt-id', 'missing', '--host-result', file('ok.json', { outcome: 'green' })]))).toMatchObject({ code: 'interrupt_not_found' })
    expect(fail(await invoke(['resume', '--context', target, '--answer', 'yes']))).toMatchObject({ code: 'invalid_resume' })
    expect(fail(await invoke(['resume', '--context', target, '--interrupt-id', interrupt.id, '--approve', interrupt.id]))).toMatchObject({ code: 'invalid_resume' })
    // Nothing was persisted: the interrupt is still pending and resolvable.
    const status = await invoke(['status', '--context', target, '--compact'])
    expect(status.last).toMatchObject({ state: { status: 'paused', pendingInterrupts: [{ id: interrupt.id }] } })
    const done = await invoke(['resume', '--context', target, '--interrupt-id', interrupt.id, '--host-result', file('ok.json', { outcome: 'green' })])
    expect(done.code, done.stderr).toBe(0)
  })

  it('treats a repeated identical result as a no-op and a different one as a conflict', async () => {
    const { target, interrupt } = await paused('idempotent')
    const ok = file('ok.json', { outcome: 'green' })
    expect((await invoke(['resume', '--context', target, '--interrupt-id', interrupt.id, '--host-result', ok])).code).toBe(0)
    // The interrupt is no longer pending once answered: a replay cannot change it.
    const replay = await invoke(['resume', '--context', target, '--interrupt-id', interrupt.id, '--host-result', ok])
    expect(replay.code).toBe(1)
    expect(replay.last!.error).toMatchObject({ code: 'interrupt_not_found' })
    expect((await invoke(['status', '--context', target, '--compact'])).last).toMatchObject({ completion: { ok: true }, state: { status: 'succeeded' } })
  })

  it('fails through the failed edge when the host reports failed', async () => {
    const { target, interrupt } = await paused('host-failed')
    const result = await invoke(['resume', '--context', target, '--interrupt-id', interrupt.id, '--host-result', file('failed.json', { outcome: 'failed', output: { detail: 'gh is not authenticated' } })])
    expect(result.code).toBe(1)
    expect(result.last).toMatchObject({ status: 'failed', completion: { ok: false } })
  })

  it('cancels a run paused on a host task', async () => {
    const { target, interrupt } = await paused('cancelled')
    const cancel = await invoke(['cancel', '--context', target])
    expect(cancel.code, cancel.stderr).toBe(0)
    expect((await invoke(['status', '--context', target, '--compact'])).last).toMatchObject({ state: { status: 'cancelled' } })
    const late = await invoke(['resume', '--context', target, '--interrupt-id', interrupt.id, '--host-result', file('ok.json', { outcome: 'green' })])
    expect(late.code).not.toBe(0)
  })

  it('forks before the host task and raises a fresh interrupt in the fork', async () => {
    const { target, interrupt } = await paused('source')
    const forked = await invoke(['fork', '--context', target, '--from', 'checks', '--run-id', 'copy'])
    expect(forked.code, JSON.stringify(forked.last) + forked.stderr).toBe(0)
    const copy = contextFile('copy')
    const reopened = await invoke(['resume', '--context', copy])
    expect(reopened.code, reopened.stderr).toBe(2)
    const copied = pending(reopened)[0]
    expect(copied).toMatchObject({ kind: 'host-task', value: { task: 'pr.checks' } })
    // LangGraph interrupt ids are deterministic per node task: hosts key a host task by (runId, interruptId).
    expect(copied.id).toBe(interrupt.id)
    expect((await invoke(['resume', '--context', copy, '--interrupt-id', copied.id, '--host-result', file('ok.json', { outcome: 'green' })])).code).toBe(0)
    expect((await invoke(['status', '--context', target, '--compact'])).last).toMatchObject({ state: { status: 'paused' } })
  })
})
