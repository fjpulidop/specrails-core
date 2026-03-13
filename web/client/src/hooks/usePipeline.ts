import { useState, useCallback } from 'react'
import { useWebSocket } from './useWebSocket'

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

const INITIAL_PHASES: PhaseMap = {
  architect: 'idle',
  developer: 'idle',
  reviewer: 'idle',
  ship: 'idle',
}

export function usePipeline() {
  const [phases, setPhases] = useState<PhaseMap>(INITIAL_PHASES)
  const [projectName, setProjectName] = useState('')
  const [logLines, setLogLines] = useState<LogLine[]>([])

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type: string } & Record<string, unknown>

    if (msg.type === 'init') {
      setProjectName((msg.projectName as string) ?? '')
      setPhases((msg.phases as PhaseMap) ?? INITIAL_PHASES)
      const buf = (msg.logBuffer as LogLine[]) ?? []
      setLogLines(buf)
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
    }
  }, [])

  const { connectionStatus } = useWebSocket('ws://localhost:3001', handleMessage)

  return { phases, projectName, logLines, connectionStatus }
}
