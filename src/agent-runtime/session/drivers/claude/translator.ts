import type { SubagentPhase } from '../../domain/types.js'
import type { DriverEvent } from '../../ports.js'

/**
 * Anti-corruption layer for Claude Code `--output-format stream-json`.
 * Deterministic and free of I/O: one wire frame in, normalized events out.
 * Behaviour pinned by the recorded transcripts (Claude Code 2.1.285):
 * - `command_lifecycle` = per-input receipts; the CLI serializes turns itself;
 * - a turn runs from `system/init` to `result`; turns without a started input
 *   are the CLI's own continuations (result `origin.kind = task-notification`);
 * - sub-agents and their shells are `task_*` frames; their messages carry
 *   `parent_tool_use_id`; the same task id restarts after reporting completion.
 */
type Frame = Record<string, unknown>

const TASK_PHASE: Readonly<Record<string, SubagentPhase>> = Object.freeze({
  completed: 'idle',
  failed: 'failed',
  stopped: 'stopped',
  killed: 'killed',
})

/** System subtypes that carry nothing the session model needs. */
const IGNORED_SYSTEM = new Set(['thinking_tokens', 'task_summary', 'post_turn_summary', 'status', 'hook_response', 'hook_started', 'compact_boundary'])
const IGNORED_TYPES = new Set(['rate_limit_event', 'stream_event', 'keep_alive'])

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && (part as Frame).type === 'text' ? String((part as Frame).text ?? '') : '')).join('')
  return ''
}

export class ClaudeTranslator {
  private sessionRef: string | null = null
  private turnOpen = false
  private interruptRequested = false
  private readonly written = new Set<string>()
  private startedInputs: string[] = []
  /** tool_use id → task id of the agent that issued it (null = main agent). */
  private readonly toolOwner = new Map<string, string | null>()
  private readonly toolName = new Map<string, string>()
  /** Agent/Task tool_use id → task id it became. */
  private readonly taskByToolUse = new Map<string, string>()
  private readonly taskPhase = new Map<string, SubagentPhase>()
  private readonly reportedUnknown = new Set<string>()

  /** The driver wrote this input; its receipts and replays belong to us. */
  noteInput(inputId: string): void { this.written.add(inputId) }
  noteInterrupt(): void { if (this.turnOpen) this.interruptRequested = true }

  translate(frame: Frame): DriverEvent[] {
    const type = str(frame.type)
    switch (type) {
      case 'system': return this.system(frame)
      case 'command_lifecycle': return this.lifecycle(frame)
      case 'assistant': return this.assistant(frame)
      case 'user': return this.user(frame)
      case 'result': return this.result(frame)
      default:
        if (type && IGNORED_TYPES.has(type)) return []
        return this.unknown(`type:${type ?? '<missing>'}`)
    }
  }

  private system(frame: Frame): DriverEvent[] {
    const subtype = str(frame.subtype) ?? ''
    switch (subtype) {
      case 'init': {
        const events: DriverEvent[] = []
        const ref = str(frame.session_id)
        if (ref && ref !== this.sessionRef) { this.sessionRef = ref; events.push({ kind: 'provider.ref', providerSessionRef: ref }) }
        if (!this.turnOpen) {
          this.turnOpen = true
          const inputIds = this.startedInputs
          this.startedInputs = []
          events.push({ kind: 'turn.started', trigger: inputIds.length > 0 ? 'input' : 'continuation', inputIds })
        }
        return events
      }
      case 'task_started': return this.taskStarted(frame)
      case 'task_progress': {
        const taskId = str(frame.task_id)
        const usage = frame.usage as Frame | undefined
        if (!taskId || !this.taskPhase.has(taskId)) return []
        return [{
          kind: 'subagent.usage',
          subagentId: taskId,
          usage: { totalTokens: num(usage?.total_tokens) ?? null },
          ...(num(usage?.tool_uses) !== undefined ? { toolUses: num(usage?.tool_uses)! } : {}),
          ...(num(usage?.duration_ms) !== undefined ? { durationMs: num(usage?.duration_ms)! } : {}),
        }]
      }
      case 'task_updated': {
        const taskId = str(frame.task_id)
        const status = str((frame.patch as Frame | undefined)?.status)
        return taskId && status ? this.phase(taskId, status) : []
      }
      case 'task_notification': {
        const taskId = str(frame.task_id)
        const status = str(frame.status)
        if (!taskId || !this.taskPhase.has(taskId)) return []
        const usage = frame.usage as Frame | undefined
        const summary = str(frame.summary)
        return [
          ...(usage ? [{ kind: 'subagent.usage' as const, subagentId: taskId, usage: { totalTokens: num(usage.total_tokens) ?? null }, ...(num(usage.tool_uses) !== undefined ? { toolUses: num(usage.tool_uses)! } : {}), ...(num(usage.duration_ms) !== undefined ? { durationMs: num(usage.duration_ms)! } : {}) }] : []),
          ...(status === 'completed' && summary ? [{ kind: 'subagent.result' as const, subagentId: taskId, summary }] : []),
          ...(status ? this.phase(taskId, status) : []),
        ]
      }
      case 'background_tasks_changed': {
        const tasks = Array.isArray(frame.tasks) ? frame.tasks as Frame[] : null
        if (!tasks) return []
        return [{ kind: 'roster', liveSubagentIds: tasks.filter((task) => task?.ambient !== true).map((task) => str(task?.task_id)).filter((id): id is string => !!id) }]
      }
      default:
        return IGNORED_SYSTEM.has(subtype) ? [] : this.unknown(`system:${subtype}`)
    }
  }

