import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { RunLedger } from './ledger.js'
import { RunLease } from './lease.js'
import { RunDatabase } from './database.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('production SQLite recovery after process death', () => {
  it('retains unknown provider usage and reservations after a killed started invocation, including forks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'engine invocation crash ')); roots.push(root)
    const filename = path.join(root, 'run.sqlite'), worker = fileURLToPath(new URL('./__fixtures__/crash-worker.mjs', import.meta.url)), clock = Date.now() - 120_000
    const crashed = spawnSync(process.execPath, [worker, filename, 'provider-started', String(clock)], { encoding: 'utf8', timeout: 30_000 })
    expect(crashed.error).toBeUndefined()
    expect(JSON.parse(readFileSync(filename + '.fault', 'utf8')).at).toBe('provider-started')
    expect(existsSync(filename + '.kill-failed')).toBe(false); expect(existsSync(filename + '.cleanup')).toBe(false)
    if (process.platform !== 'win32') expect(crashed.signal).toBe('SIGKILL')
    else expect(crashed.status).not.toBe(0)
    const source = await RunDatabase.open(filename, { readOnly: true }), fork = await RunDatabase.open(path.join(root, 'fork', 'run.sqlite'), { create: true })
    try {
      const ledger = new RunLedger(source, { runId: 'crash', owner: 'observer', epoch: -1, expiresAt: 0 }, { maxTransitions: 2 })
      expect(ledger.usage()).toMatchObject({ costUsd: null, inputTokens: null, outputTokens: null, knownCostUsd: 0, knownInputTokens: 0 })
      expect(ledger.reservationStatus()).toMatchObject({ pendingInvocations: 1, knownTokens: 10, costUnknown: true })
      source.forkAt(fork, { revision: source.revision, runId: 'fork' })
      const token = new RunLease(fork, 'fork').acquire('fork-owner'), copied = new RunLedger(fork, token, { maxTransitions: 2 })
      expect(copied.usage()).toMatchObject({ costUsd: null, inputTokens: null, outputTokens: null })
      expect(copied.reservationStatus().knownTokens).toBe(10)
    } finally { fork.close(); source.close() }
    const retry = spawnSync(process.execPath, [worker, filename, 'reserve-after-crash', String(clock + 60_001)], { encoding: 'utf8', timeout: 30_000 })
    expect(retry.status).not.toBe(0)
    expect(retry.stderr).toContain('shared budget')
  })

  it.each(['before-effect', 'before-writes', 'between-writes-ledger', 'after-writes', 'after-snapshot'])('recovers %s without losing or repeating committed work', async phase => {
    const root = await mkdtemp(path.join(tmpdir(), 'engine durable crash ')); roots.push(root)
    const filename = path.join(root, 'run.sqlite'), worker = fileURLToPath(new URL('./__fixtures__/crash-worker.mjs', import.meta.url)), clock = Date.now()
    const crashed = spawnSync(process.execPath, [worker, filename, phase, String(clock)], { encoding: 'utf8', timeout: 30_000 })
    expect(crashed.error).toBeUndefined()
    expect(existsSync(filename + '.fault')).toBe(true)
    expect(JSON.parse(readFileSync(filename + '.fault', 'utf8')).at).toBe(phase)
    expect(existsSync(filename + '.kill-failed')).toBe(false)
    expect(existsSync(filename + '.cleanup')).toBe(false)
    if (process.platform !== 'win32') expect(crashed.signal).toBe('SIGKILL')
    else expect(crashed.status).not.toBe(0)
    const resumed = spawnSync(process.execPath, [worker, filename, 'none', String(clock + 60_001)], { encoding: 'utf8', timeout: 30_000 })
    expect(resumed.status, resumed.stderr).toBe(0)
    const db = await RunDatabase.open(filename)
    try {
      const calls = db.sqlite.prepare('SELECT node,COUNT(*) count FROM fixture_physical_calls GROUP BY node ORDER BY node').all()
      expect(calls).toEqual([{ node: 'one', count: phase === 'before-writes' || phase === 'between-writes-ledger' ? 2 : 1 }, { node: 'two', count: 1 }])
      expect(db.sqlite.prepare("SELECT COUNT(*) count FROM attempts WHERE status='succeeded'").get()?.count).toBe(2)
      expect(db.sqlite.prepare("SELECT COUNT(*) count FROM events WHERE type='step_succeeded'").get()?.count).toBe(2)
      db.checkIntegrity()
    } finally { db.close() }
  })
})
