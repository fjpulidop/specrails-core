import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, expect, it } from 'vitest'

/*
 * Quick SDD reference definition killed with SIGKILL at every node, through the
 * real CLI, real SQLite, pinned OpenSpec and host verification. Only the provider
 * is a deterministic local executor. Committed work is never repeated; an
 * interrupted write requires explicit recovery before it may run again.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = process.env.SPECRAILS_ENGINE_CLI ?? path.join(root, 'dist/agent-runtime/cli.js')
const fixtures = fileURLToPath(new URL('./__fixtures__/', import.meta.url))
const change = 'quick-change'
const directories: string[] = [], children = new Set<ChildProcess>()
type Message = Record<string, any>
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
afterAll(async () => {
  for (const child of children) {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true })
    else child.kill('SIGKILL')
  }
  await sleep(100)
  for (const directory of directories) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'quick sdd crash '))); directories.push(directory)
  const repository = path.join(directory, 'repository'), backlog = path.join(directory, 'backlog')
  mkdirSync(repository); mkdirSync(backlog)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  writeFileSync(path.join(repository, 'value.cjs'), 'module.exports = 1\n')
  const files = { context: path.join(directory, 'context.json'), config: path.join(directory, 'config.json'), calls: path.join(directory, 'calls.jsonl') }
  writeFileSync(files.context, JSON.stringify({ schemaVersion: 1, runId: 'quick-crash', backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo',
    repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 1, title: 'Return two', description: 'value.cjs returns two' }] }))
  const role = { provider: 'fixture' }
  // Declared like any CLI provider; the test preloader supplies its executor.
  writeFileSync(files.config, JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'fixture', kind: 'cli', cli: 'claude' }], agents: { architect: role, developer: role, reviewer: role },
    verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./value.cjs")!==2)process.exit(1)'] }] }))
  const launch = (args: string[], crash?: string) => {
    const preloads = [path.join(fixtures, 'robustness/quick-sdd-executor.mjs'), ...(crash ? [path.join(fixtures, 'robustness/crash-preload.mjs')] : [])]
    const child = spawn(process.execPath, [...preloads.flatMap(file => ['--import', pathToFileURL(file).href]), cli, ...args], {
      cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', SPECRAILS_ENGINE_CLI: cli, SPECRAILS_ENGINE_CRASH_AT: crash ?? '', SPECRAILS_QUICK_SDD_CALLS: files.calls, SPECRAILS_QUICK_SDD_CHANGE: change, SPECRAILS_GIT_AUTO: 'false' },
    })
    children.add(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += String(data) })
    child.stderr.on('data', data => { stderr += String(data) })
    return new Promise<{ code: number | null; signal: string | null; last: Message; stderr: string }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        children.delete(child)
        const lines = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Message)
        resolve({ code, signal, last: lines.at(-1) ?? {}, stderr })
      })
    })
  }
  const invoke = (args: string[], crash?: string) => launch(args, crash)
  return {
    repository, files,
    start: (crash?: string) => invoke(['run', '--context', files.context, '--config', files.config, '--definition', path.join(fixtures, 'quick-sdd.json'), '--change', change], crash),
    status: () => invoke(['status', '--context', files.context, '--compact']),
    resume: (args: string[] = []) => invoke(['resume', '--context', files.context, ...args]),
    calls: () => existsSync(files.calls) ? readFileSync(files.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line).command as string) : [],
  }
}
async function afterLease(f: ReturnType<typeof fixture>) {
  const lease = (await f.status()).last.state.lease
  expect(lease.active).toBe(true)
  // Real production TTL: no clock patch, private SQL update or shortened lease.
  await sleep(Math.max(0, Number(lease.expiresAt) - Date.now() + 100))
}
function expectDelivered(f: ReturnType<typeof fixture>) {
  expect(readFileSync(path.join(f.repository, 'value.cjs'), 'utf8')).toBe('module.exports = 2\n')
  expect(existsSync(path.join(f.repository, 'openspec/changes', change))).toBe(false)
  expect(readdirSync(path.join(f.repository, 'openspec/changes/archive')).filter(name => name.endsWith('-' + change))).toHaveLength(1)
}

it.concurrent.each(['init', 'work', 'validate', 'apply', 'check', 'archive', 'verify'])('recovers Quick SDD killed after committing %s without repeating committed work', async node => {
  const f = fixture(), crashed = await f.start(node + ':after-writes')
  expect(crashed.stderr, JSON.stringify(crashed.last)).toContain(`engine-test-crash ${node}:after-writes`)
  if (process.platform !== 'win32') expect(crashed.signal).toBe('SIGKILL')
  else expect(crashed.code).not.toBe(0)
  await afterLease(f)
  const resumed = await f.resume()
  expect(resumed.code, JSON.stringify(resumed.last) + resumed.stderr).toBe(0)
  expect(resumed.last).toMatchObject({ status: 'succeeded', completion: { ok: true, verified: true } })
  expect(f.calls()).toEqual(['opsx:ff', 'opsx:apply'])
  expectDelivered(f)
}, 150_000)

it.concurrent('requires explicit recovery for an apply write interrupted mid-invocation', async () => {
  const f = fixture(), crashed = await f.start('apply:during')
  expect(crashed.stderr).toContain('engine-test-crash apply:during')
  await afterLease(f)
  const refused = await f.resume()
  expect(refused.last.error).toMatchObject({ code: 'recover_required' })
  expect(f.calls()).toEqual(['opsx:ff', 'opsx:apply'])
  const recoverable = (await f.status()).last.state.recoverableSteps.find((step: Message) => step.nodePath === 'apply')
  expect(recoverable).toBeDefined()
  const resumed = await f.resume(['--recover', recoverable.attemptId])
  expect(resumed.code, JSON.stringify(resumed.last) + resumed.stderr).toBe(0)
  expect(resumed.last).toMatchObject({ status: 'succeeded', completion: { ok: true, verified: true } })
  const { RunDatabase } = await import('./checkpoint/database.js')
  const database = await RunDatabase.open(path.join(path.dirname(f.files.context), 'backlog/.specrails/pipeline/quick-crash/agent-workflow/run.sqlite'), { readOnly: true })
  try {
    // The provider call had completed and was durably recorded before the kill;
    // the authorized recovery attempt settles from that record instead of paying
    // for a second call. The interrupted attempt stays visible as interrupted.
    expect(database.sqlite.prepare("SELECT node_path, status FROM attempts WHERE node_path='apply' ORDER BY rowid").all()).toEqual([
      { node_path: 'apply', status: 'interrupted' }, { node_path: 'apply', status: 'succeeded' }])
    expect(database.sqlite.prepare('SELECT node_path, status FROM invocations ORDER BY rowid').all()).toEqual([
      { node_path: 'work', status: 'succeeded' }, { node_path: 'apply', status: 'succeeded' }])
  } finally { database.close() }
  expect(f.calls()).toEqual(['opsx:ff', 'opsx:apply'])
  expectDelivered(f)
}, 150_000)
