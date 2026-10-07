/**
 * Ports owned by the session application layer. Each interface is as narrow as
 * its use case: drivers move provider work, the journal persists committed
 * events, the clock and ids make timing and identity deterministic in tests.
 * Implementations live in drivers/, journal/ and testing/; the composition root
 * (index.ts) wires them.
 */
import type { SessionEvent, SessionEventEnvelope, ToolActivity } from './domain/events.js'
import type { SessionSnapshot } from './domain/snapshot.js'
import type { Attachment, DriverDescriptor, OutputChannel, SessionPolicy, SubagentKind, SubagentPhase } from './domain/types.js'
import type { ReportedUsage, UsageBaseline } from './domain/usage.js'

// ── Drivers ─────────────────────────────────────────────────────────────────

export interface DriverOpenSpec {
  sessionId: string
  /** Increments every time the session gets a new provider process. */
  generation: number
  cwd: string
  model: string
  effort: string | null
  systemPrompt: string | null
  policy: SessionPolicy
  /** Provider session to resume (Claude session id, Codex thread id), if any. */
  providerSessionRef: string | null
}

export interface DriverInput {
  inputId: string
  text: string
  attachments?: Attachment[]
  delivery: 'queue' | 'steer'
  /** Set by the application for policy-driven turns (e.g. collecting settled sub-agents). */
  origin?: 'user' | 'system'
}

export type CloseReason =
  | 'idle'
  | 'stalled'
  | 'limit'
  | 'user_stop'
  | 'host_request'
  | 'config_change'
  | 'evicted'
  | 'shutdown'
  | 'session_closed'

/**
 * Normalized, uncommitted facts a driver observed. Drivers never assign turn or
 * session sequence numbers; the application turns these into journaled events.
 */
export type DriverEvent =
  | { kind: 'process.started'; pid?: number; version?: string }
  | { kind: 'process.exited'; exitCode: number | null; signal: string | null }
  | { kind: 'provider.ref'; providerSessionRef: string }
  | { kind: 'input.receipt'; inputId: string; state: 'queued' | 'started' | 'completed' | 'rejected'; reason?: string }
  /** `continuation` = the provider started a turn on its own (e.g. after a background sub-agent finished). */
  | { kind: 'turn.started'; trigger: 'input' | 'continuation'; inputIds: string[] }
  | { kind: 'turn.output'; channel: OutputChannel; delta: string }
  | ({ kind: 'turn.tool' } & ToolActivity)
  | { kind: 'turn.completed'; status: 'completed' | 'failed' | 'stopped'; text: string; error?: string; usage: ReportedUsage }
  | { kind: 'subagent.started'; subagentId: string; parentId: string | null; agentKind: SubagentKind; agentType?: string; description: string; prompt?: string }
  | { kind: 'subagent.phase'; subagentId: string; phase: SubagentPhase; reason?: string }
  | { kind: 'subagent.output'; subagentId: string; channel: 'text' | 'tool'; delta?: string; tool?: ToolActivity }
  /** Cumulative per-sub-agent usage as reported (the application derives deltas when needed). */
  | { kind: 'subagent.usage'; subagentId: string; usage: ReportedUsage; toolUses?: number; durationMs?: number }
  | { kind: 'subagent.result'; subagentId: string; summary: string }
  /** The provider's authoritative list of live sub-agent ids, when it reports one. */
  | { kind: 'roster'; liveSubagentIds: string[] }
  | { kind: 'diagnostic'; level: 'info' | 'warning'; code: string; message: string }

export type DriverEventSink = (event: DriverEvent) => void

export interface DriverSession {
  /** Write input to the provider. Receipts arrive as `input.receipt` events. */
  send(input: DriverInput): Promise<void>
  /** Stop the running turn only. The driver reports `turn.completed` with status `stopped`. */
  interrupt(): Promise<void>
  /**
   * Stop the given sub-agents (all when omitted). Resolves with the ids the
   * driver could stop selectively; `'process'` means it had to end the process.
   */
  stopSubagents(subagentIds?: string[]): Promise<string[] | 'process'>
  /** Idempotent. Resolves after the process tree is gone; no events after that. */
  close(reason: CloseReason): Promise<void>
}

export interface DriverFactory {
  readonly descriptor: DriverDescriptor
  open(spec: DriverOpenSpec, sink: DriverEventSink): Promise<DriverSession>
}

export interface DriverCatalog {
  get(driverId: string): DriverFactory | undefined
  descriptors(): DriverDescriptor[]
}

// ── Journal ─────────────────────────────────────────────────────────────────

export interface SessionRecord {
  sessionId: string
  driver: string
  cwd: string
  createdAt: string
  metadata: Record<string, unknown>
}

export interface SessionSummary {
  sessionId: string
  driver: string
  model: string
  status: 'open' | 'closed'
  phase: SessionSnapshot['phase']
  lastSeq: number
  createdAt: string
  metadata: Record<string, unknown>
}

export interface AppendOptions {
  /** Persist the provider's cumulative totals in the same transaction as the events. */
  baseline?: { providerRef: string; value: UsageBaseline }
}

/**
 * Durable, append-only event store for one scope. All methods are synchronous
 * (node:sqlite) and every append is one transaction that assigns gap-free
 * sequence numbers. It validates nothing about meaning: the application folds
 * events before appending them.
 */
export interface SessionJournal {
  createSession(record: SessionRecord): void
  getSession(sessionId: string): SessionRecord | null
  /** Events arrive stamped (`at`) and already validated by the application's fold. */
  append(sessionId: string, events: SessionEvent[], options?: AppendOptions): SessionEventEnvelope[]
  read(sessionId: string, afterSeq: number, limit: number): { events: SessionEventEnvelope[]; hasMore: boolean }
  /** Latest snapshot (folded and cached by the implementation). */
  snapshot(sessionId: string): SessionSnapshot | null
  list(filter: 'open' | 'closed' | 'all'): SessionSummary[]
  baseline(providerRef: string): UsageBaseline | null
}

// ── Time and identity ───────────────────────────────────────────────────────

export interface TimerHandle { cancel(): void }

export interface Clock {
  now(): number
  /** ISO-8601 time for event stamps. */
  iso(): string
  after(ms: number, callback: () => void): TimerHandle
}

export interface Ids {
  session(): string
  turn(): string
  input(): string
}
