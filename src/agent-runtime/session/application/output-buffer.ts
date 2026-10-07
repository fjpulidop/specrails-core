import type { SessionEventBody } from '../domain/events.js'
import type { OutputChannel } from '../domain/types.js'

export interface OutputLimits {
  /** Flush buffered deltas once they reach this many characters. */
  flushChars: number
  /** Stored characters per turn before output is elided. */
  turnCap: number
  /** Stored characters per sub-agent before output is elided. */
  subagentCap: number
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = Object.freeze({ flushChars: 4_096, turnCap: 4 * 1024 * 1024, subagentCap: 1024 * 1024 })

type Key = string
interface Pending { body: SessionEventBody & { delta: string } }
interface Budget { stored: number; droppedEvents: number; droppedBytes: number; scope: { turnId: string } | { subagentId: string } }

/**
 * Coalesces streaming text deltas and enforces per-turn / per-sub-agent caps.
 * Deltas for the same target are merged until a size threshold, a timer, or any
 * non-delta event forces a flush (which preserves ordering). Beyond the cap,
 * deltas are counted but not stored; `drain*` reports one `output.truncated`.
 */
export class OutputBuffer {
  private readonly pending = new Map<Key, Pending>()
  private readonly budgets = new Map<Key, Budget>()

  constructor(private readonly limits: OutputLimits = DEFAULT_OUTPUT_LIMITS) {}

  /** Buffer a delta. Returns events that must be committed now (size-based flush). */
  add(body: { type: 'turn.output'; turnId: string; channel: OutputChannel; delta: string } | { type: 'subagent.output'; subagentId: string; channel: 'text'; delta: string }): SessionEventBody[] {
    const scope = body.type === 'turn.output' ? { turnId: body.turnId } : { subagentId: body.subagentId }
    const budgetKey = body.type === 'turn.output' ? `turn:${body.turnId}` : `subagent:${body.subagentId}`
    const cap = body.type === 'turn.output' ? this.limits.turnCap : this.limits.subagentCap
    const budget = this.budgets.get(budgetKey) ?? { stored: 0, droppedEvents: 0, droppedBytes: 0, scope }
    this.budgets.set(budgetKey, budget)
    if (budget.stored + body.delta.length > cap) {
      budget.droppedEvents += 1
      budget.droppedBytes += body.delta.length
      return []
    }
    budget.stored += body.delta.length
    const key = `${budgetKey}:${body.channel}`
    const existing = this.pending.get(key)
    if (existing) existing.body.delta += body.delta
    else this.pending.set(key, { body: { ...body } })
    const current = this.pending.get(key)!
    if (current.body.delta.length >= this.limits.flushChars) {
      this.pending.delete(key)
      return [current.body]
    }
    return []
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }

  /** All buffered deltas, in first-buffered order. */
  flush(): SessionEventBody[] {
    const bodies = [...this.pending.values()].map((entry) => entry.body)
    this.pending.clear()
    return bodies
  }

  /** Truncation report for a finished turn (and forget its budget). */
  drainTurn(turnId: string): SessionEventBody[] {
    return this.drain(`turn:${turnId}`)
  }

  /** Truncation report for a sub-agent that stopped running (and reset its budget). */
  drainSubagent(subagentId: string): SessionEventBody[] {
    return this.drain(`subagent:${subagentId}`)
  }

  private drain(key: Key): SessionEventBody[] {
    const budget = this.budgets.get(key)
    this.budgets.delete(key)
    if (!budget || budget.droppedEvents === 0) return []
    return [{ type: 'output.truncated', scope: budget.scope, droppedEvents: budget.droppedEvents, droppedBytes: budget.droppedBytes }]
  }
}
