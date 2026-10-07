import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionEvent } from '../domain/events.js'
import { DEFAULT_LIMITS } from '../domain/policy.js'
import type { SessionPolicy } from '../domain/types.js'
import { JOURNAL_FILENAME, SqliteSessionJournal } from './sqlite-journal.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function home(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'session journal ')); roots.push(root)
  return root
}

const policy: SessionPolicy = { subagents: 'enabled', subagentRuntime: { mode: 'native' as const }, onSubagentsSettled: 'provider-native', tools: { mode: 'default' }, permissions: 'bypass', mcp: { servers: [], inheritUserScope: false }, limits: DEFAULT_LIMITS }
const at = '2026-10-07T10:00:00.000Z'
const opened: SessionEvent = { type: 'session.opened', driver: 'claude', model: 'haiku', policy, resumed: false, providerSessionRef: null, at }

describe('SqliteSessionJournal', () => {
  it('lives under ~/.specrails/sessions/<scope>/ with private permissions', async () => {
    const root = await home()
    const journal = await SqliteSessionJournal.open({ scope: 'my-project', owner: 'host-a', home: root, heartbeat: false })
    try {
      expect(journal.filename).toBe(path.join(await import('node:fs').then((fs) => fs.realpathSync(root)), '.specrails', 'sessions', 'my-project', JOURNAL_FILENAME))
      if (process.platform !== 'win32') {
        expect(statSync(path.dirname(journal.filename)).mode & 0o777).toBe(0o700)
        expect(statSync(journal.filename).mode & 0o777).toBe(0o600)
      }
      journal.checkIntegrity()
    } finally { journal.close() }
  })

  it('persists sessions, snapshots and baselines across reopen', async () => {
    const root = await home()
    const first = await SqliteSessionJournal.open({ scope: 'p', owner: 'host-a', home: root, heartbeat: false })
    first.createSession({ sessionId: 's1', driver: 'claude', cwd: '/repo', createdAt: at, metadata: {} })
    first.append('s1', [opened, { type: 'session.provider-ref', providerSessionRef: 'prov', at }], { baseline: { providerRef: 'prov', value: { costUsd: 0.07, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } })
    first.close()
    const second = await SqliteSessionJournal.open({ scope: 'p', owner: 'host-b', home: root, heartbeat: false })
    try {
      expect(second.lease.previous).toBe('released')
      expect(second.lease.epoch).toBe(2)
      expect(second.snapshot('s1')).toMatchObject({ lastSeq: 2, providerSessionRef: 'prov' })
      expect(second.baseline('prov')?.costUsd).toBe(0.07)
      expect(second.append('s1', [{ type: 'session.phase', phase: 'turn', at }])[0]?.seq).toBe(3)
    } finally { second.close() }
  })

  it('allows one live host per scope and fences a stale owner after expiry', async () => {
    const root = await home()
    let clock = Date.UTC(2026, 9, 7)
    const now = () => clock
    const owner = await SqliteSessionJournal.open({ scope: 'p', owner: 'host-a', home: root, now, heartbeat: false })
    owner.createSession({ sessionId: 's1', driver: 'claude', cwd: '/r', createdAt: at, metadata: {} })
    await expect(SqliteSessionJournal.open({ scope: 'p', owner: 'host-b', home: root, now, heartbeat: false })).rejects.toMatchObject({ code: 'journal_locked' })

    clock += 60_001
    const successor = await SqliteSessionJournal.open({ scope: 'p', owner: 'host-b', home: root, now, heartbeat: false })
    try {
      expect(successor.lease).toMatchObject({ epoch: 2, previous: 'lost' })
      expect(() => owner.append('s1', [opened])).toThrow(expect.objectContaining({ code: 'journal_locked' }))
      expect(() => owner.renew()).toThrow(expect.objectContaining({ code: 'journal_locked' }))
      expect(successor.append('s1', [opened])[0]?.seq).toBe(1)
    } finally {
      successor.close()
      owner.close()
    }
  })

  it('renews the lease so a live owner keeps the scope', async () => {
    const root = await home()
    let clock = Date.UTC(2026, 9, 7)
    const owner = await SqliteSessionJournal.open({ scope: 'p', owner: 'host-a', home: root, now: () => clock, heartbeat: false })
    try {
      clock += 45_000
      owner.renew()
      clock += 45_000
      await expect(SqliteSessionJournal.open({ scope: 'p', owner: 'host-b', home: root, now: () => clock, heartbeat: false })).rejects.toMatchObject({ code: 'journal_locked' })
    } finally { owner.close() }
  })

  it('refuses a journal written by a newer schema without modifying it', async () => {
    const root = await home()
    const journal = await SqliteSessionJournal.open({ scope: 'p', owner: 'a', home: root, heartbeat: false })
    const filename = journal.filename
    journal.close()
    const raw = new DatabaseSync(filename)
    raw.exec('PRAGMA user_version=99')
    raw.close()
    await expect(SqliteSessionJournal.open({ scope: 'p', owner: 'b', home: root, heartbeat: false })).rejects.toMatchObject({ code: 'store_incompatible' })
    const check = new DatabaseSync(filename)
    expect(Number(check.prepare('PRAGMA user_version').get()?.user_version)).toBe(99)
    check.close()
  })

  it('sweeps only closed sessions older than the retention window', async () => {
    const root = await home()
    const journal = await SqliteSessionJournal.open({ scope: 'p', owner: 'a', home: root, heartbeat: false })
    try {
      for (const id of ['old-closed', 'old-open', 'new-closed']) {
        journal.createSession({ sessionId: id, driver: 'claude', cwd: '/', createdAt: at, metadata: {} })
      }
      journal.append('old-closed', [opened, { type: 'session.closed', reason: 'deleted', at }])
      journal.append('old-open', [opened])
      journal.append('new-closed', [{ ...opened, at: '2026-12-01T00:00:00.000Z' }, { type: 'session.closed', reason: 'deleted', at: '2026-12-01T00:00:00.000Z' }])
      expect(journal.sweepClosed(Date.UTC(2026, 10, 1))).toBe(1)
      expect(journal.list('all').map((summary) => summary.sessionId).sort()).toEqual(['new-closed', 'old-open'])
      expect(journal.read('old-closed', 0, 10).events).toEqual([])
    } finally { journal.close() }
  })

  it('rejects unsafe scopes before touching the filesystem', async () => {
    const root = await home()
    await expect(SqliteSessionJournal.open({ scope: '../escape', owner: 'a', home: root, heartbeat: false })).rejects.toThrow(/Invalid session scope/)
    expect(existsSync(path.join(root, '.specrails'))).toBe(false)
  })
})

describe('SqliteSessionJournal after process death', () => {
  const worker = fileURLToPath(new URL('./__fixtures__/journal-crash-worker.mjs', import.meta.url))
  const built = existsSync(fileURLToPath(new URL('../../../../dist/agent-runtime/session/journal/sqlite-journal.js', import.meta.url)))

  it.skipIf(!built)('keeps every committed batch whole and replays nothing twice', async () => {
    const root = await home()
    const crashed = spawnSync(process.execPath, [worker, root], { encoding: 'utf8', timeout: 30_000 })
    expect(crashed.error).toBeUndefined()
    if (process.platform !== 'win32') expect(crashed.signal).toBe('SIGKILL')
    else expect(crashed.status).not.toBe(0)

    // The killed owner never released its lease: a successor sees it as lost once it expires.
    const journal = await SqliteSessionJournal.open({ scope: 'crash', owner: 'successor', home: root, now: () => Date.now() + 61_000, heartbeat: false })
    try {
      expect(journal.lease.previous).toBe('lost')
      journal.checkIntegrity()
      const events = journal.read('s1', 0, 10_000).events
      // Batches are 3 events each; the batch in flight at SIGKILL is all-or-nothing.
      expect(events.length % 3).toBe(0)
      expect(events.map((envelope) => envelope.seq)).toEqual(events.map((_, index) => index + 1))
      expect(journal.snapshot('s1')?.lastSeq).toBe(events.length)
    } finally { journal.close() }
  })
})
