import { isGraphInterrupt } from '@langchain/langgraph'
import { AgentExecutionError } from '../executor-types.js'
import { EngineError, type AttemptFrame, type DurableEngineEvent, type EngineEffect, type NodeAdmission,
  type NodeExecutionPort, type PieceResult, type TerminalCommit, type TransientEngineEvent } from './contracts.js'
import { ConcurrencyGate, RepositoryEffectGate } from './concurrency.js'
import type { RunLedger } from './checkpoint/ledger.js'
import type { EngineEventStream } from './events.js'

const COORDINATORS = new Set(['component', 'map', 'join', 'implementation'])
const UNCERTAIN_EFFECT = new Set(['aborted', 'timeout', 'idle_timeout', 'lease_lost'])
const errorDetails = (error: unknown) => ({
  code: error instanceof EngineError || error instanceof AgentExecutionError ? error.code : 'piece_failed',
  message: error instanceof Error ? error.message : String(error),
})

/** Owns effect/concurrency windows across execution AND durable terminal commit. */
export class DefinitionExecution implements NodeExecutionPort {
  private readonly admissions = new Map<string, NodeAdmission>()
  private readonly held = new Map<string, () => void>()
  private readonly effects = new RepositoryEffectGate()
  private readonly agents: ConcurrencyGate
  private readonly groups = new Map<string, ConcurrencyGate>()

  constructor(readonly ledger: RunLedger, private readonly stream: EngineEventStream,
    private readonly signal: AbortSignal, concurrency = 1,
    private readonly finalize?: (frame: AttemptFrame, result: PieceResult, effect: EngineEffect) => PieceResult) { this.agents = new ConcurrencyGate(concurrency) }

  async enter(input: NodeAdmission): Promise<AttemptFrame> {
    if (this.signal.aborted) throw new EngineError('aborted', 'Execution cancelled before node admission')
    const frame = this.ledger.enter(input)
    this.admissions.set(frame.attemptId, input)
    this.stream.flush()
    return frame
  }

  async execute(frame: AttemptFrame, effect: EngineEffect, operation: (signal: AbortSignal) => Promise<PieceResult>): Promise<PieceResult> {
    const completed = this.ledger.resultFor(frame)
    if (completed) return structuredClone(completed)
    const admission = this.admissions.get(frame.attemptId)
    if (!admission) throw new EngineError('attempt_mismatch', 'Node has not been admitted by this executor')
    let effectRelease = () => {}, agentRelease = () => {}
    const groupReleases: Array<() => void> = []
    try {
      if (!COORDINATORS.has(admission.kind)) effectRelease = await this.effects.acquire(effect, this.signal)
      if (admission.requiresAI && !COORDINATORS.has(admission.kind)) {
        for (const limit of frame.scope.limits ?? []) {
          let group = this.groups.get(limit.id)
          if (!group) { group = new ConcurrencyGate(limit.concurrency); this.groups.set(limit.id, group) }
          if (group.capacity !== limit.concurrency) throw new EngineError('scope_conflict', 'A map concurrency limit cannot change within a run')
          groupReleases.push(await group.acquire(this.signal))
        }
        agentRelease = await this.agents.acquire(this.signal)
      }
      this.ledger.lease.assert(this.ledger.token)
      if (this.signal.aborted) throw new EngineError('aborted', 'Execution cancelled before effects')
    } catch (error) { effectRelease(); agentRelease(); for (const release of groupReleases.reverse()) release(); throw error }
    // LangGraph's saver releases this only after pending writes and terminal
    // evidence commit. Releasing on function return admits a later write before
    // the previous verification receipt is durable and can certify stale work.
    this.held.set(frame.attemptId, () => { agentRelease(); for (const release of groupReleases.reverse()) release(); effectRelease() })
    const result = await operation(this.signal)
    const current = this.ledger.scopeSnapshot(frame.scope.id)
    return { ...result, usage: current.usage,
      ...(effect === 'write' && !result.receipt ? { verified: null } : {}),
    }
  }

  terminal(frame: AttemptFrame, result: PieceResult): TerminalCommit {
    const completed = this.ledger.resultFor(frame)
    if (completed) return this.ledger.terminal(frame, completed)
    const input = this.admissions.get(frame.attemptId)
    return this.ledger.terminal(frame, this.finalize && input && (!COORDINATORS.has(input.kind) || input.kind === 'implementation') ? this.finalize(frame, result, input.effect) : result)
  }

  async interrupted(frame: AttemptFrame, error: unknown): Promise<void> {
    if (!isGraphInterrupt(error)) this.ledger.prepareInterruption(frame, errorDetails(error))
    // The saver settles __interrupt__/__error__ with its ledger event. Keep the
    // effect window until that transaction; process shutdown releases it too.
  }

  async failed(frame: AttemptFrame, error: unknown, options: { retry: boolean }): Promise<{ retryable: boolean }> {
    const input = this.admissions.get(frame.attemptId), details = errorDetails(error)
    const retryable = options.retry && input?.retry.retrySafe === true && !['aborted', 'lease_lost'].includes(details.code) && !(input.effect === 'write' && UNCERTAIN_EFFECT.has(details.code))
    if (retryable) {
      this.ledger.fail(frame, details, true)
      this.release(frame.attemptId)
      this.stream.flush()
    }
    // A final failure stays running until its atomic terminal marker commits.
    return { retryable }
  }

  committed(events: DurableEngineEvent[]): void {
    for (const event of events) if (event.attemptId && /^step_(?:succeeded|failed|blocked|paused|interrupted)$/.test(event.type)) this.release(event.attemptId)
    this.stream.flush()
  }

  progress(event: TransientEngineEvent): void { this.stream.progress(event) }

  close(): void { for (const attemptId of this.held.keys()) this.release(attemptId) }

  private release(attemptId: string): void {
    this.held.get(attemptId)?.()
    this.held.delete(attemptId)
  }
}
