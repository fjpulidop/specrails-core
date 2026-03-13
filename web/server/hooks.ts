import { Router, Request, Response } from 'express'
import type { PhaseName, PhaseState, WsMessage } from './types'

const PHASE_NAMES: PhaseName[] = ['architect', 'developer', 'reviewer', 'ship']

const phases: Record<PhaseName, PhaseState> = {
  architect: 'idle',
  developer: 'idle',
  reviewer: 'idle',
  ship: 'idle',
}

function isValidPhase(value: string): value is PhaseName {
  return PHASE_NAMES.includes(value as PhaseName)
}

function eventToState(event: string): PhaseState | null {
  if (event === 'agent_start') return 'running'
  if (event === 'agent_stop') return 'done'
  if (event === 'agent_error') return 'error'
  return null
}

export function getPhaseStates(): Record<PhaseName, PhaseState> {
  return { ...phases }
}

export function resetPhases(broadcast: (msg: WsMessage) => void): void {
  for (const phase of PHASE_NAMES) {
    phases[phase] = 'idle'
    broadcast({
      type: 'phase',
      phase,
      state: 'idle',
      timestamp: new Date().toISOString(),
    })
  }
}

export function createHooksRouter(broadcast: (msg: WsMessage) => void): Router {
  const router = Router()

  router.post('/events', (req: Request, res: Response) => {
    const { event, agent } = req.body ?? {}

    if (!agent || !isValidPhase(agent)) {
      console.warn(`[hooks] unknown agent: ${agent}`)
      res.json({ ok: true })
      return
    }

    const newState = eventToState(event)
    if (!newState) {
      console.warn(`[hooks] unknown event: ${event}`)
      res.json({ ok: true })
      return
    }

    phases[agent] = newState
    broadcast({
      type: 'phase',
      phase: agent,
      state: newState,
      timestamp: new Date().toISOString(),
    })

    res.json({ ok: true })
  })

  return router
}
