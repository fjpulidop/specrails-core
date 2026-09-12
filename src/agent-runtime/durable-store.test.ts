import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireWorkflowLease, fingerprint, readWorkflowState, writeWorkflowState } from './durable-store.js'

import type { WorkflowState } from './workflow-types.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

function checkpoint(): WorkflowState {
  return {
    schemaVersion: 2, runId: 'run', traceId: 'trace', workflowId: 'test', workflowVersion: '1',
    workflowFingerprint: 'workflow', inputFingerprint: 'input', status: 'running',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    nextStep: null, nextAttempt: 1, transitions: 0, executionCount: 0,
    steps: {}, history: [], events: [], budget: {},
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, knownCostUsd: 0, knownTokens: 0, durationMs: 0 },
  }
}

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'specrails-store-')) })
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(rename).mockReset(); await rm(directory, { recursive: true, force: true }) })

describe('portable durable workflow storage', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries transient Windows %s errors without losing the checkpoint', async code => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const state = checkpoint()
    await writeWorkflowState(directory, state)
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Sharing violation'), { code }))
    const updated = { ...state, status: 'succeeded' as const }
    await writeWorkflowState(directory, updated)
    expect(await readWorkflowState(directory, 'run')).toEqual(updated)
    expect(await readdir(join(directory, 'run'))).toEqual(['checkpoint.json'])
  })

  it('preserves the previous checkpoint and removes the temporary file when Windows retries are exhausted', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const state = checkpoint()
    await writeWorkflowState(directory, state)
    const error = Object.assign(new Error('Sharing violation'), { code: 'EPERM' })
    vi.mocked(rename).mockRejectedValue(error)
    await expect(writeWorkflowState(directory, { ...state, status: 'succeeded' })).rejects.toBe(error)
    expect(await readWorkflowState(directory, 'run')).toEqual(state)
    expect(await readdir(join(directory, 'run'))).toEqual(['checkpoint.json'])
  })

  it('grants one owner, refuses a live owner, and permits a later owner', async () => {
    const release = await acquireWorkflowLease(directory, 'run')
    await expect(acquireWorkflowLease(directory, 'run')).rejects.toMatchObject({ code: 'LOCKED' })
    await release()
    const releaseNext = await acquireWorkflowLease(directory, 'run')
    await releaseNext()
  })

  it('elects exactly one new owner for a stale local lease under contention', async () => {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    expect(child.status).toBe(0)
    const lease = join(directory, 'run', '.lease')
    await mkdir(lease, { recursive: true })
    await writeFile(join(lease, 'owner.json'), JSON.stringify({ pid: child.pid, hostname: hostname(), token: 'dead-owner' }))
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireWorkflowLease(directory, 'run')))
    const owners = results.filter(result => result.status === 'fulfilled')
    expect(owners).toHaveLength(1)
    for (const owner of owners) if (owner.status === 'fulfilled') await owner.value()
  })

  it.each(['remote', 'missing', 'malformed', 'recovery'])('fails closed for %s ownership', async kind => {
    const lease = join(directory, 'run', '.lease')
    await mkdir(lease, { recursive: true })
    if (kind === 'remote') await writeFile(join(lease, 'owner.json'), JSON.stringify({ pid: 1, hostname: 'another-host', token: 'remote' }))
    if (kind === 'malformed') await writeFile(join(lease, 'owner.json'), '{')
    if (kind === 'recovery') await mkdir(join(directory, 'run', '.lease-recovery'))
    await expect(acquireWorkflowLease(directory, 'run')).rejects.toMatchObject({ code: 'LOCKED' })
  })

  it('does not release a lease that has acquired a different ownership token', async () => {
    const release = await acquireWorkflowLease(directory, 'run')
    const ownerPath = join(directory, 'run', '.lease', 'owner.json')
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token: string }
    owner.token = 'replacement'
    await writeFile(ownerPath, JSON.stringify(owner))
    await release()
    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toMatchObject({ token: 'replacement' })
  })

  it('rejects path traversal, drive paths and separators in run IDs', async () => {
    for (const id of ['../run', '..', 'C:\\temp', '/tmp/run', 'run/sub', 'run\\sub', '', 'CON', 'nul.json', 'COM1', 'LPT9.log', 'trailing.']) {
      await expect(acquireWorkflowLease(directory, id)).rejects.toMatchObject({ code: 'INVALID_ID' })
      await expect(readWorkflowState(directory, id)).rejects.toMatchObject({ code: 'INVALID_ID' })
    }
  })

  it('fingerprints JSON canonically and rejects silently lossy values', () => {
    expect(fingerprint({ z: [1, { b: 2, a: 3 }], a: false })).toBe(fingerprint({ a: false, z: [1, { a: 3, b: 2 }] }))
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), 1n, () => null, cycle]) {
      expect(() => fingerprint(value)).toThrow('JSON')
    }
  })

  it('reports malformed checkpoint JSON', async () => {
    await mkdir(join(directory, 'run'))
    await writeFile(join(directory, 'run', 'checkpoint.json'), '{')
    await expect(readWorkflowState(directory, 'run')).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
  })
})
