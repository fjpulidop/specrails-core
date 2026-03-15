import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock config module for endpoint tests
vi.mock('./config', () => ({
  getConfig: vi.fn().mockReturnValue({
    project: { name: 'test-project', repo: 'owner/test-project' },
    issueTracker: {
      github: { available: true, authenticated: true },
      jira: { available: false, authenticated: false },
      active: 'github',
      labelFilter: '',
    },
    commands: [
      { id: 'implement', name: 'Implement', description: 'Implement a feature', slug: 'implement' },
    ],
  }),
  fetchIssues: vi.fn().mockReturnValue([
    { number: 1, title: 'Test issue', labels: ['bug'], body: 'Description', url: 'https://github.com/...' },
  ]),
}))

// Mock QueueManager so routes are tested without spawning real processes
vi.mock('./queue-manager', async () => {
  const ClaudeNotFoundError = class extends Error {
    constructor() {
      super('claude binary not found')
      this.name = 'ClaudeNotFoundError'
    }
  }
  const JobNotFoundError = class extends Error {
    constructor() {
      super('Job not found')
      this.name = 'JobNotFoundError'
    }
  }
  const JobAlreadyTerminalError = class extends Error {
    constructor() {
      super('Job is already in terminal state')
      this.name = 'JobAlreadyTerminalError'
    }
  }

  // QueueManager is a class mock — each call to `new QueueManager()` returns a fresh
  // object with vi.fn() methods so tests can control behavior per-test.
  const QueueManager = vi.fn().mockImplementation(() => ({
    enqueue: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    reorder: vi.fn(),
    getJobs: vi.fn().mockReturnValue([]),
    getActiveJobId: vi.fn().mockReturnValue(null),
    isPaused: vi.fn().mockReturnValue(false),
    getLogBuffer: vi.fn().mockReturnValue([]),
  }))

  return { QueueManager, ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError }
})

import express from 'express'
import { createHooksRouter, getPhaseStates, resetPhases } from './hooks'
import { QueueManager, ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError } from './queue-manager'
import { initDb, listJobs, getJob, getJobEvents, getStats } from './db'
import type { DbInstance } from './db'
import { getConfig, fetchIssues } from './config'

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>
const mockFetchIssues = fetchIssues as ReturnType<typeof vi.fn>

// Typed helper so tests can call methods without TS complaints
type MockQueueManager = {
  enqueue: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  reorder: ReturnType<typeof vi.fn>
  getJobs: ReturnType<typeof vi.fn>
  getActiveJobId: ReturnType<typeof vi.fn>
  isPaused: ReturnType<typeof vi.fn>
  getLogBuffer: ReturnType<typeof vi.fn>
}

