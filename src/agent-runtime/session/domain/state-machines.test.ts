import { describe, expect, it } from 'vitest'

import { SessionError } from './errors.js'
import {
  INPUT_TRANSITIONS,
  SESSION_PHASE_TRANSITIONS,
  SUBAGENT_TRANSITIONS,
  TURN_TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
} from './state-machines.js'
import type { InputState, SessionPhase, SubagentPhase, TurnStatus } from './types.js'

function matrix<S extends string>(states: readonly S[], allowed: Record<S, readonly S[]>) {
  return states.flatMap((from) => states.map((to) => [from, to, from === to || allowed[from].includes(to)] as const))
}

describe('session state machines', () => {
  const phases: SessionPhase[] = ['idle', 'turn', 'background']
  it.each(matrix(phases, { idle: ['turn', 'background'], turn: ['idle', 'background'], background: ['turn', 'idle'] }))(
    'session phase %s → %s legal=%s', (from, to, legal) => {
      expect(canTransition(SESSION_PHASE_TRANSITIONS, from, to)).toBe(legal)
    })

  const turns: TurnStatus[] = ['running', 'completed', 'failed', 'stopped', 'interrupted']
  it.each(matrix(turns, { running: ['completed', 'failed', 'stopped', 'interrupted'], completed: [], failed: [], stopped: [], interrupted: [] }))(
    'turn %s → %s legal=%s', (from, to, legal) => {
      expect(canTransition(TURN_TRANSITIONS, from, to)).toBe(legal)
    })

  const inputs: InputState[] = ['accepted', 'queued', 'started', 'completed', 'rejected', 'interrupted']
  it.each(matrix(inputs, {
    accepted: ['queued', 'started', 'rejected', 'interrupted'],
    queued: ['started', 'rejected', 'interrupted'],
    started: ['completed', 'interrupted'],
    completed: [], rejected: [], interrupted: [],
  }))('input %s → %s legal=%s', (from, to, legal) => {
    expect(canTransition(INPUT_TRANSITIONS, from, to)).toBe(legal)
  })

  const subagents: SubagentPhase[] = ['running', 'idle', 'failed', 'stopped', 'killed', 'interrupted']
  it.each(matrix(subagents, {
    running: ['idle', 'failed', 'stopped', 'killed', 'interrupted'],
    idle: ['running', 'failed', 'stopped', 'killed', 'interrupted'],
    stopped: ['killed'],
    failed: [], killed: [], interrupted: [],
  }))('sub-agent %s → %s legal=%s', (from, to, legal) => {
    expect(canTransition(SUBAGENT_TRANSITIONS, from, to)).toBe(legal)
  })

  it('treats states without outgoing transitions as terminal', () => {
    expect(isTerminal(TURN_TRANSITIONS, 'completed')).toBe(true)
    expect(isTerminal(TURN_TRANSITIONS, 'running')).toBe(false)
    expect(isTerminal(SUBAGENT_TRANSITIONS, 'idle')).toBe(false)
    expect(isTerminal(SUBAGENT_TRANSITIONS, 'interrupted')).toBe(true)
  })

  it('reports illegal transitions as typed errors', () => {
    expect(() => assertTransition('turn', TURN_TRANSITIONS, 'completed', 'running')).toThrow(SessionError)
    try {
      assertTransition('turn', TURN_TRANSITIONS, 'completed', 'running')
    } catch (error) {
      expect((error as SessionError).code).toBe('illegal_transition')
      expect((error as SessionError).retryable).toBe(false)
    }
  })
})

describe('fingerprint', () => {
  it('is stable and content-sensitive', async () => {
    const { fingerprint } = await import('./fingerprint.js')
    expect(fingerprint('hello')).toBe(fingerprint('hello'))
    expect(fingerprint('hello')).not.toBe(fingerprint('hellO'))
    expect(fingerprint('')).toMatch(/^[0-9a-f]{16}$/)
  })
})
