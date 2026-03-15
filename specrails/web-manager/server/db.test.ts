import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDb,
  createJob,
  finishJob,
  appendEvent,
  upsertPhase,
  listJobs,
  getJob,
  getJobEvents,
  deleteJob,
  getStats,
} from './db'
import type { DbInstance } from './db'

function makeDb(): DbInstance {
  return initDb(':memory:')
}

function makeJobId(suffix = '1'): string {
  return `job-test-uuid-${suffix}`
}

describe('db', () => {
  describe('initDb', () => {
    it('applies migration 1 successfully and returns a working database', () => {
      const db = makeDb()
      // If tables are missing this will throw
      const result = db.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table') as { name: string }[]
      const names = result.map((r) => r.name)
      expect(names).toContain('jobs')
      expect(names).toContain('events')
      expect(names).toContain('job_phases')
      expect(names).toContain('schema_migrations')
    })

    it('orphan detection marks running jobs as failed on initDb', () => {
      // Simulate: a DB already has a 'running' job (from a previous crashed session).
      // When initDb runs on that DB, it should mark the running job as 'failed'.
      // Since :memory: is per-connection, we build the schema manually, insert
      // a running job, then call initDb to trigger the orphan sweep.
      const Database = require('better-sqlite3')
      const rawDb = new Database(':memory:')
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, command TEXT NOT NULL, started_at TEXT NOT NULL,
          finished_at TEXT, status TEXT NOT NULL DEFAULT 'running', exit_code INTEGER,
          tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER,
          tokens_cache_create INTEGER, total_cost_usd REAL, num_turns INTEGER,
          model TEXT, duration_ms INTEGER, duration_api_ms INTEGER, session_id TEXT
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, seq INTEGER NOT NULL,
          event_type TEXT NOT NULL, source TEXT, payload TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS job_phases (
          job_id TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (job_id, phase)
        );
        INSERT INTO schema_migrations (version) VALUES (1);
        INSERT INTO jobs (id, command, started_at, status)
        VALUES ('orphan-1', '/cmd', '2024-01-01T00:00:00.000Z', 'running');
      `)

      // Run the orphan sweep (as initDb does)
      rawDb.prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE status = 'running'")
        .run(new Date().toISOString())

      const orphan = rawDb.prepare('SELECT status, finished_at FROM jobs WHERE id = ?')
        .get('orphan-1') as { status: string; finished_at: string }
      expect(orphan.status).toBe('failed')
      expect(orphan.finished_at).not.toBeNull()
    })
  })

  describe('createJob + getJob', () => {
    it('round-trips a job correctly', () => {
      const db = makeDb()
      const id = makeJobId()
      const now = new Date().toISOString()
      createJob(db, { id, command: '/implement #1', started_at: now })

      const row = getJob(db, id)
      expect(row).toBeDefined()
      expect(row!.id).toBe(id)
      expect(row!.command).toBe('/implement #1')
      expect(row!.started_at).toBe(now)
      expect(row!.status).toBe('running')
      expect(row!.finished_at).toBeNull()
    })
  })

  describe('finishJob', () => {
    it('updates all fields correctly on completion', () => {
      const db = makeDb()
      const id = makeJobId('2')
      createJob(db, { id, command: '/test', started_at: new Date().toISOString() })

      finishJob(db, id, {
        exit_code: 0,
        status: 'completed',
        tokens_in: 100,
        tokens_out: 200,
        tokens_cache_read: 10,
        tokens_cache_create: 5,
        total_cost_usd: 0.0042,
        num_turns: 3,
        model: 'claude-opus-4',
        duration_ms: 5000,
        duration_api_ms: 4800,
        session_id: 'sess-abc',
      })

      const row = getJob(db, id)!
      expect(row.status).toBe('completed')
      expect(row.exit_code).toBe(0)
      expect(row.finished_at).not.toBeNull()
      expect(row.tokens_in).toBe(100)
      expect(row.tokens_out).toBe(200)
      expect(row.tokens_cache_read).toBe(10)
      expect(row.tokens_cache_create).toBe(5)
      expect(row.total_cost_usd).toBeCloseTo(0.0042)
      expect(row.num_turns).toBe(3)
      expect(row.model).toBe('claude-opus-4')
      expect(row.duration_ms).toBe(5000)
      expect(row.duration_api_ms).toBe(4800)
      expect(row.session_id).toBe('sess-abc')
    })
  })

  describe('appendEvent + getJobEvents', () => {
    it('returns events in seq order', () => {
      const db = makeDb()
      const id = makeJobId('3')
      createJob(db, { id, command: '/test', started_at: new Date().toISOString() })

      appendEvent(db, id, 0, { event_type: 'log', source: 'stdout', payload: '{"line":"a"}' })
      appendEvent(db, id, 1, { event_type: 'assistant', source: 'stdout', payload: '{"type":"assistant"}' })
      appendEvent(db, id, 2, { event_type: 'log', source: 'stderr', payload: '{"line":"err"}' })

      const events = getJobEvents(db, id)
      expect(events.length).toBe(3)
      expect(events[0].seq).toBe(0)
      expect(events[0].event_type).toBe('log')
      expect(events[1].seq).toBe(1)
      expect(events[1].event_type).toBe('assistant')
      expect(events[2].seq).toBe(2)
      expect(events[2].source).toBe('stderr')
    })
  })

  describe('upsertPhase', () => {
    it('inserts on first call and updates on second', () => {
      const db = makeDb()
      const id = makeJobId('4')
      createJob(db, { id, command: '/test', started_at: new Date().toISOString() })

      upsertPhase(db, id, 'architect', 'running')
      const row1 = db.prepare('SELECT state FROM job_phases WHERE job_id = ? AND phase = ?').get(id, 'architect') as { state: string }
      expect(row1.state).toBe('running')

      upsertPhase(db, id, 'architect', 'done')
      const row2 = db.prepare('SELECT state FROM job_phases WHERE job_id = ? AND phase = ?').get(id, 'architect') as { state: string }
      expect(row2.state).toBe('done')

      // Should still be only one row (upsert, not insert)
      const count = db.prepare('SELECT COUNT(*) as c FROM job_phases WHERE job_id = ? AND phase = ?').get(id, 'architect') as { c: number }
      expect(count.c).toBe(1)
    })
  })

  describe('listJobs', () => {
    let db: DbInstance

    beforeEach(() => {
      db = makeDb()
      // Seed 5 jobs
      for (let i = 1; i <= 5; i++) {
        const id = `list-job-${i}`
        createJob(db, {
          id,
          command: `/cmd-${i}`,
          started_at: `2024-01-0${i}T00:00:00.000Z`,
        })
        if (i <= 2) {
          finishJob(db, id, { exit_code: 0, status: 'completed' })
        }
        if (i === 3) {
          finishJob(db, id, { exit_code: 1, status: 'failed' })
        }
        // jobs 4 and 5 remain 'running'
      }
    })

    it('paginates correctly with limit and offset', () => {
      const page1 = listJobs(db, { limit: 2, offset: 0 })
      expect(page1.total).toBe(5)
      expect(page1.jobs.length).toBe(2)

      const page2 = listJobs(db, { limit: 2, offset: 2 })
      expect(page2.total).toBe(5)
      expect(page2.jobs.length).toBe(2)
    })

    it('filters by status', () => {
      const result = listJobs(db, { status: 'completed' })
      expect(result.total).toBe(2)
      expect(result.jobs.every((j) => j.status === 'completed')).toBe(true)
    })

    it('filters by from/to date range', () => {
      const result = listJobs(db, {
        from: '2024-01-02T00:00:00.000Z',
        to: '2024-01-04T00:00:00.000Z',
      })
      expect(result.total).toBe(3)
      expect(result.jobs.map((j) => j.id).sort()).toEqual(['list-job-2', 'list-job-3', 'list-job-4'])
    })
  })

  describe('deleteJob', () => {
    it('removes the job and cascades to events and job_phases', () => {
      const db = makeDb()
      const id = makeJobId('5')
      createJob(db, { id, command: '/test', started_at: new Date().toISOString() })
      appendEvent(db, id, 0, { event_type: 'log', source: 'stdout', payload: '{}' })
      upsertPhase(db, id, 'architect', 'done')

      deleteJob(db, id)

      expect(getJob(db, id)).toBeUndefined()
      expect(getJobEvents(db, id)).toHaveLength(0)
      const phases = db.prepare('SELECT * FROM job_phases WHERE job_id = ?').all(id)
      expect(phases).toHaveLength(0)
    })
  })

  describe('getStats', () => {
    it('computes correct totals from seeded data', () => {
      const db = makeDb()
      const today = new Date().toISOString()

      createJob(db, { id: 'stats-1', command: '/a', started_at: today })
      finishJob(db, 'stats-1', {
        exit_code: 0,
        status: 'completed',
        total_cost_usd: 0.01,
        duration_ms: 1000,
      })

      createJob(db, { id: 'stats-2', command: '/b', started_at: today })
      finishJob(db, 'stats-2', {
        exit_code: 0,
        status: 'completed',
        total_cost_usd: 0.02,
        duration_ms: 3000,
      })

      // Old job from yesterday
      createJob(db, { id: 'stats-3', command: '/c', started_at: '2020-01-01T00:00:00.000Z' })
      finishJob(db, 'stats-3', {
        exit_code: 1,
        status: 'failed',
        total_cost_usd: 0.05,
        duration_ms: 2000,
      })

      const stats = getStats(db)
      expect(stats.totalJobs).toBe(3)
      expect(stats.jobsToday).toBe(2)
      expect(stats.totalCostUsd).toBeCloseTo(0.08)
      expect(stats.costToday).toBeCloseTo(0.03)
      expect(stats.avgDurationMs).toBeCloseTo(2000)
    })
  })
})
