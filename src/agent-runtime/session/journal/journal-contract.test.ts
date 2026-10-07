import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SessionError } from '../domain/errors.js'
import type { SessionEvent } from '../domain/events.js'
import { DEFAULT_LIMITS } from '../domain/policy.js'
import { EMPTY_USAGE, type SessionPolicy } from '../domain/types.js'
import type { SessionJournal } from '../ports.js'
import { MemoryJournal } from '../testing/memory-journal.js'
import { SqliteSessionJournal } from './sqlite-journal.js'

/**
 * One behavioural contract for every SessionJournal implementation. The
 * in-memory double used by application tests must behave like production.
 */
const roots: string[] = []
const open: SqliteSessionJournal[] = []
afterEach(async () => {
  for (const journal of open.splice(0)) journal.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const policy: SessionPolicy = { subagents: 'enabled', onSubagentsSettled: 'provider-native', tools: { mode: 'default' }, permissions: 'bypass', mcp: { servers: [], inheritUserScope: false }, limits: DEFAULT_LIMITS }
const at = '2026-10-07T10:00:00.000Z'
const opened: SessionEvent = { type: 'session.opened', driver: 'claude', model: 'haiku', policy, resumed: false, providerSessionRef: null, at }

const implementations: Array<[string, () => Promise<SessionJournal>]> = [
  ['memory', async () => new MemoryJournal()],
  ['sqlite', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session journal ')); roots.push(root)
    const journal = await SqliteSessionJournal.open({ scope: 'contract', owner: 'test', home: root, heartbeat: false })
    open.push(journal)
    return journal
  }],
]

describe.each(implementations)('SessionJournal contract (%s)', (_name, make) => {
  async function withSession() {
    const journal = await make()
    journal.createSession({ sessionId: 's1', driver: 'claude', cwd: '/repo', createdAt: at, metadata: { conversationId: 'c1' } })
    return journal
  }

  it('assigns gap-free sequences and folds the snapshot atomically', async () => {
    const journal = await withSession()
    const first = journal.append('s1', [opened, { type: 'session.phase', phase: 'turn', at }])
    const second = journal.append('s1', [{ type: 'turn.started', turnId: 't1', origin: 'user', inputIds: [], at }])
    expect([...first, ...second].map((envelope) => envelope.seq)).toEqual([1, 2, 3])
    expect(journal.snapshot('s1')).toMatchObject({ lastSeq: 3, driver: 'claude', phase: 'turn', openTurn: { turnId: 't1' } })
    expect(journal.getSession('s1')).toEqual({ sessionId: 's1', driver: 'claude', cwd: '/repo', createdAt: at, metadata: { conversationId: 'c1' } })
  })

  it('rejects an unfoldable batch without making any of it visible', async () => {
    const journal = await withSession()
    journal.append('s1', [opened])
    expect(() => journal.append('s1', [
      { type: 'session.phase', phase: 'turn', at },
      { type: 'turn.completed', turnId: 'nope', status: 'completed', text: '', usage: EMPTY_USAGE, at },
    ])).toThrow(SessionError)
    expect(journal.snapshot('s1')?.lastSeq).toBe(1)
    expect(journal.read('s1', 0, 10).events).toHaveLength(1)
    // The journal keeps working after a rejected batch.
    expect(journal.append('s1', [{ type: 'session.phase', phase: 'turn', at }])[0]?.seq).toBe(2)
  })

  it('pages events after a cursor', async () => {
    const journal = await withSession()
    journal.append('s1', [opened, ...Array.from({ length: 4 }, () => ({ type: 'provider.diagnostic' as const, level: 'info' as const, code: 'x', message: 'y', at }))])
    expect(journal.read('s1', 0, 2)).toMatchObject({ hasMore: true, events: [{ seq: 1 }, { seq: 2 }] })
    expect(journal.read('s1', 4, 2)).toMatchObject({ hasMore: false, events: [{ seq: 5 }] })
    expect(journal.read('s1', 5, 2)).toEqual({ events: [], hasMore: false })
  })

  it('stores usage baselines with their events', async () => {
    const journal = await withSession()
    expect(journal.baseline('prov-1')).toBeNull()
    journal.append('s1', [opened], { baseline: { providerRef: 'prov-1', value: { costUsd: 0.5, inputTokens: null, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null } } })
    expect(journal.baseline('prov-1')).toMatchObject({ costUsd: 0.5, outputTokens: 1 })
  })

  it('lists sessions by status and returns snapshots that callers cannot mutate', async () => {
    const journal = await withSession()
    journal.append('s1', [opened])
    journal.createSession({ sessionId: 's2', driver: 'codex', cwd: '/r2', createdAt: at, metadata: {} })
    journal.append('s2', [{ ...opened, driver: 'codex' }, { type: 'session.closed', reason: 'deleted', at }])
    expect(journal.list('open').map((summary) => summary.sessionId)).toEqual(['s1'])
    expect(journal.list('closed').map((summary) => summary.sessionId)).toEqual(['s2'])
    expect(journal.list('all')).toHaveLength(2)
    const snapshot = journal.snapshot('s1')!
    snapshot.model = 'mutated'
    expect(journal.snapshot('s1')?.model).toBe('haiku')
  })

  it('refuses duplicate sessions and unknown sessions', async () => {
    const journal = await withSession()
    expect(() => journal.createSession({ sessionId: 's1', driver: 'x', cwd: '/', createdAt: at, metadata: {} })).toThrow()
    expect(() => journal.append('ghost', [opened])).toThrow()
    expect(journal.snapshot('ghost')).toBeNull()
    expect(journal.getSession('ghost')).toBeNull()
  })
})
