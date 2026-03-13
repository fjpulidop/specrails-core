export type PhaseName = 'architect' | 'developer' | 'reviewer' | 'ship'
export type PhaseState = 'idle' | 'running' | 'done' | 'error'

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

export interface InitMessage {
  type: 'init'
  projectName: string
  phases: Record<PhaseName, PhaseState>
  logBuffer: LogMessage[]
}

export type WsMessage = LogMessage | PhaseMessage | InitMessage

export interface SpawnHandle {
  processId: string
  command: string
  startedAt: string
}

export class ClaudeNotFoundError extends Error {
  constructor() {
    super('claude binary not found')
    this.name = 'ClaudeNotFoundError'
  }
}

export class SpawnBusyError extends Error {
  constructor() {
    super('A process is already running')
    this.name = 'SpawnBusyError'
  }
}