  private taskStarted(frame: Frame): DriverEvent[] {
    const taskId = str(frame.task_id)
    if (!taskId) return []
    const toolUseId = str(frame.tool_use_id)
    if (toolUseId) this.taskByToolUse.set(toolUseId, taskId)
    const restarted = this.taskPhase.has(taskId)
    this.taskPhase.set(taskId, 'running')
    const isShell = frame.task_type === 'local_bash'
    const parentId = toolUseId ? this.toolOwner.get(toolUseId) ?? null : null
    const prompt = str(frame.prompt)
    return [{
      kind: 'subagent.started',
      subagentId: taskId,
      parentId,
      agentKind: frame.is_backgrounded === true ? 'background' : 'foreground',
      agentType: isShell ? 'shell' : str(frame.subagent_type) ?? 'agent',
      description: str(frame.description) ?? (isShell ? 'Background command' : 'Sub-agent'),
      ...(prompt && !restarted ? { prompt } : {}),
    }]
  }

  private phase(taskId: string, status: string): DriverEvent[] {
    const phase = TASK_PHASE[status]
    if (!phase || !this.taskPhase.has(taskId) || this.taskPhase.get(taskId) === phase) return []
    this.taskPhase.set(taskId, phase)
    return [{ kind: 'subagent.phase', subagentId: taskId, phase }]
  }

  private lifecycle(frame: Frame): DriverEvent[] {
    const inputId = str(frame.command_uuid)
    const state = str(frame.state)
    if (!inputId || !this.written.has(inputId)) return []
    if (state === 'started' && !this.turnOpen) this.startedInputs.push(inputId)
    if (state === 'queued' || state === 'started' || state === 'completed') return [{ kind: 'input.receipt', inputId, state }]
    if (state === 'failed' || state === 'rejected' || state === 'cancelled') return [{ kind: 'input.receipt', inputId, state: 'rejected', reason: state }]
    return []
  }

  private ownerOf(frame: Frame): string | null | undefined {
    const parent = str(frame.parent_tool_use_id)
    if (!parent) return null
    return this.taskByToolUse.get(parent)
  }

  private assistant(frame: Frame): DriverEvent[] {
    const owner = this.ownerOf(frame)
    if (owner === undefined) return this.unknown('assistant:unattributed-parent')
    const content = ((frame.message as Frame | undefined)?.content ?? []) as Frame[]
    const events: DriverEvent[] = []
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        events.push(owner === null
          ? { kind: 'turn.output', channel: 'text', delta: block.text }
          : { kind: 'subagent.output', subagentId: owner, channel: 'text', delta: block.text })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking && owner === null) {
        events.push({ kind: 'turn.output', channel: 'thinking', delta: block.thinking })
      } else if (block.type === 'tool_use') {
        const id = str(block.id)
        const name = str(block.name) ?? 'tool'
        if (!id) continue
        this.toolOwner.set(id, owner)
        this.toolName.set(id, name)
        const tool = { toolUseId: id, name, phase: 'started' as const, input: block.input }
        events.push(owner === null ? { kind: 'turn.tool', ...tool } : { kind: 'subagent.output', subagentId: owner, channel: 'tool', tool })
      }
    }
    return events
  }

  private user(frame: Frame): DriverEvent[] {
    const uuid = str(frame.uuid)
    if (uuid && this.written.has(uuid)) return [] // replay of our own input
    const owner = this.ownerOf(frame)
    const content = (frame.message as Frame | undefined)?.content
    if (!Array.isArray(content)) return []
    const events: DriverEvent[] = []
    for (const block of content as Frame[]) {
      if (block.type !== 'tool_result') continue
      const id = str(block.tool_use_id)
      if (!id) continue
      const issuer = this.toolOwner.has(id) ? this.toolOwner.get(id)! : owner ?? null
      const tool = { toolUseId: id, name: this.toolName.get(id) ?? 'tool', phase: 'completed' as const, output: textOf(block.content).slice(0, 16_384), ...(block.is_error === true ? { isError: true } : {}) }
      events.push(issuer === null ? { kind: 'turn.tool', ...tool } : { kind: 'subagent.output', subagentId: issuer, channel: 'tool', tool })
    }
    return events
  }

  private result(frame: Frame): DriverEvent[] {
    const origin = (frame.origin as Frame | undefined)?.kind
    const text = str(frame.result) ?? ''
    if (!this.turnOpen) {
      // An orphan notification on resume (num_turns 0, empty) carries nothing.
      if (origin === 'task-notification') return []
      return this.unknown('result:without-turn')
    }
    this.turnOpen = false
    const interrupted = this.interruptRequested
    this.interruptRequested = false
    const failed = frame.is_error === true || (str(frame.subtype) !== undefined && frame.subtype !== 'success')
    const usage = frame.usage as Frame | undefined
    const modelUsage = frame.modelUsage as Frame | undefined
    return [{
      kind: 'turn.completed',
      status: interrupted ? 'stopped' : failed ? 'failed' : 'completed',
      text,
      ...(failed && !interrupted ? { error: text || str(frame.subtype) || 'Provider reported an error' } : {}),
      usage: {
        costUsd: num(frame.total_cost_usd) ?? null,
        inputTokens: num(usage?.input_tokens) ?? null,
        outputTokens: num(usage?.output_tokens) ?? null,
        cacheReadTokens: num(usage?.cache_read_input_tokens) ?? null,
        cacheWriteTokens: num(usage?.cache_creation_input_tokens) ?? null,
        model: modelUsage ? Object.keys(modelUsage)[0] ?? null : null,
      },
    }]
  }

  private unknown(code: string): DriverEvent[] {
    if (this.reportedUnknown.has(code)) return []
    this.reportedUnknown.add(code)
    return [{ kind: 'diagnostic', level: 'info', code: 'provider.unknown', message: `Unrecognised Claude frame (${code})` }]
  }
}
