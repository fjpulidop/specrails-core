import type { SubagentPhase } from '../../domain/types.js'
import type { DriverEvent } from '../../ports.js'
import type { ReportedUsage } from '../../domain/usage.js'

/**
 * Anti-corruption layer for `codex app-server` notifications (codex-cli 0.153.4
 * and 0.160.1). Deterministic and free of I/O. Pinned by the recorded transcripts:
 * - the session is one root thread; sub-agents are child threads. 0.153 announces
 *   them with a `collabAgentToolCall` (`spawnAgent`, `receiverThreadIds`); 0.160
 *   with a `subAgentActivity` item (`kind: started`, `agentThreadId`, `agentPath`)
 *   and no prompt, so the description comes from the agent's path name;
 * - every thread streams its own turn/item/tokenUsage notifications, interleaved;
 * - children keep running after the parent's turn completes; the parent never
 *   continues on its own (it collects them with `wait`).
 */
type Json = Record<string, unknown>

const TOOL_ITEMS = new Set(['commandExecution', 'mcpToolCall', 'fileChange', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'])

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function preview(value: unknown, limit = 16_384): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function toolName(item: Json): string {
  const type = str(item.type) ?? 'tool'
  if (type === 'mcpToolCall') return `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`
  if (type === 'collabAgentToolCall') return `agent.${str(item.tool) ?? 'call'}`
  return type
}

function toolFailed(item: Json): boolean {
  return ['failed', 'declined'].includes(str(item.status) ?? '') || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0) || !!item.error
}

/** `/root/run_tests` → `run tests` (0.160 sub-agents are named, not described). */
function describeAgentPath(agentPath: string | undefined): string {
  const name = agentPath?.split('/').filter(Boolean).pop() ?? ''
  return name.replace(/[_-]+/g, ' ').trim().slice(0, 200)
}

function tokens(usage: Json): ReportedUsage {
  return {
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheReadTokens: num(usage.cachedInputTokens),
    cacheWriteTokens: num(usage.cacheWriteInputTokens),
    totalTokens: num(usage.totalTokens),
  }
}

export class CodexTranslator {
  private rootThread: string | null = null
  private rootTurn: string | null = null
  /** Inputs whose `turn/start` was acknowledged, waiting for the turn notification. */
  private pendingInputs: string[] = []
  private rootText = ''
  private rootFinal: string | null = null
  private readonly streamed = new Map<string, string>()
  private readonly startedTools = new Set<string>()
  private readonly completedItems = new Set<string>()
  /** child thread → owner (null = root agent, else the owning child thread). */
  private readonly children = new Map<string, string | null>()
  private readonly childTurn = new Map<string, string | null>()
  private readonly childPhase = new Map<string, SubagentPhase>()
  private readonly childLastText = new Map<string, string>()
  private rootUsage: Json | null = null
  private model: string | null = null
  private interruptRequested = false

  setRoot(threadId: string, model: string | null): void { this.rootThread = threadId; this.model = model }
  get activeTurnId(): string | null { return this.rootTurn }
  noteTurnRequested(inputId: string): void { this.pendingInputs.push(inputId) }
  noteInterrupt(): void { if (this.rootTurn) this.interruptRequested = true }
  /** Child threads with a turn in progress. */
  liveChildren(): Array<{ threadId: string; turnId: string }> {
    return [...this.childTurn.entries()].filter((entry): entry is [string, string] => entry[1] !== null).map(([threadId, turnId]) => ({ threadId, turnId }))
  }

  /** A registered child thread (live or not). */
  isChild(threadId: string): boolean { return this.children.has(threadId) }
  /** The turn a child is running, if any. */
  childTurnOf(threadId: string): string | null { return this.childTurn.get(threadId) ?? null }

  notification(method: string, params: Json): DriverEvent[] {
    const threadId = str(params.threadId)
    if (method === 'error') {
      const message = str(obj(params.error).message) ?? 'Codex reported an error'
      return [{ kind: 'diagnostic', level: 'warning', code: params.willRetry === true ? 'provider.retrying' : 'provider.error', message: message.slice(0, 2_000) }]
    }
    if (!threadId) return []
    if (threadId === this.rootThread) return this.root(method, params)
    if (this.children.has(threadId)) return this.child(threadId, method, params)
    return []
  }

  // ── root thread ───────────────────────────────────────────────────────────

  private root(method: string, params: Json): DriverEvent[] {
    switch (method) {
      case 'turn/started': {
        const turnId = str(obj(params.turn).id)
        if (!turnId || this.rootTurn === turnId) return []
        this.rootTurn = turnId
        this.rootText = ''
        this.rootFinal = null
        const inputIds = this.pendingInputs
        this.pendingInputs = []
        return [{ kind: 'turn.started', trigger: inputIds.length > 0 ? 'input' : 'continuation', inputIds }]
      }
      case 'item/agentMessage/delta': {
        const delta = str(params.delta)
        const itemId = str(params.itemId)
        if (!delta || !itemId || this.completedItems.has(itemId)) return []
        this.streamed.set(itemId, (this.streamed.get(itemId) ?? '') + delta)
        return [{ kind: 'turn.output', channel: 'text', delta }]
      }
      case 'item/started':
      case 'item/completed':
        return this.item(null, obj(params.item), method === 'item/completed')
      case 'thread/tokenUsage/updated':
        this.rootUsage = obj(obj(params.tokenUsage).total)
        return []
      case 'turn/completed': {
        const turn = obj(params.turn)
        if (!this.rootTurn || str(turn.id) !== this.rootTurn) return []
        const events: DriverEvent[] = []
        for (const item of Array.isArray(turn.items) ? turn.items as Json[] : []) events.push(...this.item(null, item, true))
        const status = str(turn.status)
        const interrupted = this.interruptRequested || status === 'interrupted'
        this.interruptRequested = false
        this.rootTurn = null
        const error = str(obj(turn.error).message)
        events.push({
          kind: 'turn.completed',
          status: interrupted ? 'stopped' : status === 'failed' ? 'failed' : 'completed',
          text: this.rootFinal ?? this.rootText,
          ...(status === 'failed' && !interrupted ? { error: error ?? 'Codex turn failed' } : {}),
          usage: { ...(this.rootUsage ? tokens(this.rootUsage) : {}), model: this.model },
        })
        return events
      }
      default:
        return []
    }
  }

  // ── child threads (sub-agents) ────────────────────────────────────────────

  private child(threadId: string, method: string, params: Json): DriverEvent[] {
    switch (method) {
      case 'turn/started': {
        const turnId = str(obj(params.turn).id) ?? null
        this.childTurn.set(threadId, turnId)
        const events: DriverEvent[] = []
        if (this.childPhase.get(threadId) !== 'running') {
          // Re-entry (the parent sent it more work): restart under the same id.
          if (this.childPhase.has(threadId)) events.push({ kind: 'subagent.started', subagentId: threadId, parentId: this.children.get(threadId) ?? null, agentKind: 'background', agentType: 'codex-agent', description: 'Sub-agent' })
          this.childPhase.set(threadId, 'running')
        }
        events.push(this.roster())
        return events
      }
      case 'item/agentMessage/delta': {
        const delta = str(params.delta)
        const itemId = str(params.itemId)
        if (!delta || !itemId || this.completedItems.has(itemId)) return []
        this.streamed.set(itemId, (this.streamed.get(itemId) ?? '') + delta)
        return [{ kind: 'subagent.output', subagentId: threadId, channel: 'text', delta }]
      }
      case 'item/started':
      case 'item/completed':
        return this.item(threadId, obj(params.item), method === 'item/completed')
      case 'thread/tokenUsage/updated':
        return [{ kind: 'subagent.usage', subagentId: threadId, usage: tokens(obj(obj(params.tokenUsage).total)) }]
      case 'turn/completed': {
        const turn = obj(params.turn)
        this.childTurn.set(threadId, null)
        const status = str(turn.status)
        const phase: SubagentPhase = status === 'failed' ? 'failed' : status === 'interrupted' ? 'stopped' : 'idle'
        const events: DriverEvent[] = []
        for (const item of Array.isArray(turn.items) ? turn.items as Json[] : []) events.push(...this.item(threadId, item, true))
        const summary = this.childLastText.get(threadId)
        if (phase === 'idle' && summary) events.push({ kind: 'subagent.result', subagentId: threadId, summary })
        if (this.childPhase.get(threadId) !== phase) {
          this.childPhase.set(threadId, phase)
          events.push({ kind: 'subagent.phase', subagentId: threadId, phase })
        }
        events.push(this.roster())
        return events
      }
      default:
        return []
    }
  }

  // ── items ─────────────────────────────────────────────────────────────────

  private item(owner: string | null, item: Json, completed: boolean): DriverEvent[] {
    const id = str(item.id)
    const type = str(item.type)
    if (!id || !type || this.completedItems.has(id)) return []
    const events: DriverEvent[] = []
    if (type === 'agentMessage') {
      if (!completed) return []
      const text = str(item.text) ?? ''
      const already = this.streamed.get(id) ?? ''
      const rest = text.startsWith(already) ? text.slice(already.length) : ''
      if (rest) events.push(owner === null ? { kind: 'turn.output', channel: 'text', delta: rest } : { kind: 'subagent.output', subagentId: owner, channel: 'text', delta: rest })
      if (owner === null) {
        this.rootText = this.rootText ? `${this.rootText}\n\n${text}` : text
        if (item.phase === 'final_answer') this.rootFinal = text
      }
      else if (text) this.childLastText.set(owner, text)
    } else if (type === 'subAgentActivity') {
      // Child turns carry progress, results and phase; only the start registers.
      if (str(item.kind) === 'started') events.push(...this.registerChild(owner, str(item.agentThreadId), describeAgentPath(str(item.agentPath))))
    } else if (TOOL_ITEMS.has(type)) {
      const name = toolName(item)
      if (!this.startedTools.has(id)) {
        this.startedTools.add(id)
        const tool = { toolUseId: id, name, phase: 'started' as const, input: item.command ?? item.arguments ?? item.changes ?? item.prompt ?? item.query ?? null }
        events.push(owner === null ? { kind: 'turn.tool', ...tool } : { kind: 'subagent.output', subagentId: owner, channel: 'tool', tool })
      }
      if (completed) {
        if (type === 'collabAgentToolCall') events.push(...this.collab(owner, item))
        const tool = { toolUseId: id, name, phase: 'completed' as const, output: preview(item.aggregatedOutput ?? item.result ?? item.error ?? item.agentsStates ?? { status: item.status }), ...(toolFailed(item) ? { isError: true } : {}) }
        events.push(owner === null ? { kind: 'turn.tool', ...tool } : { kind: 'subagent.output', subagentId: owner, channel: 'tool', tool })
      }
    }
    if (completed) this.completedItems.add(id)
    return events
  }

  private collab(owner: string | null, item: Json): DriverEvent[] {
    const events: DriverEvent[] = []
    if (str(item.tool) === 'spawnAgent') {
      const prompt = str(item.prompt) ?? ''
      for (const childId of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds as unknown[] : []) {
        if (typeof childId === 'string') events.push(...this.registerChild(owner, childId, (prompt.split('\n')[0] ?? '').slice(0, 200), prompt))
      }
    }
    // `wait` reports the final message of finished children.
    for (const [childId, state] of Object.entries(obj(item.agentsStates))) {
      const message = str(obj(state).message)
      if (this.children.has(childId) && obj(state).status === 'completed' && message && message !== this.childLastText.get(childId)) {
        this.childLastText.set(childId, message)
        events.push({ kind: 'subagent.result', subagentId: childId, summary: message })
      }
    }
    return events
  }

  private registerChild(owner: string | null, childId: string | undefined, description: string, prompt = ''): DriverEvent[] {
    if (!childId || this.children.has(childId)) return []
    this.children.set(childId, owner)
    this.childPhase.set(childId, 'running')
    this.childTurn.set(childId, this.childTurn.get(childId) ?? null)
    return [{
      kind: 'subagent.started',
      subagentId: childId,
      parentId: owner,
      agentKind: 'background',
      agentType: 'codex-agent',
      description: description || 'Sub-agent',
      ...(prompt ? { prompt } : {}),
    }]
  }

  private roster(): DriverEvent {
    return { kind: 'roster', liveSubagentIds: this.liveChildren().map((child) => child.threadId) }
  }
}
