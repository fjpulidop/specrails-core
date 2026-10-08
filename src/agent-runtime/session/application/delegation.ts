import { SessionError } from '../domain/errors.js'
import type { SessionEventEnvelope } from '../domain/events.js'
import { delegatedSubagents, type SessionPolicyInput } from '../domain/policy.js'
import type { SessionSnapshot } from '../domain/snapshot.js'
import type { Usage } from '../domain/types.js'
import type { Ids, SessionJournal } from '../ports.js'
import type { ActiveSession } from './active-session.js'

/** What the coordinator needs from the session service (no cycle with its internals). */
export interface DelegationPort {
  journal: SessionJournal
  ids: Ids
  /** The open parent session, activated if needed; throws when unknown or closed. */
  parent(sessionId: string): ActiveSession
  open(params: { sessionId: string; driver: string; model: string; effort?: string; cwd: string; systemPrompt: string; policy: SessionPolicyInput; metadata: Record<string, unknown> }): Promise<unknown>
  send(sessionId: string, input: { inputId: string; text: string; delivery: 'queue' }): Promise<unknown>
  interrupt(sessionId: string): Promise<unknown>
  close(sessionId: string, reason: string): Promise<void>
  snapshot(sessionId: string): SessionSnapshot
}

export interface DelegateParams {
  description: string
  prompt: string
  agentType?: string
  /** Recent parent turns (user inputs and replies) to hand over as context. */
  contextTurns?: number
}

export interface DelegatedResult {
  subagentId: string
  description: string
  status: 'completed' | 'failed' | 'stopped' | 'interrupted'
  result: string
}

type Outcome = { status: DelegatedResult['status']; text: string; usage: Usage | null; reason?: string }

interface Child {
  childId: string
  parentId: string
  description: string
  outcome: Outcome | null
  collected: boolean
  waiters: Set<() => void>
}

const SYSTEM_PROMPT = [
  'You are a sub-agent: another agent working in this same workspace delegated a task to you.',
  'Complete it on your own; nobody can answer questions.',
  'Finish with a concise, self-contained result the delegating agent can act on: what you found or changed, where, and anything left open.',
].join(' ')

const MAX_CONTEXT_TURNS = 10

/**
 * Core-launched sub-agents (delegated runtime). Each one is a child session on
 * the policy's driver, model and effort; the parent sees it as a sub-agent of
 * its own tree. Results reach the parent through an explicit wait or, when
 * nobody waits, a continuation turn (see ActiveSession.delegatedFinished).
 */
export class DelegationCoordinator {
  private readonly children = new Map<string, Child>()

  constructor(private readonly port: DelegationPort) {}

  async delegate(parentId: string, params: DelegateParams): Promise<{ subagentId: string }> {
    const parent = this.port.parent(parentId)
    const policy = parent.policy
    if (!delegatedSubagents(policy)) {
      throw new SessionError('invalid_params', 'This session does not delegate sub-agents; its provider launches them itself', { path: 'sessionId' })
    }
    const runtime = policy.subagentRuntime
    if (parent.delegatedLive().length >= runtime.maxConcurrent) {
      throw new SessionError('limit_reached', `At most ${runtime.maxConcurrent} delegated sub-agents can run at once`, { limit: runtime.maxConcurrent })
    }
    const description = params.description.trim().slice(0, 200) || 'Sub-agent'
    const childId = this.port.ids.session()
    const cwd = this.port.journal.getSession(parentId)?.cwd
    if (!cwd) throw new SessionError('internal', `Session ${parentId} has no working directory`)
    const child: Child = { childId, parentId, description, outcome: null, collected: false, waiters: new Set() }
    this.children.set(childId, child)
    parent.delegatedStarted({ subagentId: childId, description, agentType: params.agentType ?? `${runtime.driver}:${runtime.model}`, prompt: params.prompt, driver: runtime.driver, model: runtime.model })
    try {
      await this.port.open({
        sessionId: childId,
        driver: runtime.driver,
        model: runtime.model,
        ...(runtime.effort ? { effort: runtime.effort } : {}),
        cwd,
        systemPrompt: SYSTEM_PROMPT,
        // Depth 1: a delegated sub-agent works alone, with the parent's permissions and MCP servers.
        policy: { subagents: 'disabled', permissions: policy.permissions, mcp: { servers: policy.mcp.servers, inheritUserScope: policy.mcp.inheritUserScope } },
        metadata: { parentSessionId: parentId, delegated: true, description },
      })
      await this.port.send(childId, { inputId: this.port.ids.input(), text: this.composePrompt(parentId, params), delivery: 'queue' })
    } catch (error) {
      this.finish(child, { status: 'failed', text: '', usage: null, reason: (error as Error).message.slice(0, 300) })
      throw error
    }
    return { subagentId: childId }
  }

