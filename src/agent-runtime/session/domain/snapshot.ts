import { SessionError } from './errors.js'
import { fingerprint } from './fingerprint.js'
import type { SessionEvent, SessionEventEnvelope } from './events.js'
import {
  INPUT_TRANSITIONS,
  SESSION_PHASE_TRANSITIONS,
  SUBAGENT_TRANSITIONS,
  TURN_TRANSITIONS,
  assertTransition,
  isLiveSubagentPhase,
} from './state-machines.js'
import type {
  InputDelivery,
  InputState,
  SessionPhase,
  SessionPolicy,
  SessionStatus,
  SubagentKind,
  SubagentPhase,
  TurnOrigin,
  TurnStatus,
  Usage,
} from './types.js'

export interface InputRecord {
  inputId: string
  delivery: InputDelivery
  state: InputState
  turnId: string | null
  textLength: number
  /** Detects a retried inputId carrying different content. */
  fingerprint: string
}

export interface OpenTurn {
  turnId: string
  origin: TurnOrigin
  inputIds: string[]
  startedAt: string
  text: string
}

export interface TurnRecord {
  turnId: string
  origin: TurnOrigin
  status: TurnStatus
  startedAt: string
  endedAt: string | null
  usage: Usage | null
}

export interface SubagentNode {
  subagentId: string
  parentId: string | null
  kind: SubagentKind
  agentType: string | null
  description: string
  phase: SubagentPhase
  reason: string | null
  /** Times the provider restarted it after an idle phase. */
  restarts: number
  startedAt: string
  endedAt: string | null
  usage: Usage | null
  toolUses: number | null
  durationMs: number | null
  resultSummary: string | null
  /** Set when Core launched it as a child session (delegated runtime); its spend is billed separately. */
  delegated: { driver: string; model: string } | null
}

/** Bounded history kept in the snapshot; the journal keeps every event. */
export const SNAPSHOT_TURN_HISTORY = 100
export const SNAPSHOT_TERMINAL_INPUTS = 500

export interface SessionSnapshot {
  sessionId: string
  lastSeq: number
  status: SessionStatus
  driver: string
  model: string
  effort: string | null
  systemPrompt: string | null
  policy: SessionPolicy | null
  providerSessionRef: string | null
  phase: SessionPhase
  process: { generation: number; alive: boolean }
  openTurn: OpenTurn | null
  /** Most recent turns (bounded); `turnCount` counts all of them. */
  turns: TurnRecord[]
  turnCount: number
  inputs: Record<string, InputRecord>
  subagents: Record<string, SubagentNode>
  settled: { settled: boolean; live: number }
  /** Interrupted work the agent has not been told about yet. */
  pendingInterruptions: { subagentIds: string[]; inputIds: string[] }
  closedReason: string | null
}

export function emptySnapshot(sessionId: string): SessionSnapshot {
  return {
    sessionId,
    lastSeq: 0,
    status: 'open',
    driver: '',
    model: '',
    effort: null,
    systemPrompt: null,
    policy: null,
    providerSessionRef: null,
    phase: 'idle',
    process: { generation: 0, alive: false },
    openTurn: null,
    turns: [],
    turnCount: 0,
    inputs: {},
    subagents: {},
    settled: { settled: true, live: 0 },
    pendingInterruptions: { subagentIds: [], inputIds: [] },
    closedReason: null,
  }
}

/** Sub-agent end states that the agent must be told about before it continues. */
const NOTIFIABLE: ReadonlySet<SubagentPhase> = new Set(['interrupted', 'stopped', 'killed'])

function addUnique(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id]
}

function requireSubagent(state: SessionSnapshot, subagentId: string): SubagentNode {
  const node = state.subagents[subagentId]
  if (!node) throw new SessionError('illegal_transition', `Unknown sub-agent ${subagentId}`, { subagentId })
  return node
}

function requireOpenTurn(state: SessionSnapshot, turnId: string): OpenTurn {
  if (state.openTurn?.turnId !== turnId) throw new SessionError('illegal_transition', `Turn ${turnId} is not running`, { turnId })
  return state.openTurn
}

/**
 * Apply one event. Pure: returns a new snapshot and throws `illegal_transition`
 * for events that would break an invariant. The application validates every
 * event with this function before committing it, so a journal only ever
 * contains foldable events and replay equals the live state.
 */
