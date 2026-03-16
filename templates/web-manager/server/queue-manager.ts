import { spawn, execSync, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import treeKill from 'tree-kill'
import type { WsMessage, LogMessage, Job, PhaseDefinition } from './types'
import { resetPhases, setActivePhases } from './hooks'
import { createJob, finishJob, appendEvent } from './db'
import type { JobResult } from './db'
import type { CommandInfo } from './config'

const LOG_BUFFER_MAX = 5000
const LOG_BUFFER_DROP = 1000

// ─── Error classes ────────────────────────────────────────────────────────────

export class ClaudeNotFoundError extends Error {
  constructor() {
    super('claude binary not found')
    this.name = 'ClaudeNotFoundError'
  }
}

export class JobNotFoundError extends Error {
  constructor() {
    super('Job not found')
    this.name = 'JobNotFoundError'
  }
}

export class JobAlreadyTerminalError extends Error {
  constructor() {
    super('Job is already in terminal state')
    this.name = 'JobAlreadyTerminalError'
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function claudeOnPath(): boolean {
  try {
    execSync('which claude', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function extractDisplayText(event: Record<string, unknown>): string | null {
  const type = event.type as string
  if (type === 'assistant') {
    const content = event.message as { content?: Array<{ type: string; text?: string }> } | undefined
    const texts = (content?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
    return texts.join('') || null
  }
  if (type === 'tool_use') {
    const name = (event as Record<string, unknown>).name as string
    const input = JSON.stringify((event as Record<string, unknown>).input ?? {})
    return `[tool: ${name}] ${input.slice(0, 120)}`
  }
  if (type === 'tool_result' || type === 'system_prompt' || type === 'user' || type === 'system' || type === 'result') {
    return null
  }
  return null
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled'])

// ─── QueueManager ─────────────────────────────────────────────────────────────

export class QueueManager {
  private _queue: string[]
  private _jobs: Map<string, Job>
  private _activeProcess: ChildProcess | null
  private _activeJobId: string | null
  private _paused: boolean
  private _killTimer: ReturnType<typeof setTimeout> | null
  private _cancelingJobs: Set<string>
  private _broadcast: (msg: WsMessage) => void
  private _db: any
  private _logBuffer: LogMessage[]
  private _commands: CommandInfo[]

  constructor(broadcast: (msg: WsMessage) => void, db?: any, commands?: CommandInfo[]) {
    this._queue = []
    this._jobs = new Map()
    this._activeProcess = null
    this._activeJobId = null
    this._paused = false
    this._killTimer = null
    this._cancelingJobs = new Set()
    this._broadcast = broadcast
    this._db = db ?? null
    this._logBuffer = []
    this._commands = commands ?? []

    if (this._db) {
      this._restoreFromDb()
    }
  }

  setCommands(commands: CommandInfo[]): void {
    this._commands = commands
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  enqueue(command: string): Job {
    if (!claudeOnPath()) {
      throw new ClaudeNotFoundError()
    }

    const id = uuidv4()
    const job: Job = {
      id,
      command,
      status: 'queued',
      queuePosition: this._queue.length + 1,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
    }

    this._jobs.set(id, job)
    this._queue.push(id)
    this._persistJob(job)
    this._broadcastQueueState()
    this._drainQueue()

    return job
  }

  cancel(jobId: string): 'canceled' | 'canceling' {
    const job = this._jobs.get(jobId)
    if (!job) {
      throw new JobNotFoundError()
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      throw new JobAlreadyTerminalError()
    }

    if (job.status === 'queued') {
      const idx = this._queue.indexOf(jobId)
      if (idx !== -1) {
        this._queue.splice(idx, 1)
      }
      job.status = 'canceled'
      job.finishedAt = new Date().toISOString()
      this._recomputePositions()
      this._persistJob(job)
      this._broadcastQueueState()
      return 'canceled'
    }

    // job.status === 'running'
    this._kill(jobId)
    return 'canceling'
  }

  pause(): void {
    this._paused = true
    this._persistQueueState()
    this._broadcastQueueState()
  }

  resume(): void {
    this._paused = false
    this._persistQueueState()
    this._broadcastQueueState()
    this._drainQueue()
  }

  reorder(jobIds: string[]): void {
    const queuedSet = new Set(this._queue)
    const incomingSet = new Set(jobIds)

    if (queuedSet.size !== incomingSet.size) {
      throw new Error('jobIds must contain exactly the IDs of all currently-queued jobs')
    }
    for (const id of jobIds) {
      if (!queuedSet.has(id)) {
        throw new Error(`Job ${id} is not in queued state`)
      }
    }

    this._queue = [...jobIds]
    this._recomputePositions()

    if (this._db) {
      for (const id of jobIds) {
        const job = this._jobs.get(id)
        if (job) {
          this._persistJob(job)
        }
      }
    }

    this._broadcastQueueState()
  }

  getJobs(): Job[] {
    return Array.from(this._jobs.values())
  }

  getActiveJobId(): string | null {
    return this._activeJobId
  }

  isPaused(): boolean {
    return this._paused
  }

  getLogBuffer(): LogMessage[] {
    return [...this._logBuffer]
  }

  // ─── Private methods ────────────────────────────────────────────────────────

  phasesForCommand(command: string): PhaseDefinition[] {
    return this._phasesForCommand(command)
  }

  /**
   * Resolve a slash command into a full prompt with $ARGUMENTS substituted.
   * For /sr:implement #130 → reads .claude/commands/sr/implement.md, strips
   * frontmatter, replaces $ARGUMENTS with "#130". Non-slash commands pass through.
   */
  private _resolveCommand(command: string): string {
    const match = command.match(/^\/([^\s]+)\s*(.*)$/s)
    if (!match) return command

    const commandPath = match[1] // e.g. "sr:implement" or "sr:batch-implement"
    const commandArgs = match[2].trim() // e.g. "#130 #132 #133"

    // Convert "sr:implement" → ".claude/commands/sr/implement.md"
    const filePath = join(
      process.cwd(),
      '.claude', 'commands',
      ...commandPath.split(':').map((p) => p),
    ) + '.md'

    // Also try skills directory
    const skillPath = join(
      process.cwd(),
      '.claude', 'skills',
      ...commandPath.split(':').map((p) => p),
    ) + '.md'

    const resolvedPath = existsSync(filePath) ? filePath : existsSync(skillPath) ? skillPath : null

    if (!resolvedPath) {
      // Can't find the command file — pass through as-is
      return command
    }

    let content = readFileSync(resolvedPath, 'utf-8')

    // Strip YAML frontmatter
    content = content.replace(/^---[\s\S]*?---\s*/, '')

    // Substitute $ARGUMENTS
    content = content.replace(/\$ARGUMENTS/g, commandArgs)

    return content.trim()
  }

  private _phasesForCommand(command: string): PhaseDefinition[] {
    // Extract slug from command strings like "/sr:implement #5" or "implement"
    const firstToken = command.trim().split(/\s+/)[0]
    const slug = firstToken.includes(':') ? firstToken.split(':').pop()! : firstToken.replace(/^\//, '')
    const info = this._commands.find((c) => c.slug === slug)
    return info?.phases ?? []
  }

  private _drainQueue(): void {
    if (this._activeJobId !== null) return
    if (this._paused) return
    if (this._queue.length === 0) return

    const nextJobId = this._queue.shift()!
    this._startJob(nextJobId)
  }

  private _startJob(jobId: string): void {
    const job = this._jobs.get(jobId)
    if (!job) return

    job.status = 'running'
    job.startedAt = new Date().toISOString()
    job.queuePosition = null

    this._recomputePositions()
    this._persistJob(job)

    const commandPhases = this._phasesForCommand(job.command)
    if (commandPhases.length > 0) {
      setActivePhases(commandPhases, this._broadcast)
    } else {
      resetPhases(this._broadcast)
    }

    const trimmedCommand = job.command.trim()
    const args = [
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      '-p',
      this._resolveCommand(trimmedCommand),
    ]

    const child = spawn('claude', args, {
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this._activeProcess = child
    this._activeJobId = jobId

    let eventSeq = 0
    let lastResultEvent: Record<string, unknown> | null = null

    if (this._db) {
      createJob(this._db, { id: jobId, command: job.command, started_at: job.startedAt! })
    }

    const emitLine = (source: 'stdout' | 'stderr', line: string): void => {
      const msg: LogMessage = {
        type: 'log',
        source,
        line,
        timestamp: new Date().toISOString(),
        processId: jobId,
      }
      this._logBuffer.push(msg)
      if (this._logBuffer.length > LOG_BUFFER_MAX) {
        this._logBuffer.splice(0, LOG_BUFFER_DROP)
      }
      this._broadcast(msg)
    }

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { /* plain text */ }

      if (parsed) {
        const eventType = (parsed.type as string) ?? 'unknown'
        if (this._db) {
          appendEvent(this._db, jobId, eventSeq++, {
            event_type: eventType,
            source: 'stdout',
            payload: line,
          })
        }
        this._broadcast({
          type: 'event',
          jobId,
          event_type: eventType,
          source: 'stdout',
          payload: line,
          timestamp: new Date().toISOString(),
          seq: eventSeq - 1,
        })
        if (eventType === 'result') {
          lastResultEvent = parsed
        }
        const displayText = extractDisplayText(parsed)
        if (displayText !== null) {
          if (this._db) {
            appendEvent(this._db, jobId, eventSeq++, {
              event_type: 'log',
              source: 'stdout',
              payload: JSON.stringify({ line: displayText }),
            })
          }
          emitLine('stdout', displayText)
        }
      } else {
        if (this._db) {
          appendEvent(this._db, jobId, eventSeq++, {
            event_type: 'log',
            source: 'stdout',
            payload: JSON.stringify({ line }),
          })
        }
        emitLine('stdout', line)
      }
    })

    stderrReader.on('line', (line) => {
      if (this._db) {
        appendEvent(this._db, jobId, eventSeq++, {
          event_type: 'log',
          source: 'stderr',
          payload: JSON.stringify({ line }),
        })
      }
      emitLine('stderr', line)
    })

    child.on('close', (code) => {
      this._onJobExit(jobId, code, lastResultEvent, emitLine)
    })

    this._broadcastQueueState()
  }

  private _onJobExit(
    jobId: string,
    code: number | null,
    lastResultEvent: Record<string, unknown> | null,
    emitLine: (source: 'stdout' | 'stderr', line: string) => void
  ): void {
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer)
      this._killTimer = null
    }

    const job = this._jobs.get(jobId)
    if (!job) return

    const wasCanceling = this._cancelingJobs.has(jobId)
    this._cancelingJobs.delete(jobId)

    let finalStatus: Job['status']
    if (wasCanceling) {
      finalStatus = 'canceled'
    } else if (code === 0) {
      finalStatus = 'completed'
    } else {
      finalStatus = 'failed'
    }

    job.status = finalStatus
    job.finishedAt = new Date().toISOString()
    job.exitCode = code

    this._activeProcess = null
    this._activeJobId = null

    if (this._db) {
      let tokenData: Partial<JobResult> = {}
      if (lastResultEvent) {
        const usage = lastResultEvent.usage as Record<string, number> | undefined
        tokenData = {
          tokens_in: usage?.input_tokens,
          tokens_out: usage?.output_tokens,
          tokens_cache_read: usage?.cache_read_input_tokens,
          tokens_cache_create: usage?.cache_creation_input_tokens,
          total_cost_usd: lastResultEvent.total_cost_usd as number | undefined,
          num_turns: lastResultEvent.num_turns as number | undefined,
          model: lastResultEvent.model as string | undefined,
          duration_ms: lastResultEvent.duration_ms as number | undefined,
          duration_api_ms: lastResultEvent.api_duration_ms as number | undefined,
          session_id: lastResultEvent.session_id as string | undefined,
        }
      }
      finishJob(this._db, jobId, {
        exit_code: code ?? -1,
        status: finalStatus,
        ...tokenData,
      })
      const costStr = (lastResultEvent?.total_cost_usd as number | undefined) != null
        ? ` | cost: $${(lastResultEvent!.total_cost_usd as number).toFixed(4)}`
        : ''
      emitLine('stdout', `[process exited with code ${code ?? 'unknown'}${costStr}]`)
    } else {
      emitLine('stdout', `[process exited with code ${code ?? 'unknown'}]`)
    }

    this._broadcastQueueState()
    this._drainQueue()
  }

  private _kill(jobId: string): void {
    if (!this._activeProcess || !this._activeProcess.pid) return

    this._cancelingJobs.add(jobId)
    treeKill(this._activeProcess.pid, 'SIGTERM')

    const pid = this._activeProcess.pid
    this._killTimer = setTimeout(() => {
      treeKill(pid, 'SIGKILL')
      this._killTimer = null
    }, 5000)
  }

  private _broadcastQueueState(): void {
    this._broadcast({
      type: 'queue',
      jobs: this.getJobs(),
      activeJobId: this._activeJobId,
      paused: this._paused,
      timestamp: new Date().toISOString(),
    })
  }

  private _persistJob(job: Job): void {
    if (!this._db) return
    // For queued jobs, we use the DB to store queue position for startup restore.
    // We only upsert queue_position — the rest is handled by createJob/finishJob.
    // Since this method is called for all status transitions, we use a flexible upsert
    // that only touches queue_position (for queued jobs) — other fields are
    // managed by the existing createJob/finishJob API.
    try {
      this._db.prepare(
        `UPDATE jobs SET queue_position = ? WHERE id = ?`
      ).run(job.queuePosition ?? null, job.id)
    } catch {
      // Job may not exist in DB yet (e.g., queued before createJob is called in _startJob)
      // This is fine — we'll create the row when the job starts.
    }
  }

  private _persistQueueState(): void {
    if (!this._db) return
    try {
      this._db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', ?)`
      ).run(this._paused ? 'true' : 'false')
    } catch {
      // queue_state table may not exist if migration hasn't run
    }
  }

  private _restoreFromDb(): void {
    if (!this._db) return

    try {
      // Fail any jobs that were running when the server last shut down
      this._db.prepare(
        `UPDATE jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'`
      ).run()

      // Restore queued jobs in order
      const rows = this._db.prepare(
        `SELECT id, command, queue_position FROM jobs WHERE status = 'queued' ORDER BY queue_position ASC`
      ).all() as Array<{ id: string; command: string; queue_position: number | null }>

      for (const row of rows) {
        const job: Job = {
          id: row.id,
          command: row.command,
          status: 'queued',
          queuePosition: row.queue_position,
          startedAt: null,
          finishedAt: null,
          exitCode: null,
        }
        this._jobs.set(row.id, job)
        this._queue.push(row.id)
      }

      // Restore pause state
      const pauseRow = this._db.prepare(
        `SELECT value FROM queue_state WHERE key = 'paused'`
      ).get() as { value: string } | undefined

      this._paused = pauseRow?.value === 'true'
    } catch {
      // DB may not have queue_state table yet — ignore
    }
  }

  private _recomputePositions(): void {
    this._queue.forEach((id, index) => {
      const job = this._jobs.get(id)
      if (job) {
        job.queuePosition = index + 1
      }
    })
  }
}
