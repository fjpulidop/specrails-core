import { SessionError } from './errors.js'
import type { InputState, SessionPhase, SubagentPhase, TurnStatus } from './types.js'

/**
 * Transition tables. A state absent from a table's keys is terminal.
 * Re-applying the current state is always legal (providers repeat notifications).
 */
type Table<S extends string> = Readonly<Partial<Record<S, readonly S[]>>>

export const SESSION_PHASE_TRANSITIONS: Table<SessionPhase> = Object.freeze({
  idle: ['turn'],
  turn: ['idle', 'background'],
  // A user or continuation turn can start while sub-agents run; work can settle while idle.
  background: ['turn', 'idle'],
})

export const TURN_TRANSITIONS: Table<TurnStatus> = Object.freeze({
  running: ['completed', 'failed', 'stopped', 'interrupted'],
})

export const INPUT_TRANSITIONS: Table<InputState> = Object.freeze({
  accepted: ['queued', 'started', 'rejected', 'interrupted'],
  queued: ['started', 'rejected', 'interrupted'],
  started: ['completed', 'interrupted'],
})

/**
 * Sub-agents are re-entrant: providers report a sub-agent `idle` (its own turn
 * ended) and later restart it (e.g. when a shell it backgrounded finishes).
 * `stopped → killed` refines a stop into a forced kill.
 */
export const SUBAGENT_TRANSITIONS: Table<SubagentPhase> = Object.freeze({
  running: ['idle', 'failed', 'stopped', 'killed', 'interrupted'],
  idle: ['running', 'failed', 'stopped', 'killed', 'interrupted'],
  stopped: ['killed'],
})

export function canTransition<S extends string>(table: Table<S>, from: S, to: S): boolean {
  return from === to || (table[from]?.includes(to) ?? false)
}

export function assertTransition<S extends string>(machine: string, table: Table<S>, from: S, to: S): void {
  if (!canTransition(table, from, to)) {
    throw new SessionError('illegal_transition', `${machine}: ${from} → ${to} is not allowed`, { machine, from, to })
  }
}

export function isTerminal<S extends string>(table: Table<S>, state: S): boolean {
  return table[state] === undefined
}

/** Phases in which a sub-agent still occupies the provider. */
export function isLiveSubagentPhase(phase: SubagentPhase): boolean {
  return phase === 'running'
}
