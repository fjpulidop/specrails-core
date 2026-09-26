import { randomUUID } from 'node:crypto'
import { canonicalJson } from '../canonical-json.js'
import { EngineError, type AttemptFrame, type ExecutionLease, type JsonValue } from '../contracts.js'
import { appendRunEvent, RunDatabase, type DatabaseRow } from '../checkpoint/database.js'
import { RunLease } from '../checkpoint/lease.js'

export const MAX_STEERING_CHARACTERS = 20_000
export const MAX_STEERING_BYTES = 80_000
export const MAX_PENDING_STEERING = 128
export const MAX_PENDING_STEERING_BYTES = 512 * 1024
export interface SteeringMessage { id: string; text: string; sender: string; createdAt: string; consumedByAttemptId?: string; consumedAt?: string }
const project = (row: DatabaseRow): SteeringMessage => {
  const value = JSON.parse(String(row.payload_json)) as { text: string; sender: string }
  return { id: String(row.request_id), ...value, createdAt: String(row.created_at),
    ...(row.consumed_by_attempt_id ? { consumedByAttemptId: String(row.consumed_by_attempt_id) } : {}), ...(row.consumed_at ? { consumedAt: String(row.consumed_at) } : {}) }
}

/** A second process can append controls without acquiring or replacing the execution lease. */
export class ControlInbox {
  constructor(readonly database: RunDatabase, readonly runId: string) {}

  append(text: string, options: { requestId?: string; sender?: string } = {}): SteeringMessage {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_STEERING_CHARACTERS || Buffer.byteLength(text, 'utf8') > MAX_STEERING_BYTES) throw new EngineError('invalid_arguments', `Steering must contain 1–${MAX_STEERING_CHARACTERS} characters, within ${MAX_STEERING_BYTES} UTF-8 bytes`)
    const sender = options.sender ?? 'operator'
    if (!sender || sender.length > 128) throw new EngineError('invalid_arguments', 'Steering sender must contain 1–128 characters')
    const row = this.appendControl('steer', { text, sender }, options.requestId ?? randomUUID())
    return project(row)
  }

  cancel(requestId: string = randomUUID()): { requestId: string; createdAt: string } {
    const row = this.appendControl('cancel', {}, requestId)
    return { requestId: String(row.request_id), createdAt: String(row.created_at) }
  }

  private appendControl(kind: 'cancel' | 'steer', payload: JsonValue, requestId: string): DatabaseRow {
    if (!requestId || requestId.length > 256) throw new EngineError('invalid_arguments', 'Control request ID must contain 1–256 characters')
    const encoded = canonicalJson(payload)
    return this.database.transaction('control-appended', () => {
      const run = this.database.get('runs', { run_id: this.runId })
      if (!run) throw new EngineError('run_not_found', 'Run does not exist')
      const existing = this.database.get('control_inbox', { request_id: requestId })
      if (existing) {
        if (existing.run_id !== this.runId || existing.kind !== kind || existing.payload_json !== encoded) throw new EngineError('control_conflict', 'An idempotency key cannot change its control payload')
        return existing
      }
      if (run.completion_json || run.status === 'succeeded' || run.status === 'cancelled') throw new EngineError('run_terminal', 'Completed runs cannot receive new controls')
      if (kind === 'steer') {
        const pending = this.database.sqlite.prepare("SELECT COUNT(*) count,COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) bytes FROM control_inbox WHERE run_id=? AND kind='steer' AND consumed_at IS NULL").get(this.runId)!
        if (Number(pending.count) >= MAX_PENDING_STEERING || Number(pending.bytes) + Buffer.byteLength(encoded) > MAX_PENDING_STEERING_BYTES) throw new EngineError('inbox_full', 'Pending operator steering reached its bounded capacity')
      }
      const at = new Date().toISOString()
      this.database.put('control_inbox', { request_id: requestId, run_id: this.runId, kind, payload_json: encoded, created_at: at, received_sequence: run.next_event_sequence })
      appendRunEvent(this.database, this.runId, kind === 'steer' ? 'steering_received' : 'cancellation_requested', { requestId }, {}, at)
      return this.database.get('control_inbox', { request_id: requestId })!
    })
  }

  pending(): SteeringMessage[] {
    return this.database.sqlite.prepare("SELECT * FROM control_inbox WHERE run_id=? AND kind='steer' AND consumed_at IS NULL ORDER BY received_sequence,request_id").all(this.runId).map(project)
  }
  assigned(frame: AttemptFrame): SteeringMessage[] {
    return this.database.sqlite.prepare("SELECT * FROM control_inbox WHERE run_id=? AND kind='steer' AND consumed_by_attempt_id=? ORDER BY received_sequence,request_id").all(this.runId, frame.attemptId).map(project)
  }

  /** Called inside attempt admission, after the attempt row exists and the lease was fenced. */
  claimForAttempt(frame: AttemptFrame): SteeringMessage[] {
    void this.database.transactionRevision
    const attempt = this.database.get('attempts', { attempt_id: frame.attemptId })
    if (!attempt || attempt.run_id !== this.runId || attempt.status !== 'running' || attempt.lease_epoch !== frame.leaseEpoch) throw new EngineError('attempt_mismatch', 'Steering can only be claimed by the admitted attempt')
    const now = new Date().toISOString()
    for (const row of this.database.sqlite.prepare("SELECT * FROM control_inbox WHERE run_id=? AND kind='steer' AND consumed_at IS NULL ORDER BY received_sequence,request_id").all(this.runId)) {
      this.database.put('control_inbox', { ...row, consumed_by_attempt_id: frame.attemptId, consumed_at: now })
    }
    return this.assigned(frame)
  }

  cancellationRequested(): boolean {
    return !!this.database.sqlite.prepare("SELECT 1 FROM control_inbox WHERE run_id=? AND kind='cancel' AND consumed_at IS NULL").get(this.runId)
  }
  acknowledgeCancellation(token: ExecutionLease): void {
    this.database.transaction('cancellation-consumed', () => {
      new RunLease(this.database, this.runId).assert(token)
      for (const row of this.database.sqlite.prepare("SELECT * FROM control_inbox WHERE run_id=? AND kind='cancel' AND consumed_at IS NULL").all(this.runId)) {
        this.database.put('control_inbox', { ...row, consumed_at: new Date().toISOString() })
      }
    })
  }
}

/** Operator text is delimited and cannot replace frozen acceptance obligations/instructions. */
export function renderOperatorSteering(messages: readonly SteeringMessage[]): string {
  if (!messages.length) return ''
  return '\n\n## Operator steering\n\nApply these operator messages within the frozen workflow and its acceptance requirements.\n\n' +
    messages.map(message => `### Message ${JSON.stringify(message.id)} from ${JSON.stringify(message.sender)}\n${JSON.stringify(message.text)}`).join('\n\n')
}
