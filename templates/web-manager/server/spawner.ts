import { spawn, execSync, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { v4 as uuidv4 } from 'uuid'
import type { WsMessage, LogMessage, SpawnHandle } from './types'
import { ClaudeNotFoundError, SpawnBusyError } from './types'

// Circular log buffer
const LOG_BUFFER_MAX = 5000
const LOG_BUFFER_DROP = 1000
const logBuffer: LogMessage[] = []

let activeProcess: ChildProcess | null = null

function appendToBuffer(msg: LogMessage): void {
  logBuffer.push(msg)
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.splice(0, LOG_BUFFER_DROP)
  }
}

function claudeOnPath(): boolean {
  try {
    execSync('which claude', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function isSpawnActive(): boolean {
  return activeProcess !== null
}

export function getLogBuffer(): LogMessage[] {
  return [...logBuffer]
}

export function spawnClaude(
  command: string,
  broadcast: (msg: WsMessage) => void,
  onResetPhases: () => void
): SpawnHandle {
  if (!claudeOnPath()) {
    throw new ClaudeNotFoundError()
  }
  if (activeProcess !== null) {
    throw new SpawnBusyError()
  }

  onResetPhases()

  const processId = uuidv4()
  const startedAt = new Date().toISOString()

  // Split command string into args — simple space split is sufficient for
  // slash commands like /implement #42 for MVP
  const args = ['--dangerously-skip-permissions', ...command.trim().split(/\s+/)]
  const child = spawn('claude', args, {
    env: process.env,
    shell: false,
  })

  activeProcess = child

  function emitLine(source: 'stdout' | 'stderr', line: string): void {
    const msg: LogMessage = {
      type: 'log',
      source,
      line,
      timestamp: new Date().toISOString(),
      processId,
    }
    appendToBuffer(msg)
    broadcast(msg)
  }

  const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })

  stdoutReader.on('line', (line) => emitLine('stdout', line))
  stderrReader.on('line', (line) => emitLine('stderr', line))

  child.on('close', (code) => {
    emitLine('stdout', `[process exited with code ${code ?? 'unknown'}]`)
    activeProcess = null
  })

  return { processId, command, startedAt }
}
