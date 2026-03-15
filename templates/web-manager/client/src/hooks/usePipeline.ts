import { useState, useCallback } from 'react'
import { useWebSocket } from './useWebSocket'
import type { Job } from '../components/JobQueueSidebar'

type PhaseName = 'architect' | 'developer' | 'reviewer' | 'ship'
type PhaseState = 'idle' | 'running' | 'done' | 'error'

export interface PhaseMap {
  architect: PhaseState
  developer: PhaseState
  reviewer: PhaseState
  ship: PhaseState
}

export interface LogLine {
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
  processId: string
}

export interface JobSummary {
  id: string
  command: string
  started_at: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  total_cost_usd: number | null
}

export interface QueueState {
  jobs: Job[]
  activeJobId: string | null
  paused: boolean
}

const INITIAL_PHASES: PhaseMap = {
  architect: 'idle',
  developer: 'idle',
  reviewer: 'idle',
  ship: 'idle',
}

const INITIAL_QUEUE: QueueState = {
  jobs: [],
  activeJobId: null,
  paused: false,
}

export function usePipeline() {
  const [phases, setPhases] = useState<PhaseMap>(INITIAL_PHASES)
  const [projectName, setProjectName] = useState('')
  const [logLines, setLogLines] = useState<LogLine[]>([])
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([])
  const [queueState, setQueueState] = useState<QueueState>(INITIAL_QUEUE)

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type: string } & Record<string, unknown>

    if (msg.type === 'init') {
      setProjectName((msg.projectName as string) ?? '')
      setPhases((msg.phases as PhaseMap) ?? INITIAL_PHASES)
      const buf = (msg.logBuffer as LogLine[]) ?? []
      setLogLines(buf)
      setRecentJobs((msg.recentJobs as JobSummary[]) ?? [])
      const q = msg.queue as QueueState | undefined
      if (q) setQueueState(q)
    } else if (msg.type === 'phase') {
      setPhases((prev) => ({
        ...prev,
        [msg.phase as PhaseName]: msg.state as PhaseState,
      }))
    } else if (msg.type === 'log') {
      setLogLines((prev) => [
        ...prev,
        {
          source: msg.source as 'stdout' | 'stderr',
          line: msg.line as string,
          timestamp: msg.timestamp as string,
          processId: msg.processId as string,
        },
      ])
    } else if (msg.type === 'queue') {
      setQueueState({
        jobs: (msg.jobs as Job[]) ?? [],
        activeJobId: (msg.activeJobId as string | null) ?? null,
        paused: (msg.paused as boolean) ?? false,
      })
    }
  }, [])

  const { connectionStatus } = useWebSocket('ws://localhost:4200', handleMessage)

  return { phases, projectName, logLines, connectionStatus, recentJobs, queueState }
}
