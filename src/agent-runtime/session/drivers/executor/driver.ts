import { AgentExecutionError, type AgentEvent, type AgentExecutor, type AgentUsage } from '../../../executor-types.js'
import type { DriverDescriptor } from '../../domain/types.js'
import type { ReportedUsage } from '../../domain/usage.js'
import type { CloseReason, DriverEventSink, DriverFactory, DriverInput, DriverOpenSpec, DriverSession } from '../../ports.js'

/**
 * Adapter from the batch `AgentExecutor` contract (one request, one result) to
 * the session driver contract. Each input runs as one executor invocation that
 * resumes the provider session when the executor supports continuation.
 * Declares exactly what it cannot do; the application adapts to it.
 */
export function executorDescriptor(id: string, displayName: string): DriverDescriptor {
  return Object.freeze({
    id,
    displayName,
    capabilities: Object.freeze({
      resident: false,
      nativeInputQueue: false,
      subagents: 'unsupported' as const,
      subagentDisable: false,
    subagentModel: false,
    subagentEffort: false,
      autonomousContinuation: false,
      steer: false,
      toolFiltering: false,
      usage: Object.freeze({ costUsd: 'per-turn' as const, tokens: 'per-turn' as const }),
    }),
  })
}

export interface ExecutorDriverOptions {
  /** Per-invocation limits forwarded to the executor. */
  timeoutMs?: number
  idleTimeoutMs?: number
}

function reported(usage: AgentUsage | undefined): ReportedUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheReadInputTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteInputTokens ?? null,
    costUsd: usage?.costUsd ?? null,
  }
}

class ExecutorDriverSession implements DriverSession {
  private running: AbortController | null = null
  private closed = false
  private sessionRef: string | null
  private toolSeq = 0
  private firstTurn: boolean

  constructor(private readonly executor: AgentExecutor, private readonly spec: DriverOpenSpec, private readonly sink: DriverEventSink, private readonly options: ExecutorDriverOptions) {
    this.sessionRef = spec.providerSessionRef
    this.firstTurn = spec.providerSessionRef === null
  }

  async send(input: DriverInput): Promise<void> {
    if (this.closed) throw new Error('Session driver is closed')
    if (this.running) throw new Error('This provider runs one turn at a time')
    const controller = new AbortController()
    this.running = controller
    this.sink({ kind: 'input.receipt', inputId: input.inputId, state: 'started' })
    this.sink({ kind: 'turn.started', trigger: 'input', inputIds: [input.inputId] })
    // Run in the background: receipts and output arrive as events, like resident drivers.
    void this.run(input, controller)
  }

  private async run(input: DriverInput, controller: AbortController): Promise<void> {
    const openTools: string[] = []
    let text = ''
    const files = (input.attachments ?? []).map((item) => `- ${item.path}`)
    const prompt = [
      this.firstTurn && this.spec.systemPrompt ? `${this.spec.systemPrompt}\n\n` : '',
      input.text,
      files.length ? `\n\nAttached files:\n${files.join('\n')}` : '',
    ].join('')
    try {
      const result = await this.executor.execute({
        role: 'session',
        access: this.spec.policy.permissions === 'read-only' ? 'read' : 'write',
        artifacts: 'none',
        instructions: 'none',
        prompt,
        cwd: this.spec.cwd,
        allowedRoots: [this.spec.cwd],
        model: this.spec.model,
        ...(this.spec.effort ? { effort: this.spec.effort } : {}),
        ...(this.sessionRef ? { resumeSessionId: this.sessionRef } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.options.idleTimeoutMs } : {}),
        signal: controller.signal,
        onEvent: (event: AgentEvent) => {
          if (this.closed) return
          if (event.kind === 'session' && event.sessionId && event.sessionId !== this.sessionRef) {
            this.sessionRef = event.sessionId
            this.sink({ kind: 'provider.ref', providerSessionRef: event.sessionId })
          } else if (event.kind === 'text' && event.text) {
            text += event.text
            this.sink({ kind: 'turn.output', channel: 'text', delta: event.text })
          } else if (event.kind === 'tool-start') {
            const id = `tool-${++this.toolSeq}`
            openTools.push(id)
            this.sink({ kind: 'turn.tool', toolUseId: id, name: event.tool ?? 'tool', phase: 'started', ...(event.detail ? { input: event.detail } : {}) })
          } else if (event.kind === 'tool-end') {
            const id = openTools.shift()
            if (id) this.sink({ kind: 'turn.tool', toolUseId: id, name: event.tool ?? 'tool', phase: 'completed', ...(event.detail ? { output: event.detail } : {}) })
          }
        },
      })
      this.firstTurn = false
      if (result.sessionId && result.sessionId !== this.sessionRef) {
        this.sessionRef = result.sessionId
        this.sink({ kind: 'provider.ref', providerSessionRef: result.sessionId })
      }
      if (result.text && !text) this.sink({ kind: 'turn.output', channel: 'text', delta: result.text })
      this.sink({ kind: 'turn.completed', status: 'completed', text: result.text, usage: reported(result.usage) })
    } catch (error) {
      if (this.closed) return
      const failure = error instanceof AgentExecutionError ? error : null
      const stopped = failure?.code === 'aborted'
      this.sink({
        kind: 'turn.completed',
        status: stopped ? 'stopped' : 'failed',
        text,
        ...(stopped ? {} : { error: (error as Error).message }),
        usage: reported(failure?.usage),
      })
    } finally {
      if (this.running === controller) this.running = null
    }
  }

  async interrupt(): Promise<void> {
    this.running?.abort()
  }

  async stopSubagents(): Promise<string[]> {
    return []
  }

  async close(_reason: CloseReason): Promise<void> {
    this.closed = true
    this.running?.abort()
  }
}

export class ExecutorDriverFactory implements DriverFactory {
  constructor(readonly descriptor: DriverDescriptor, private readonly executor: AgentExecutor, private readonly options: ExecutorDriverOptions = {}) {}

  async open(spec: DriverOpenSpec, sink: DriverEventSink): Promise<DriverSession> {
    sink({ kind: 'process.started' })
    return new ExecutorDriverSession(this.executor, spec, sink, this.options)
  }
}
