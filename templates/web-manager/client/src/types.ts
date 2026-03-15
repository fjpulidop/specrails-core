export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface PhaseDefinition {
  key: string
  label: string
  description: string
}

export interface JobSummary {
  id: string
  command: string
  started_at: string
  finished_at?: string | null
  status: JobStatus
  total_cost_usd?: number | null
  duration_ms?: number | null
  model?: string | null
  tokens_in?: number | null
  tokens_out?: number | null
  tokens_cache_read?: number | null
  tokens_cache_create?: number | null
  num_turns?: number | null
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

export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all' | 'custom'

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

export interface ChatConversationSummary {
  id: string
  title: string | null
  model: string
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  id: number
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}
