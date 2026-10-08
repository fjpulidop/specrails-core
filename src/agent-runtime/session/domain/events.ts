import type {
  Attachment,
  InputDelivery,
  OutputChannel,
  SessionPhase,
  SessionPolicy,
  SubagentKind,
  SubagentPhase,
  TurnOrigin,
  Usage,
} from './types.js'

/**
 * The journaled, provider-neutral event vocabulary (session protocol v1).
 * Events are the source of truth: snapshots and projections are folds over them.
 * Adding a type is non-breaking; changing a payload's meaning needs a new
 * protocol version (docs/agent-sessions/protocol.md).
 */

export interface ToolActivity {
  toolUseId: string
  name: string
  phase: 'started' | 'completed'
  input?: unknown
  output?: string
  isError?: boolean
}

export type SessionEventBody =
  | { type: 'session.opened'; driver: string; model: string; effort?: string; systemPrompt?: string; policy: SessionPolicy; resumed: boolean; providerSessionRef: string | null }
  | { type: 'session.phase'; phase: SessionPhase }
  | { type: 'session.process'; state: 'started' | 'retired' | 'exited'; generation: number; reason?: string; exitCode?: number | null }
  | { type: 'session.provider-ref'; providerSessionRef: string }
  | { type: 'session.updated'; changes: Record<string, unknown>; outcome: 'applied' | 'deferred' }
  | { type: 'session.closed'; reason: string }
  | { type: 'input.accepted'; inputId: string; delivery: InputDelivery; text: string; attachments?: Attachment[] }
  | { type: 'input.state'; inputId: string; state: 'queued' | 'started' | 'completed' | 'rejected' | 'interrupted'; turnId?: string; reason?: string }
  | { type: 'turn.started'; turnId: string; origin: TurnOrigin; inputIds: string[]; trigger?: { subagentIds: string[] } }
  | { type: 'turn.output'; turnId: string; channel: OutputChannel; delta: string }
  | ({ type: 'turn.tool'; turnId: string } & ToolActivity)
  | { type: 'turn.completed'; turnId: string; status: 'completed' | 'failed' | 'stopped' | 'interrupted'; text: string; error?: string; usage: Usage }
  | { type: 'subagent.started'; subagentId: string; parentId: string | null; kind: SubagentKind; agentType?: string; description: string; prompt?: string; delegated?: { driver: string; model: string } }
  | { type: 'subagent.phase'; subagentId: string; phase: SubagentPhase; reason?: string }
  | { type: 'subagent.output'; subagentId: string; channel: 'text' | 'tool'; delta?: string; tool?: ToolActivity }
  | { type: 'subagent.usage'; subagentId: string; usage: Usage; toolUses?: number; durationMs?: number; billing?: 'included' | 'separate' }
  | { type: 'subagent.result'; subagentId: string; summary: string }
  | { type: 'subagents.settled'; settled: boolean; live: number }
  | { type: 'output.truncated'; scope: { turnId: string } | { subagentId: string }; droppedEvents: number; droppedBytes: number }
  | { type: 'notice.interruption'; subagentIds: string[]; inputIds: string[] }
  | { type: 'provider.diagnostic'; level: 'info' | 'warning'; code: string; message: string }

export type SessionEventType = SessionEventBody['type']

/** A committed event: body plus journal coordinates. */
export type SessionEvent = SessionEventBody & { at: string }

export interface SessionEventEnvelope {
  sessionId: string
  seq: number
  event: SessionEvent
}

/** Closed list of event types (mirrored into integration-contract.json). */
export const SESSION_EVENT_TYPES = Object.freeze([
  'session.opened',
  'session.phase',
  'session.process',
  'session.provider-ref',
  'session.updated',
  'session.closed',
  'input.accepted',
  'input.state',
  'turn.started',
  'turn.output',
  'turn.tool',
  'turn.completed',
  'subagent.started',
  'subagent.phase',
  'subagent.output',
  'subagent.usage',
  'subagent.result',
  'subagents.settled',
  'output.truncated',
  'notice.interruption',
  'provider.diagnostic',
] as const satisfies readonly SessionEventType[])