export function applyEvent(state: SessionSnapshot, event: SessionEvent): SessionSnapshot {
  if (state.status === 'closed' && event.type !== 'provider.diagnostic') {
    throw new SessionError('session_closed', `Session ${state.sessionId} is closed`)
  }
  switch (event.type) {
    case 'session.opened':
      return {
        ...state,
        driver: event.driver,
        model: event.model,
        effort: event.effort ?? null,
        systemPrompt: event.systemPrompt ?? null,
        policy: event.policy,
        providerSessionRef: event.providerSessionRef ?? state.providerSessionRef,
      }
    case 'session.phase':
      assertTransition('session phase', SESSION_PHASE_TRANSITIONS, state.phase, event.phase)
      return { ...state, phase: event.phase }
    case 'session.process':
      return { ...state, process: { generation: event.generation, alive: event.state === 'started' } }
    case 'session.provider-ref':
      return { ...state, providerSessionRef: event.providerSessionRef }
    case 'session.updated': {
      if (event.outcome === 'deferred') return state
      const changes = event.changes as { model?: string; effort?: string; systemPrompt?: string; policy?: SessionPolicy }
      return {
        ...state,
        model: changes.model ?? state.model,
        effort: changes.effort ?? state.effort,
        systemPrompt: changes.systemPrompt ?? state.systemPrompt,
        policy: changes.policy ?? state.policy,
      }
    }
    case 'session.closed':
      return { ...state, status: 'closed', closedReason: event.reason, process: { ...state.process, alive: false } }

    case 'input.accepted':
      if (state.inputs[event.inputId]) throw new SessionError('input_conflict', `Input ${event.inputId} already exists`, { inputId: event.inputId })
      return {
        ...state,
        inputs: { ...state.inputs, [event.inputId]: { inputId: event.inputId, delivery: event.delivery, state: 'accepted', turnId: null, textLength: event.text.length, fingerprint: fingerprint(event.text) } },
      }
    case 'input.state': {
      const input = state.inputs[event.inputId]
      if (!input) throw new SessionError('illegal_transition', `Unknown input ${event.inputId}`, { inputId: event.inputId })
      assertTransition('input', INPUT_TRANSITIONS, input.state, event.state)
      const pending = event.state === 'interrupted'
        ? { ...state.pendingInterruptions, inputIds: addUnique(state.pendingInterruptions.inputIds, event.inputId) }
        : state.pendingInterruptions
      return {
        ...state,
        inputs: pruneInputs({ ...state.inputs, [event.inputId]: { ...input, state: event.state, turnId: event.turnId ?? input.turnId } }),
        pendingInterruptions: pending,
      }
    }

    case 'turn.started':
      if (state.openTurn) throw new SessionError('illegal_transition', `Turn ${state.openTurn.turnId} is still running`, { turnId: event.turnId })
      return {
        ...state,
        openTurn: { turnId: event.turnId, origin: event.origin, inputIds: [...event.inputIds], startedAt: event.at, text: '' },
        turns: [...state.turns, { turnId: event.turnId, origin: event.origin, status: 'running' as const, startedAt: event.at, endedAt: null, usage: null }].slice(-SNAPSHOT_TURN_HISTORY),
        turnCount: state.turnCount + 1,
      }
    case 'turn.output': {
      const turn = requireOpenTurn(state, event.turnId)
      return event.channel === 'text' ? { ...state, openTurn: { ...turn, text: turn.text + event.delta } } : state
    }
    case 'turn.tool':
      requireOpenTurn(state, event.turnId)
      return state
    case 'turn.completed': {
      requireOpenTurn(state, event.turnId)
      const turns = state.turns.map((turn) => {
        if (turn.turnId !== event.turnId) return turn
        assertTransition('turn', TURN_TRANSITIONS, turn.status, event.status)
        return { ...turn, status: event.status, endedAt: event.at, usage: event.usage }
      })
      return { ...state, openTurn: null, turns }
    }

    case 'subagent.started': {
      const existing = state.subagents[event.subagentId]
      if (existing) {
        // Providers restart a sub-agent under the same id after an idle phase.
        assertTransition('sub-agent', SUBAGENT_TRANSITIONS, existing.phase, 'running')
        const restarted = existing.phase === 'idle'
        return withSubagent(state, { ...existing, phase: 'running', reason: null, endedAt: null, restarts: existing.restarts + (restarted ? 1 : 0) })
      }
      if (event.parentId !== null && !state.subagents[event.parentId]) {
        throw new SessionError('illegal_transition', `Unknown parent sub-agent ${event.parentId}`, { subagentId: event.subagentId })
      }
      return withSubagent(state, {
        subagentId: event.subagentId,
        parentId: event.parentId,
        kind: event.kind,
        agentType: event.agentType ?? null,
        delegated: event.delegated ?? null,
        description: event.description,
        phase: 'running',
        reason: null,
        restarts: 0,
        startedAt: event.at,
        endedAt: null,
        usage: null,
        toolUses: null,
        durationMs: null,
        resultSummary: null,
      })
    }
    case 'subagent.phase': {
      const node = requireSubagent(state, event.subagentId)
      assertTransition('sub-agent', SUBAGENT_TRANSITIONS, node.phase, event.phase)
      const live = isLiveSubagentPhase(event.phase)
      // A refinement (stopped → killed) keeps the original reason unless a new one is given.
      const next = withSubagent(state, { ...node, phase: event.phase, reason: event.reason ?? (live ? null : node.reason), endedAt: live ? null : event.at })
      return NOTIFIABLE.has(event.phase)
        ? { ...next, pendingInterruptions: { ...next.pendingInterruptions, subagentIds: addUnique(next.pendingInterruptions.subagentIds, event.subagentId) } }
        : next
    }
    case 'subagent.output':
      requireSubagent(state, event.subagentId)
      return state
    case 'subagent.usage': {
      const node = requireSubagent(state, event.subagentId)
      return withSubagent(state, { ...node, usage: event.usage, toolUses: event.toolUses ?? node.toolUses, durationMs: event.durationMs ?? node.durationMs })
    }
    case 'subagent.result': {
      const node = requireSubagent(state, event.subagentId)
      return withSubagent(state, { ...node, resultSummary: event.summary })
    }
    case 'subagents.settled':
      return { ...state, settled: { settled: event.settled, live: event.live } }

    case 'notice.interruption':
      return {
        ...state,
        pendingInterruptions: {
          subagentIds: state.pendingInterruptions.subagentIds.filter((id) => !event.subagentIds.includes(id)),
          inputIds: state.pendingInterruptions.inputIds.filter((id) => !event.inputIds.includes(id)),
        },
      }
    case 'output.truncated':
    case 'provider.diagnostic':
      return state
  }
}