  /** Resolve with finished results, or with what still runs when the timeout elapses. */
  async wait(parentId: string, subagentIds: readonly string[] | undefined, timeoutMs: number): Promise<{ results: DelegatedResult[]; running: string[] }> {
    const targets = [...this.children.values()].filter((child) => child.parentId === parentId && (!subagentIds || subagentIds.includes(child.childId)))
    const pending = targets.filter((child) => !child.outcome)
    if (pending.length > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(0, timeoutMs))
        timer.unref?.()
        function done() { clearTimeout(timer); for (const child of pending) child.waiters.delete(check); resolve() }
        function check() { if (pending.every((child) => child.outcome)) done() }
        for (const child of pending) child.waiters.add(check)
      })
    }
    const finished = targets.filter((child) => child.outcome)
    for (const child of finished) child.collected = true
    this.parentIfOpen(parentId)?.collectDelegated(finished.map((child) => child.childId))
    return {
      results: finished.map((child) => ({ subagentId: child.childId, description: child.description, status: child.outcome!.status, result: child.outcome!.text || `It ended without a result (${child.outcome!.reason ?? child.outcome!.status}).` })),
      running: targets.filter((child) => !child.outcome).map((child) => child.childId),
    }
  }

  /** Delegated ids among `ids` (all of the parent's when omitted), stopped. */
  async stop(parentId: string, ids?: readonly string[], reason = 'host_request'): Promise<string[]> {
    const targets = [...this.children.values()].filter((child) => child.parentId === parentId && !child.outcome && (!ids || ids.includes(child.childId)))
    await Promise.all(targets.map(async (child) => {
      this.finish(child, { status: 'stopped', text: '', usage: null, reason })
      await this.port.interrupt(child.childId).catch(() => undefined)
      await this.port.close(child.childId, 'delegation_stopped').catch(() => undefined)
    }))
    return targets.map((child) => child.childId)
  }

  /** The parent session is closing: its delegated work ends with it. */
  async closeParent(parentId: string): Promise<void> {
    await this.stop(parentId, undefined, 'host_request')
    for (const [childId, child] of this.children) if (child.parentId === parentId) this.children.delete(childId)
  }

  isDelegated(subagentId: string): boolean {
    return this.children.has(subagentId)
  }

  /** Mirror committed child events into the parent's tree. */
  observe(envelopes: readonly SessionEventEnvelope[]): void {
    for (const envelope of envelopes) {
      const child = this.children.get(envelope.sessionId)
      if (!child || child.outcome) continue
      const event = envelope.event
      const parent = this.parentIfOpen(child.parentId)
      switch (event.type) {
        case 'turn.output':
          if (event.channel === 'text') parent?.delegatedOutput(child.childId, { channel: 'text', delta: event.delta })
          break
        case 'turn.tool': {
          const { type: _type, turnId: _turnId, at: _at, ...tool } = event
          parent?.delegatedOutput(child.childId, { channel: 'tool', tool })
          break
        }
        case 'turn.completed':
          this.finish(child, { status: event.status, text: event.text, usage: event.usage, ...(event.error ? { reason: event.error.slice(0, 300) } : {}) })
          // Its work is done: release the child's provider process and session.
          void this.port.close(child.childId, 'delegation_finished').catch(() => undefined)
          break
        case 'session.closed':
          this.finish(child, { status: 'interrupted', text: '', usage: null, reason: event.reason })
          break
      }
    }
  }

  private finish(child: Child, outcome: Outcome): void {
    if (child.outcome) return
    child.outcome = outcome
    this.parentIfOpen(child.parentId)?.delegatedFinished(child.childId, { ...outcome, collected: child.collected })
    for (const waiter of [...child.waiters]) waiter()
  }

  private parentIfOpen(parentId: string): ActiveSession | null {
    try { return this.port.parent(parentId) } catch { return null }
  }

  /** The task, optionally preceded by the parent's recent conversation. */
  private composePrompt(parentId: string, params: DelegateParams): string {
    const turns = Math.min(Math.max(params.contextTurns ?? 0, 0), MAX_CONTEXT_TURNS)
    if (turns === 0) return params.prompt
    const lines: string[] = []
    let after = Math.max(0, this.port.snapshot(parentId).lastSeq - 5_000)
    for (;;) {
      const page = this.port.journal.read(parentId, after, 1_000)
      for (const { event } of page.events) {
        if (event.type === 'input.accepted') lines.push(`User: ${event.text}`)
        if (event.type === 'turn.completed' && event.text) lines.push(`Agent: ${event.text}`)
      }
      if (!page.hasMore || page.events.length === 0) break
      after = page.events.at(-1)!.seq
    }
    const context = lines.slice(-turns * 2).map((line) => line.slice(0, 4_000)).join('\n\n')
    return context ? `Context from the delegating agent's conversation:\n\n${context}\n\n---\n\nYour task:\n${params.prompt}` : params.prompt
  }
}