function createTestApp() {
  const broadcast = vi.fn()
  const db = initDb(':memory:')

  // Cast is safe because QueueManager is mocked above
  const queueManager = new QueueManager(broadcast, db) as unknown as MockQueueManager

  const app = express()
  app.use(express.json())

  app.use('/hooks', createHooksRouter(broadcast, db, {
    current: null,
  }))

  app.post('/api/spawn', (req, res) => {
    const { command } = req.body ?? {}
    if (!command || typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: 'command is required' })
      return
    }
    try {
      const job = queueManager.enqueue(command) as { id: string; queuePosition: number | null }
      const position = job.queuePosition ?? 0
      res.status(202).json({ jobId: job.id, position })
    } catch (err) {
      if (err instanceof ClaudeNotFoundError) {
        res.status(400).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  app.get('/api/state', (_req, res) => {
    res.json({
      projectName: 'test-project',
      phases: getPhaseStates(),
      busy: (queueManager.getActiveJobId() as string | null) !== null,
    })
  })

  app.delete('/api/jobs/:id', (req, res) => {
    try {
      const result = queueManager.cancel(req.params.id) as string
      res.json({ ok: true, status: result })
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        res.status(404).json({ error: 'Job not found' })
      } else if (err instanceof JobAlreadyTerminalError) {
        res.status(409).json({ error: 'Job is already in terminal state' })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  app.post('/api/queue/pause', (_req, res) => {
    queueManager.pause()
    res.json({ ok: true, paused: true })
  })

  app.post('/api/queue/resume', (_req, res) => {
    queueManager.resume()
    res.json({ ok: true, paused: false })
  })

  app.put('/api/queue/reorder', (req, res) => {
    const { jobIds } = req.body ?? {}
    if (!Array.isArray(jobIds)) {
      res.status(400).json({ error: 'jobIds must be an array' })
      return
    }
    try {
      queueManager.reorder(jobIds)
      res.json({ ok: true, queue: jobIds })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  app.get('/api/queue', (_req, res) => {
    res.json({
      jobs: queueManager.getJobs() as unknown[],
      paused: queueManager.isPaused() as boolean,
      activeJobId: queueManager.getActiveJobId() as string | null,
    })
  })

  app.get('/api/jobs', (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200)
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0
    const status = req.query.status as string | undefined
    const from = req.query.from as string | undefined
    const to = req.query.to as string | undefined
    const result = listJobs(db, { limit, offset, status, from, to })
    res.json(result)
  })

  app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(db, req.params.id)
    if (!job) { res.status(404).json({ error: 'Job not found' }); return }
    const events = getJobEvents(db, req.params.id)
    res.json({ job, events })
  })

  app.get('/api/stats', (_req, res) => {
    res.json(getStats(db))
  })

  app.get('/api/config', (_req, res) => {
    try {
      const config = getConfig(process.cwd(), db, 'test-project')
      res.json(config)
    } catch {
      res.status(500).json({ error: 'Failed to read config' })
    }
  })

  app.post('/api/config', (req, res) => {
    const { active, labelFilter } = req.body ?? {}
    try {
      if (active !== undefined) {
        db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.active_tracker', ?)`).run(active ?? '')
      }
      if (labelFilter !== undefined) {
        db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.label_filter', ?)`).run(labelFilter ?? '')
      }
      res.json({ ok: true })
    } catch {
      res.status(500).json({ error: 'Failed to persist config' })
    }
  })

  app.get('/api/issues', (req, res) => {
    try {
      const config = getConfig(process.cwd(), db, 'test-project')
      const tracker = config.issueTracker.active
      if (!tracker) {
        res.status(503).json({ error: 'No issue tracker configured', trackers: config.issueTracker })
        return
      }
      const search = req.query.search as string | undefined
      const label = req.query.label as string | undefined
      const issues = fetchIssues(tracker, { search, label, repo: config.project.repo })
      res.json(issues)
    } catch {
      res.status(500).json({ error: 'Failed to fetch issues' })
    }
  })

  return { app, broadcast, db, queueManager }
}

describe('API endpoints', () => {
  let app: express.Express
  let queueManager: MockQueueManager
  let db: DbInstance
  let request: any

  beforeEach(async () => {
    // Reset phases to clean state
    const dummyBroadcast = vi.fn()
    resetPhases(dummyBroadcast)

    const created = createTestApp()
    app = created.app
    queueManager = created.queueManager
    db = created.db

    const mod = await import('supertest')
    request = mod.default
  })

  describe('POST /api/spawn', () => {
    it('returns 202 with jobId and position on success', async () => {
      queueManager.enqueue.mockReturnValue({ id: 'job-abc', queuePosition: 0 })

      const res = await request(app).post('/api/spawn').send({ command: '/implement #42' })

      expect(res.status).toBe(202)
      expect(res.body.jobId).toBe('job-abc')
      expect(res.body.position).toBe(0)
    })

    it('returns 400 when command is missing', async () => {
      const res = await request(app).post('/api/spawn').send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('command is required')
    })

    it('returns 400 when ClaudeNotFoundError is thrown', async () => {
      queueManager.enqueue.mockImplementation(() => {
        throw new ClaudeNotFoundError()
      })

      const res = await request(app).post('/api/spawn').send({ command: '/implement #42' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('claude binary not found')
    })

    it('does NOT return 409 — second enqueue is queued', async () => {
      queueManager.enqueue
        .mockReturnValueOnce({ id: 'job-1', queuePosition: null })
        .mockReturnValueOnce({ id: 'job-2', queuePosition: 1 })

      await request(app).post('/api/spawn').send({ command: '/implement #1' })
      const res = await request(app).post('/api/spawn').send({ command: '/implement #2' })

      expect(res.status).toBe(202)
      expect(res.body.position).toBe(1)
    })
  })

  describe('DELETE /api/jobs/:id', () => {
    it('returns 200 with status canceled for a queued job', async () => {
      queueManager.cancel.mockReturnValue('canceled')

      const res = await request(app).delete('/api/jobs/job-abc')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, status: 'canceled' })
    })

    it('returns 200 with status canceling for a running job', async () => {
      queueManager.cancel.mockReturnValue('canceling')

      const res = await request(app).delete('/api/jobs/job-running')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, status: 'canceling' })
    })

    it('returns 404 for unknown id', async () => {
      queueManager.cancel.mockImplementation(() => {
        throw new JobNotFoundError()
      })

      const res = await request(app).delete('/api/jobs/no-such-id')

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Job not found')
    })

    it('returns 409 for terminal job', async () => {
      queueManager.cancel.mockImplementation(() => {
        throw new JobAlreadyTerminalError()
      })

      const res = await request(app).delete('/api/jobs/completed-job')

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('Job is already in terminal state')
    })
  })

  describe('POST /api/queue/pause', () => {
    it('returns ok: true and paused: true', async () => {
      const res = await request(app).post('/api/queue/pause')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, paused: true })
      expect(queueManager.pause).toHaveBeenCalledOnce()
    })
  })

  describe('POST /api/queue/resume', () => {
    it('returns ok: true and paused: false', async () => {
      const res = await request(app).post('/api/queue/resume')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, paused: false })
      expect(queueManager.resume).toHaveBeenCalledOnce()
    })
  })

  describe('PUT /api/queue/reorder', () => {
    it('returns 200 with reordered queue', async () => {
      const jobIds = ['job-b', 'job-a']

      const res = await request(app).put('/api/queue/reorder').send({ jobIds })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, queue: jobIds })
      expect(queueManager.reorder).toHaveBeenCalledWith(jobIds)
    })

    it('returns 400 when jobIds is mismatched', async () => {
      queueManager.reorder.mockImplementation(() => {
        throw new Error('jobIds must contain exactly the IDs of all currently-queued jobs')
      })

      const res = await request(app).put('/api/queue/reorder').send({ jobIds: ['wrong-id'] })

      expect(res.status).toBe(400)
      expect(res.body.error).toBeDefined()
    })

    it('returns 400 when jobIds is not an array', async () => {
      const res = await request(app).put('/api/queue/reorder').send({ jobIds: 'not-array' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('jobIds must be an array')
    })
  })

  describe('GET /api/queue', () => {
    it('returns current queue state', async () => {
      queueManager.getJobs.mockReturnValue([])
      queueManager.isPaused.mockReturnValue(false)
      queueManager.getActiveJobId.mockReturnValue(null)

      const res = await request(app).get('/api/queue')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ jobs: [], paused: false, activeJobId: null })
    })
  })

  describe('GET /api/state', () => {
    it('returns busy: false when no active job', async () => {
      queueManager.getActiveJobId.mockReturnValue(null)

      const res = await request(app).get('/api/state')

      expect(res.status).toBe(200)
      expect(res.body.busy).toBe(false)
    })

    it('returns busy: true when activeJobId is non-null', async () => {
      queueManager.getActiveJobId.mockReturnValue('some-job-id')

      const res = await request(app).get('/api/state')

      expect(res.status).toBe(200)
      expect(res.body.busy).toBe(true)
    })
  })

  describe('POST /hooks/events', () => {
    it('still works unchanged — transitions phase state and returns ok', async () => {
      const res = await request(app)
        .post('/hooks/events')
        .send({ event: 'agent_start', agent: 'architect' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })

      const stateRes = await request(app).get('/api/state')
      expect(stateRes.body.phases.architect).toBe('running')
    })
  })

  describe('GET /api/jobs', () => {
    it('returns empty list on fresh DB', async () => {
      const res = await request(app).get('/api/jobs')

      expect(res.status).toBe(200)
      expect(res.body.jobs).toEqual([])
      expect(res.body.total).toBe(0)
    })
  })

  describe('GET /api/jobs/:id', () => {
    it('returns 404 for unknown id', async () => {
      const res = await request(app).get('/api/jobs/nonexistent-id')

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Job not found')
    })
  })

  describe('GET /api/stats', () => {
    it('returns zeroed stats on fresh DB', async () => {
      const res = await request(app).get('/api/stats')

      expect(res.status).toBe(200)
      expect(res.body.totalJobs).toBe(0)
      expect(res.body.jobsToday).toBe(0)
    })
  })

  describe('GET /api/config', () => {
    it('returns config with project, issueTracker, and commands', async () => {
      const res = await request(app).get('/api/config')

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('project')
      expect(res.body).toHaveProperty('issueTracker')
      expect(res.body).toHaveProperty('commands')
      expect(res.body.project.name).toBe('test-project')
      expect(res.body.issueTracker.active).toBe('github')
      expect(Array.isArray(res.body.commands)).toBe(true)
    })

    it('returns 500 when config detection throws', async () => {
      mockGetConfig.mockImplementationOnce(() => { throw new Error('detection failed') })

      const res = await request(app).get('/api/config')

      expect(res.status).toBe(500)
      expect(res.body.error).toBe('Failed to read config')
    })
  })

  describe('POST /api/config', () => {
    it('persists active tracker setting and returns ok', async () => {
      const res = await request(app).post('/api/config').send({ active: 'github' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    })

    it('persists label filter setting and returns ok', async () => {
      const res = await request(app).post('/api/config').send({ labelFilter: 'feature' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    })
  })

  describe('GET /api/issues', () => {
    it('returns issues list when tracker is configured', async () => {
      const res = await request(app).get('/api/issues')

      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect(res.body[0]).toHaveProperty('number')
      expect(res.body[0]).toHaveProperty('title')
      expect(res.body[0]).toHaveProperty('labels')
    })

    it('returns 503 when no tracker is configured', async () => {
      mockGetConfig.mockReturnValueOnce({
        project: { name: 'test', repo: null },
        issueTracker: { github: { available: false, authenticated: false }, jira: { available: false, authenticated: false }, active: null, labelFilter: '' },
        commands: [],
      })

      const res = await request(app).get('/api/issues')

      expect(res.status).toBe(503)
      expect(res.body.error).toBe('No issue tracker configured')
    })

    it('passes search query param to fetchIssues', async () => {
      await request(app).get('/api/issues?search=bug')

      expect(mockFetchIssues).toHaveBeenCalledWith(
        'github',
        expect.objectContaining({ search: 'bug' })
      )
    })
  })
})
