export type PhaseName = string
export type PhaseState = 'idle' | 'running' | 'done' | 'error'

export interface PhaseDefinition {
  key: string
  label: string
  description: string
}

export interface LogMessage {
  type: 'log'
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
  processId: string
}

export interface PhaseMessage {
  type: 'phase'
  phase: PhaseName
  state: PhaseState
  timestamp: string
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
}

export interface EventMessage {
  type: 'event'
  jobId: string
  event_type: string
  source: string
  payload: string
  timestamp: string
  seq: number
}

export type WsMessage = LogMessage | PhaseMessage | InitMessage | QueueMessage | EventMessage