const TERMINAL_INPUT: ReadonlySet<InputState> = new Set(['completed', 'rejected', 'interrupted'])

/** Keep every live input and only the most recent terminal ones (insertion order). */
function pruneInputs(inputs: Record<string, InputRecord>): Record<string, InputRecord> {
  const terminal = Object.values(inputs).filter((input) => TERMINAL_INPUT.has(input.state))
  if (terminal.length <= SNAPSHOT_TERMINAL_INPUTS) return inputs
  const drop = new Set(terminal.slice(0, terminal.length - SNAPSHOT_TERMINAL_INPUTS).map((input) => input.inputId))
  return Object.fromEntries(Object.entries(inputs).filter(([id]) => !drop.has(id)))
}

function withSubagent(state: SessionSnapshot, node: SubagentNode): SessionSnapshot {
  return { ...state, subagents: { ...state.subagents, [node.subagentId]: node } }
}

/** Fold committed envelopes; sequence numbers must be gap-free and increasing. */
export function foldEvents(initial: SessionSnapshot, envelopes: readonly SessionEventEnvelope[]): SessionSnapshot {
  let state = initial
  for (const envelope of envelopes) {
    if (envelope.sessionId !== state.sessionId) throw new SessionError('internal', `Event for ${envelope.sessionId} folded into ${state.sessionId}`)
    if (envelope.seq !== state.lastSeq + 1) throw new SessionError('internal', `Sequence gap: expected ${state.lastSeq + 1}, got ${envelope.seq}`)
    state = { ...applyEvent(state, envelope.event), lastSeq: envelope.seq }
  }
  return state
}

/** Sub-agents currently occupying the provider. */
export function liveSubagents(state: SessionSnapshot): SubagentNode[] {
  return Object.values(state.subagents).filter((node) => isLiveSubagentPhase(node.phase))
}
