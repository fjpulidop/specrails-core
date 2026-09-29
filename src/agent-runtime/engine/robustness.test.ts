import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = process.env.SPECRAILS_ENGINE_CLI ?? path.join(root, 'dist/agent-runtime/cli.js')
const fixtures = fileURLToPath(new URL('./__fixtures__/robustness/', import.meta.url))
const directories: string[] = [], children = new Set<ChildProcess>()
type Message = Record<string, any>
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function launch(directory: string, args: string[], crash?: string, input?: string) {
  const child = spawn(process.execPath, [...(crash ? ['--import', pathToFileURL(path.join(fixtures, 'crash-preload.mjs')).href] : []), cli, ...args], {
    cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', SPECRAILS_ENGINE_CLI: cli, SPECRAILS_ENGINE_CRASH_AT: crash ?? '' },
  })
  children.add(child)
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += String(data) })
  child.stderr.on('data', data => { stderr += String(data) })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  const result = new Promise<{ code: number | null; signal: string | null; lines: Message[]; last: Message; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      children.delete(child)
      try {
        const raw = stdout.split('\n').filter(line => line.trim())
        for (const line of raw) expect(line.length).toBeLessThan(1_000_000)
        const lines = raw.map(line => JSON.parse(line) as Message)
        resolve({ code, signal, lines, last: lines.at(-1) ?? {}, stderr })
      } catch (error) { reject(error) }
    })
  })
  return { child, result }
}
async function fixture(sleepMs = 0, bytes = 0) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'engine cli robustness '))); directories.push(directory)
  const repo = path.join(directory, 'repo'), markers = path.join(directory, 'markers'), backlog = path.join(directory, 'backlog')
  for (const item of [repo, markers, backlog]) mkdirSync(item)
  const git = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  expect(git.status, git.stderr).toBe(0)
  const substitutions: Record<string, string> = { __NODE__: process.execPath, __MARKER__: path.join(fixtures, 'marker.mjs'), __MARKERS__: markers, __SLEEP_MS__: String(sleepMs), __BIG_BYTES__: String(bytes) }
  const draft = JSON.parse(readFileSync(path.join(fixtures, 'thirty-node.json'), 'utf8'), (_key, value) => typeof value === 'string' && value in substitutions ? substitutions[value] : value)
  expect(Object.keys(draft.nodes)).toHaveLength(30)
  const validate = await launch(directory, ['workflows', 'validate', '--stdin'], undefined, JSON.stringify(draft)).result
  expect(validate.code, JSON.stringify(validate.last) + validate.stderr).toBe(0)
  const context = { schemaVersion: 1, runId: 'robustness', backlogRoot: backlog, artifactRoot: repo, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: repo }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 'case', title: 'Robustness', description: 'Provider-free fault recovery' }] }
  const files = { context: path.join(directory, 'context.json'), definition: path.join(directory, 'definition.json'), config: path.join(directory, 'config.json') }
  writeFileSync(files.context, JSON.stringify(context)); writeFileSync(files.definition, JSON.stringify(validate.last.definition))
  writeFileSync(files.config, readFileSync(path.join(fixtures, '../acceptance/runtime-config.json')))
  const invoke = (args: string[], crash?: string) => launch(directory, args, crash)
  const start = (crash?: string) => invoke(['run', '--context', files.context, '--config', files.config, '--definition', files.definition], crash)
  const status = () => invoke(['status', '--context', files.context, '--compact']).result
  const resume = (args: string[] = []) => invoke(['resume', '--context', files.context, ...args]).result
  return { directory, markers, files, draft, invoke, start, status, resume }
}
async function until(predicate: () => boolean, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture process did not reach its boundary'); await sleep(50) }
}
afterAll(async () => {
  for (const child of children) {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true })
    else child.kill('SIGKILL')
  }
  await sleep(100)
  for (const directory of directories) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

it.concurrent.each(['before', 'during', 'after-writes', 'after-snapshot'])('recovers the real thirty-node CLI after SIGKILL %s', async phase => {
  const f = await fixture(), crashed = await f.start('s10:' + phase).result
  expect(crashed.stderr).toContain('engine-test-crash s10:' + phase)
  if (process.platform !== 'win32') expect(crashed.signal).toBe('SIGKILL')
  else expect(crashed.code).not.toBe(0)
  const status = await f.status(), lease = status.last.state.lease
  expect(lease.active).toBe(true)
  const early = await f.resume()
  expect(early.last.error).toMatchObject({ code: 'lease_held' })
  // Real production TTL: no clock patches, private SQL updates or shortened lease.
  await sleep(Math.max(0, Number(lease.expiresAt) - Date.now() + 100))
  const inactive = await f.status()
  expect(inactive.last.state.lease.active).toBe(false)
  let resumed = await f.resume()
  if (phase === 'before' || phase === 'during') {
    expect(resumed.last.error).toMatchObject({ code: 'recover_required' })
    const interrupted = await f.status()
    const recoverable = interrupted.last.state.recoverableSteps.find((step: Message) => step.nodePath === 's10')
    expect(recoverable).toBeDefined()
    resumed = await f.resume(['--recover', recoverable.attemptId])
  }
  expect(resumed.code, JSON.stringify(resumed.last) + resumed.stderr).toBe(2)
  const done = await f.resume(['--answer', 'continue'])
  expect(done.code, JSON.stringify(done.last) + done.stderr).toBe(0)
  expect(done.last).toMatchObject({ status: 'succeeded', completion: { ok: true }, usage: { costUsd: 0 } })
  for (const [name, node] of Object.entries(f.draft.nodes) as [string, { kind: string }][]) if (node.kind === 'shell') {
    // An explicitly recovered uncertain effect may repeat; committed effects never do.
    expect(readFileSync(path.join(f.markers, name), 'utf8'), name).toBe('x'.repeat(name === 's10' && phase === 'during' ? 2 : 1))
  }
}, 180_000)

it('bounds more than 2 MiB of shell output and preserves the durable result', async () => {
  const f = await fixture(0, 2_200_000), paused = await f.start().result
  expect(paused.code, JSON.stringify(paused.last) + paused.stderr).toBe(2)
  expect(paused.lines.some(line => line.type === 'verification-output')).toBe(true)
  expect((await f.resume(['--answer', 'continue'])).code).toBe(0)
}, 90_000)

it.each(['cancel', ...(process.platform === 'win32' ? [] : ['SIGTERM'])])('cancels a live CLI with %s and leaves no shell child', async mode => {
  const f = await fixture(60_000), running = f.start()
  const pidFile = path.join(f.markers, 'sleep.pid')
  await until(() => existsSync(pidFile))
  const competing = await f.resume()
  expect(competing.last.error).toMatchObject({ code: 'lease_held' })
  if (mode === 'SIGTERM') running.child.kill('SIGTERM')
  else {
    const accepted = await f.invoke(['cancel', '--context', f.files.context, '--request-id', 'cancel-once']).result
    expect(accepted.code, JSON.stringify(accepted.last)).toBe(0)
  }
  const cancelled = await running.result
  expect(cancelled.last, cancelled.stderr).toMatchObject({ status: 'cancelled' })
  const pid = Number(readFileSync(pidFile, 'utf8'))
  await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 5000)
  expect((await f.status()).last.state).toMatchObject({ status: 'cancelled', lease: null })
  expect((await f.resume()).last.status).toBe('cancelled')
  const fork = await f.invoke(['fork', '--context', f.files.context, '--from', 'sleep', '--run-id', 'cancelled-copy']).result
  expect(fork.code, JSON.stringify(fork.last) + fork.stderr).toBe(0)
}, 90_000)
