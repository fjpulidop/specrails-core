export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface JobSummary {
  id: string
  command: string
  started_at: string
  finished_at?: string | null
  status: JobStatus
  total_cost_usd?: number | null
  duration_ms?: number | null
  model?: string | null
}

export interface EventRow {
  id: number
  job_id: string
  seq: number
  event_type: string
  source?: string | null
  payload: string
  timestamp: string
}

export interface CommandInfo {
  id: string
  name: string
  description: string
  slug: string
}

export interface ProjectConfig {
  project: {
    name: string
    repo: string | null
  }
  issueTracker: {
    github: { available: boolean; authenticated: boolean }
    jira: { available: boolean; authenticated: boolean }
    active: 'github' | 'jira' | null
    labelFilter: string
  }
  commands: CommandInfo[]
}

export interface IssueItem {
  number: number
  title: string
  labels: string[]
  body: string
  url?: string
}
