import { useState, useCallback, useLayoutEffect } from 'react'
import { useSharedWebSocket } from './useSharedWebSocket'
import type { JobSummary, PhaseDefinition } from '../types'
import { getApiBase } from '../lib/api'

export type PhaseState = 'idle' | 'running' | 'done' | 'error'
export type PhaseMap = Record<string, PhaseState>

export interface LogLine {
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
  processId: string
}

export interface QueueJob {
  id: string
  command: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  queuePosition: number | null
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
}

export interface QueueState {
  jobs: QueueJob[]
  activeJobId: string | null
  paused: boolean
}

const INITIAL_QUEUE: QueueState = {
  jobs: [],
  activeJobId: null,
  paused: false,
}

export function usePipeline() {
  const [phaseDefinitions, setPhaseDefinitions] = useState<PhaseDefinition[]>([])
  const [phases, setPhases] = useState<PhaseMap>({})
  const [projectName, setProjectName] = useState('')
  const [logLines, setLogLines] = useState<LogLine[]>([])
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([])
  const [queueState, setQueueState] = useState<QueueState>(INITIAL_QUEUE)

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type: string; projectId?: string } & Record<string, unknown>

    // In hub mode, ignore messages that don't belong to the active project.
    // getApiBase() encodes the active project: '/api/projects/<id>' in hub mode.
    const apiBase = getApiBase()
    const activeProjectId = apiBase.startsWith('/api/projects/')
      ? apiBase.split('/api/projects/')[1]
      : null

    if (activeProjectId && msg.projectId && msg.projectId !== activeProjectId) {
      return
    }

    if (msg.type === 'init') {
      setProjectName((msg.projectName as string) ?? '')
      const defs = (msg.phaseDefinitions ?? []) as PhaseDefinition[]
      setPhaseDefinitions(defs)
      const initialPhases: PhaseMap = {}
      for (const def of defs) {
        initialPhases[def.key] = ((msg.phases as Record<string, PhaseState>)?.[def.key]) ?? 'idle'
      }
      setPhases(initialPhases)
      const buf = (msg.logBuffer as LogLine[]) ?? []
      setLogLines(buf)
      setRecentJobs((msg.recentJobs as JobSummary[]) ?? [])
      const q = msg.queue as QueueState | undefined
      if (q) setQueueState(q)
    } else if (msg.type === 'phase') {
      setPhases((prev) => ({
        ...prev,
        [msg.phase as string]: msg.state as PhaseState,
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
        jobs: (msg.jobs as QueueJob[]) ?? [],
        activeJobId: (msg.activeJobId as string | null) ?? null,
        paused: (msg.paused as boolean) ?? false,
      })
    }
  }, [])

  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()

  // useLayoutEffect ensures the handler is registered synchronously before
  // the browser paints, eliminating the frame gap where an 'init' message
  // could arrive before the handler is registered.
  useLayoutEffect(() => {
    registerHandler('pipeline', handleMessage)
    return () => unregisterHandler('pipeline')
  }, [handleMessage, registerHandler, unregisterHandler])

  return { phases, phaseDefinitions, projectName, logLines, connectionStatus, recentJobs, queueState }
}
