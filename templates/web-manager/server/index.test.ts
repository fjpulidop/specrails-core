import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock child_process and uuid before any imports
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-5678'),
}))

import express from 'express'
import type { WsMessage } from './types'
import { ClaudeNotFoundError, SpawnBusyError } from './types'
import { createHooksRouter, getPhaseStates, resetPhases } from './hooks'
import { spawnClaude, isSpawnActive, getLogBuffer } from './spawner'

// Build the app the same way index.ts does, but without the WebSocket/listen parts
function createTestApp() {
  const broadcast = vi.fn()

  const app = express()
  app.use(express.json())
  app.use('/hooks', createHooksRouter(broadcast))

  app.post('/api/spawn', (req, res) => {
    const { command } = req.body ?? {}
    if (!command || typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: 'command is required' })
      return
    }

    try {
      const handle = spawnClaude(
        command,
        broadcast,
        () => resetPhases(broadcast)
      )
      res.json({ processId: handle.processId })
    } catch (err) {
      if (err instanceof ClaudeNotFoundError) {
        res.status(400).json({ error: err.message })
      } else if (err instanceof SpawnBusyError) {
        res.status(409).json({ error: err.message })
      } else {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  app.get('/api/state', (_req, res) => {
    res.json({
      projectName: 'test-project',
      phases: getPhaseStates(),
      busy: isSpawnActive(),
    })
  })

  return { app, broadcast }
}

describe('API endpoints', () => {
  let app: express.Express
  let broadcast: ReturnType<typeof vi.fn>
  let request: any

  beforeEach(async () => {
    // Reset phases to clean state
    const dummyBroadcast = vi.fn()
    resetPhases(dummyBroadcast)

    const created = createTestApp()
    app = created.app
    broadcast = created.broadcast

    const mod = await import('supertest')
    request = mod.default
  })

  describe('GET /api/state', () => {
    it('returns project name, phases, and busy status', async () => {
      const res = await request(app).get('/api/state')

      expect(res.status).toBe(200)
      expect(res.body.projectName).toBe('test-project')
      expect(res.body.phases).toEqual({
        architect: 'idle',
        developer: 'idle',
        reviewer: 'idle',
        ship: 'idle',
      })
      expect(res.body.busy).toBe(false)
    })
  })

  describe('POST /api/spawn', () => {
    it('returns 400 when command is missing', async () => {
      const res = await request(app).post('/api/spawn').send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('command is required')
    })

    it('returns 400 when command is empty string', async () => {
      const res = await request(app).post('/api/spawn').send({ command: '   ' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('command is required')
    })

    it('returns 400 when command is not a string', async () => {
      const res = await request(app).post('/api/spawn').send({ command: 123 })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('command is required')
    })

    it('returns 400 when claude is not found', async () => {
      const { execSync } = await import('child_process')
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('not found')
      })

      const res = await request(app).post('/api/spawn').send({ command: '/test' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('claude binary not found')
    })

    it('returns 409 when a process is already running', async () => {
      const { execSync, spawn } = await import('child_process')
      const { EventEmitter } = await import('events')
      const { Readable } = await import('stream')

      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = new EventEmitter() as any
      child.stdout = new Readable({ read() {} })
      child.stderr = new Readable({ read() {} })
      vi.mocked(spawn).mockReturnValue(child as any)

      // First spawn succeeds
      await request(app).post('/api/spawn').send({ command: '/test1' })

      // Second spawn should fail with 409
      const res = await request(app).post('/api/spawn').send({ command: '/test2' })

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('A process is already running')

      // Clean up: close the active process so it doesn't leak into other tests
      child.emit('close', 0)
    })

    it('returns processId on successful spawn', async () => {
      const { execSync, spawn } = await import('child_process')
      const { EventEmitter } = await import('events')
      const { Readable } = await import('stream')

      vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
      const child = new EventEmitter() as any
      child.stdout = new Readable({ read() {} })
      child.stderr = new Readable({ read() {} })
      vi.mocked(spawn).mockReturnValue(child as any)

      const res = await request(app).post('/api/spawn').send({ command: '/implement #42' })

      expect(res.status).toBe(200)
      expect(res.body.processId).toBe('test-uuid-5678')
    })
  })

  describe('POST /hooks/events', () => {
    it('transitions phase state and returns ok', async () => {
      const res = await request(app)
        .post('/hooks/events')
        .send({ event: 'agent_start', agent: 'architect' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })

      // Verify state was updated
      const stateRes = await request(app).get('/api/state')
      expect(stateRes.body.phases.architect).toBe('running')
    })
  })
})
