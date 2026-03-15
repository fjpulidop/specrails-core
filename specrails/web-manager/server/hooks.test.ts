import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import { createHooksRouter, getPhaseStates, resetPhases } from './hooks'
import type { WsMessage, PhaseName, PhaseState } from './types'

// The hooks module uses module-level state, so we need a fresh import for isolation.
// Since we can't easily re-import, we'll use resetPhases to clean up between tests.

function createApp(broadcast: (msg: WsMessage) => void) {
  const app = express()
  app.use(express.json())
  app.use('/hooks', createHooksRouter(broadcast))
  return app
}

describe('getPhaseStates', () => {
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    broadcast = vi.fn()
    // Reset all phases to idle before each test
    resetPhases(broadcast)
    broadcast.mockClear()
  })

  it('returns all phases as idle initially', () => {
    const states = getPhaseStates()
    expect(states).toEqual({
      architect: 'idle',
      developer: 'idle',
      reviewer: 'idle',
      ship: 'idle',
    })
  })

  it('returns a copy, not a reference', () => {
    const states = getPhaseStates()
    states.architect = 'running'
    expect(getPhaseStates().architect).toBe('idle')
  })
})

describe('resetPhases', () => {
  it('broadcasts a phase message for each phase', () => {
    const broadcast = vi.fn()
    resetPhases(broadcast)

    expect(broadcast).toHaveBeenCalledTimes(4)
    const phases: PhaseName[] = ['architect', 'developer', 'reviewer', 'ship']
    for (const phase of phases) {
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'phase',
          phase,
          state: 'idle',
          timestamp: expect.any(String),
        })
      )
    }
  })

  it('sets all phases back to idle', async () => {
    const broadcast = vi.fn()
    // First, transition a phase to running via the router
    const app = createApp(broadcast)
    const { default: request } = await import('supertest')
    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'architect' })

    expect(getPhaseStates().architect).toBe('running')

    resetPhases(broadcast)
    expect(getPhaseStates().architect).toBe('idle')
  })
})

describe('POST /hooks/events', () => {
  let broadcast: ReturnType<typeof vi.fn>
  let app: express.Express
  let request: any

  beforeEach(async () => {
    broadcast = vi.fn()
    resetPhases(broadcast)
    broadcast.mockClear()
    app = createApp(broadcast)
    const mod = await import('supertest')
    request = mod.default
  })

  it('transitions phase to running on agent_start', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'architect' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(getPhaseStates().architect).toBe('running')
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'phase',
        phase: 'architect',
        state: 'running',
      })
    )
  })

  it('transitions phase to done on agent_stop', async () => {
    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'developer' })
    broadcast.mockClear()

    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_stop', agent: 'developer' })

    expect(res.status).toBe(200)
    expect(getPhaseStates().developer).toBe('done')
  })

  it('transitions phase to error on agent_error', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_error', agent: 'reviewer' })

    expect(res.status).toBe(200)
    expect(getPhaseStates().reviewer).toBe('error')
  })

  it('ignores unknown agent names gracefully', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'unknown_agent' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('ignores unknown event types gracefully', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'unknown_event', agent: 'architect' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('handles missing body gracefully', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('handles all four phases', async () => {
    const phases: PhaseName[] = ['architect', 'developer', 'reviewer', 'ship']
    for (const phase of phases) {
      await request(app)
        .post('/hooks/events')
        .send({ event: 'agent_start', agent: phase })
      expect(getPhaseStates()[phase]).toBe('running')
    }
  })

  it('can transition through full lifecycle: idle -> running -> done', async () => {
    expect(getPhaseStates().ship).toBe('idle')

    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'ship' })
    expect(getPhaseStates().ship).toBe('running')

    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_stop', agent: 'ship' })
    expect(getPhaseStates().ship).toBe('done')
  })

  it('can transition from running to error', async () => {
    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'architect' })
    expect(getPhaseStates().architect).toBe('running')

    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_error', agent: 'architect' })
    expect(getPhaseStates().architect).toBe('error')
  })
})
