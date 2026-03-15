import { Router, Request, Response } from 'express'
import type { PhaseState, PhaseDefinition, WsMessage } from './types'
import type { DbInstance } from './db'
import { upsertPhase } from './db'

const DEFAULT_PHASE_DEFINITIONS: PhaseDefinition[] = [
  { key: 'architect', label: 'Architect', description: 'Analyzes the issue, researches the codebase, and designs the implementation plan' },
  { key: 'developer', label: 'Developer', description: 'Implements the changes: writes code, edits files, runs tests' },
  { key: 'reviewer', label: 'Reviewer', description: 'Reviews the implementation for correctness, edge cases, and code quality' },
  { key: 'ship', label: 'Ship', description: 'Creates the PR, writes the description, and finalizes the changes for merge' },
]

let activePhaseKeys: string[] = DEFAULT_PHASE_DEFINITIONS.map((d) => d.key)
let activePhaseDefinitions: PhaseDefinition[] = [...DEFAULT_PHASE_DEFINITIONS]
const phases: Record<string, PhaseState> = {
  architect: 'idle',
  developer: 'idle',
  reviewer: 'idle',
  ship: 'idle',
}

function isValidPhase(value: string): boolean {
  return activePhaseKeys.includes(value)
}

function eventToState(event: string): PhaseState | null {
  if (event === 'agent_start') return 'running'
  if (event === 'agent_stop') return 'done'
  if (event === 'agent_error') return 'error'
  return null
}

export function getPhaseStates(): Record<string, PhaseState> {
  return { ...phases }
}

export function getPhaseDefinitions(): PhaseDefinition[] {
  return [...activePhaseDefinitions]
}

export function setActivePhases(
  definitions: PhaseDefinition[],
  broadcast: (msg: WsMessage) => void
): void {
  // Clear old phase entries
  for (const key of activePhaseKeys) {
    delete phases[key]
  }
  // Install new phase set
  activePhaseDefinitions = definitions
  activePhaseKeys = definitions.map((d) => d.key)
  for (const key of activePhaseKeys) {
    phases[key] = 'idle'
  }
  // Broadcast idle state for each new phase
  for (const key of activePhaseKeys) {
    broadcast({
      type: 'phase',
      phase: key,
      state: 'idle',
      timestamp: new Date().toISOString(),
    })
  }
}

export function resetPhases(broadcast: (msg: WsMessage) => void): void {
  for (const key of activePhaseKeys) {
    phases[key] = 'idle'
    broadcast({
      type: 'phase',
      phase: key,
      state: 'idle',
      timestamp: new Date().toISOString(),
    })
  }
}

export function createHooksRouter(
  broadcast: (msg: WsMessage) => void,
  db?: DbInstance,
  activeJobRef?: { current: string | null }
): Router {
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

    if (db && activeJobRef?.current) {
      upsertPhase(db, activeJobRef.current, agent, newState)
    }

    res.json({ ok: true })
  })

  return router
}
