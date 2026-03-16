export type PhaseName = string
export type PhaseState = 'idle' | 'running' | 'done' | 'error'

export interface PhaseDefinition {
  key: string
  label: string
  description: string
}

// ─── ProjectRow (hub-level) — re-exported from hub-db for WS message use ─────

import type { ProjectRow } from './hub-db'
export type { ProjectRow }

export interface LogMessage {
  type: 'log'
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
  processId: string
  projectId?: string
}

export interface PhaseMessage {
  type: 'phase'
  phase: PhaseName
  state: PhaseState
  timestamp: string
  projectId?: string
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface JobRow {
  id: string
  command: string
  started_at: string
  finished_at: string | null
  status: JobStatus
  exit_code: number | null
  queue_position: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache_read: number | null
  tokens_cache_create: number | null
  total_cost_usd: number | null
  num_turns: number | null
  model: string | null
  duration_ms: number | null
  duration_api_ms: number | null
  session_id: string | null
}

export interface EventRow {
  id: number
  job_id: string
  seq: number
  event_type: string
  source: string | null
  payload: string
  timestamp: string
}

export interface StatsRow {
  totalJobs: number
  jobsToday: number
  totalCostUsd: number
  costToday: number
  avgDurationMs: number | null
}

export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all' | 'custom'

export interface AnalyticsOpts {
  period: AnalyticsPeriod
  from?: string
  to?: string
}

export interface AnalyticsResponse {
  period: {
    label: string
    from: string | null
    to: string | null
  }
  kpi: {
    totalCostUsd: number
    totalJobs: number
    successRate: number
    avgDurationMs: number | null
    costDelta: number | null
    jobsDelta: number | null
    successRateDelta: number | null
    avgDurationDelta: number | null
  }
  costTimeline: Array<{ date: string; costUsd: number }>
  statusBreakdown: Array<{ status: string; count: number }>
  durationHistogram: Array<{ bucket: string; count: number }>
  durationPercentiles: { p50: number | null; p75: number | null; p95: number | null }
  tokenEfficiency: Array<{
    command: string
    tokensOut: number
    tokensCacheRead: number
    totalTokens: number
  }>
  commandPerformance: Array<{
    command: string
    totalRuns: number
    successRate: number
    avgCostUsd: number | null
    avgDurationMs: number | null
    totalCostUsd: number
  }>
  dailyThroughput: Array<{ date: string; completed: number; failed: number; canceled: number }>
  costPerCommand: Array<{ command: string; totalCostUsd: number; jobCount: number }>
  bonusMetrics: {
    costPerSuccess: number | null
    apiEfficiencyPct: number | null
    failureCostUsd: number
    modelBreakdown: Array<{ model: string; jobCount: number; totalCostUsd: number }>
  }
}

export interface ChatConversationRow {
  id: string
  title: string | null
  model: string
  session_id: string | null
  created_at: string
  updated_at: string
}

export interface ChatMessageRow {
  id: number
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface JobSummary {
  id: string
  command: string
  started_at: string
  status: JobStatus
  total_cost_usd: number | null
}

export interface Job {
  id: string
  command: string
  status: JobStatus
  queuePosition: number | null
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
}

export interface QueueMessage {
  type: 'queue'
  jobs: Job[]
  activeJobId: string | null
  paused: boolean
  timestamp: string
  projectId?: string
}

export interface InitMessage {
  type: 'init'
  projectName: string
  phases: Record<PhaseName, PhaseState>
  phaseDefinitions: PhaseDefinition[]
  logBuffer: LogMessage[]
  recentJobs: JobSummary[]
  queue: {
    jobs: Job[]
    activeJobId: string | null
    paused: boolean
  }
  projectId?: string
}

export interface EventMessage {
  type: 'event'
  jobId: string
  event_type: string
  source: string
  payload: string
  timestamp: string
  seq: number
  projectId?: string
}

export interface ChatStreamMessage {
  type: 'chat_stream'
  conversationId: string
  delta: string
  timestamp: string
  projectId?: string
}

export interface ChatDoneMessage {
  type: 'chat_done'
  conversationId: string
  fullText: string
  timestamp: string
  projectId?: string
}

export interface ChatErrorMessage {
  type: 'chat_error'
  conversationId: string
  error: string
  timestamp: string
  projectId?: string
}

export interface ChatCommandProposalMessage {
  type: 'chat_command_proposal'
  conversationId: string
  command: string
  timestamp: string
  projectId?: string
}

export interface ChatTitleUpdateMessage {
  type: 'chat_title_update'
  conversationId: string
  title: string
  timestamp: string
  projectId?: string
}

// ─── Hub-level message types ──────────────────────────────────────────────────

export interface HubProjectsMessage {
  type: 'hub.projects'
  projects: ProjectRow[]
  timestamp: string
}

export interface HubProjectAddedMessage {
  type: 'hub.project_added'
  project: ProjectRow
  timestamp: string
}

export interface HubProjectRemovedMessage {
  type: 'hub.project_removed'
  projectId: string
  timestamp: string
}

export type WsMessage =
  | LogMessage | PhaseMessage | InitMessage | QueueMessage | EventMessage
  | ChatStreamMessage | ChatDoneMessage | ChatErrorMessage
  | ChatCommandProposalMessage | ChatTitleUpdateMessage
  | HubProjectsMessage | HubProjectAddedMessage | HubProjectRemovedMessage

