import type { RunnableConfig } from '@langchain/core/runnables'
import { BaseCheckpointSaver, copyCheckpoint, WRITES_IDX_MAP, type Checkpoint, type CheckpointMetadata,
  type CheckpointTuple, type CheckpointListOptions, type PendingWrite } from '@langchain/langgraph-checkpoint'
import { EngineError, type DurableEngineEvent, type JsonValue, type TaskIdentity, type TerminalCommit } from '../contracts.js'
import { RunDatabase, type DatabaseRow } from './database.js'
import { RunLedger } from './ledger.js'

const configOf = (row: DatabaseRow): RunnableConfig => ({ configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } })
function identity(config: RunnableConfig, taskId?: string): TaskIdentity {
  const { thread_id, checkpoint_ns = '', checkpoint_id = '' } = config.configurable ?? {}
  if (typeof thread_id !== 'string' || !thread_id || typeof checkpoint_ns !== 'string' || typeof checkpoint_id !== 'string') throw new EngineError('invalid_arguments', 'Checkpoint thread, namespace and ID must be strings')
  if (taskId !== undefined && (!taskId || !checkpoint_id)) throw new EngineError('invalid_arguments', 'Pending writes require checkpoint and task IDs')
  return { checkpointThreadId: thread_id, taskCheckpointNs: checkpoint_ns, checkpointId: checkpoint_id, taskId: taskId ?? '' }
}
export interface SaverOptions {
  /** Durable observers may fail without converting a committed effect into a retry. */
  onEvents?: (events: DurableEngineEvent[]) => void | Promise<void>
  onObserverError?: (error: unknown) => void
  fault?: (phase: 'before-writes' | 'between-writes-ledger' | 'after-writes' | 'before-snapshot' | 'after-snapshot') => void
}

/** LangGraph adapter. Terminal evidence and pending writes have exactly one commit owner. */
export class SqliteRunSaver extends BaseCheckpointSaver {
  constructor(readonly database: RunDatabase, private readonly ledger?: RunLedger, private readonly options: SaverOptions = {}) { super() }

  private assertWriter(): RunLedger {
    if (!this.ledger) throw new EngineError('read_only', 'Read-only saver cannot mutate checkpoints')
    this.ledger.lease.assert(this.ledger.token)
    return this.ledger
  }
  private async tuple(row: DatabaseRow): Promise<CheckpointTuple> {
    const pendingWrites: NonNullable<CheckpointTuple['pendingWrites']> = []
    for (const write of this.database.sqlite.prepare('SELECT * FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? ORDER BY task_id,idx').all(row.thread_id, row.checkpoint_ns, row.checkpoint_id)) {
      pendingWrites.push([String(write.task_id), String(write.channel), await this.serde.loadsTyped(String(write.type), write.value as Uint8Array)])
    }
    return { config: configOf(row), checkpoint: await this.serde.loadsTyped(String(row.type), row.checkpoint as Uint8Array) as Checkpoint,
      metadata: await this.serde.loadsTyped(String(row.metadata_type), row.metadata as Uint8Array) as CheckpointMetadata,
      pendingWrites, ...(row.parent_checkpoint_id ? { parentConfig: configOf({ ...row, checkpoint_id: row.parent_checkpoint_id }) } : {}) }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const task = identity(config)
    const row = task.checkpointId ? this.database.sqlite.prepare('SELECT * FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?').get(task.checkpointThreadId, task.taskCheckpointNs, task.checkpointId)
      : this.database.sqlite.prepare('SELECT * FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? ORDER BY checkpoint_id DESC LIMIT 1').get(task.checkpointThreadId, task.taskCheckpointNs)
    return row ? this.tuple(row) : undefined
  }

  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const clauses: string[] = [], values: string[] = []
    for (const key of ['thread_id', 'checkpoint_ns', 'checkpoint_id']) {
      const value = config.configurable?.[key]
      if (value !== undefined) {
        if (typeof value !== 'string') throw new EngineError('invalid_arguments', 'Checkpoint selectors must be strings')
        clauses.push(`${key}=?`); values.push(value)
      }
    }
    if (options.before?.configurable?.checkpoint_id) { clauses.push('checkpoint_id<?'); values.push(String(options.before.configurable.checkpoint_id)) }
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) throw new EngineError('invalid_arguments', 'Checkpoint limit must be a non-negative integer')
    let remaining = options.limit ?? Infinity
    const rows = this.database.sqlite.prepare('SELECT * FROM checkpoints' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ' ORDER BY checkpoint_id DESC').all(...values)
    for (const row of rows) {
      if (remaining === 0) break
      const tuple = await this.tuple(row)
      if (options.filter && !Object.entries(options.filter).every(([key, value]) => JSON.stringify(tuple.metadata?.[key as keyof CheckpointMetadata]) === JSON.stringify(value))) continue
      remaining--; yield tuple
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const task = identity(config), ledger = this.assertWriter()
    const [[type, bytes], [metadataType, metadataBytes]] = await Promise.all([this.serde.dumpsTyped(copyCheckpoint(checkpoint)), this.serde.dumpsTyped(metadata)])
    const next = { configurable: { thread_id: task.checkpointThreadId, checkpoint_ns: task.taskCheckpointNs, checkpoint_id: checkpoint.id } }
    this.options.fault?.('before-snapshot')
    this.database.transaction('checkpoint-snapshot', () => {
      this.assertWriter()
      this.database.put('checkpoints', { thread_id: task.checkpointThreadId, checkpoint_ns: task.taskCheckpointNs, checkpoint_id: checkpoint.id,
        parent_checkpoint_id: task.checkpointId || null, type, checkpoint: bytes, metadata: metadataBytes, metadata_type: metadataType })
      if (task.taskCheckpointNs === '') this.database.put('runs', { ...ledger.run(), head_checkpoint_json: JSON.stringify(next), current_revision: this.database.transactionRevision })
    })
    this.options.fault?.('after-snapshot')
    return next
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const task = identity(config, taskId), ledger = this.assertWriter()
    // Serializer callbacks never run with a SQLite transaction held.
    const dumped = await Promise.all(writes.map(async ([channel, value], index) => ({ channel, value, index: WRITES_IDX_MAP[channel] ?? index, blob: await this.serde.dumpsTyped(value) })))
    const markers = dumped.filter(write => write.channel === '$commit')
    if (markers.length > 1) throw new EngineError('terminal_conflict', 'One physical task may settle only one terminal marker')
    const marker = markers[0]?.value as TerminalCommit | undefined
    if (marker && (!marker.frame || !marker.result || typeof marker.digest !== 'string')) throw new EngineError('terminal_mismatch', 'Malformed terminal marker')
    this.options.fault?.('before-writes')
    const events = this.database.transaction('pending-writes-and-ledger', () => {
      this.assertWriter()
      for (const write of dumped) {
        const key = { thread_id: task.checkpointThreadId, checkpoint_ns: task.taskCheckpointNs, checkpoint_id: task.checkpointId, task_id: taskId, idx: write.index }
        const prior = this.database.get('writes', key)
        if (prior && write.index >= 0) {
          if (marker && (prior.channel !== write.channel || prior.type !== write.blob[0] || !Buffer.from(prior.value as Uint8Array).equals(Buffer.from(write.blob[1])))) throw new EngineError('terminal_conflict', 'A settled task cannot change its pending writes')
          continue
        }
        this.database.put('writes', { ...key, channel: write.channel, type: write.blob[0], value: write.blob[1] })
      }
      this.options.fault?.('between-writes-ledger')
      const committed = marker ? ledger.commitTerminal(marker, task) : []
      for (const write of dumped.filter(write => write.channel === '__interrupt__')) {
        // LangGraph's public PendingWrite contains one interrupt per channel write.
        const value = write.value as { id: string; value: JsonValue }
        if (!value || typeof value.id !== 'string') throw new EngineError('interrupt_invalid', 'LangGraph interrupt IDs are required')
        committed.push(...ledger.commitInterrupts(task, [value]))
      }
      for (const write of dumped.filter(write => write.channel === '__error__')) committed.push(...ledger.commitError(task, write.value))
      return committed
    })
    this.options.fault?.('after-writes')
    if (events.length && this.options.onEvents) {
      try { await this.options.onEvents(events) }
      catch (error) { try { this.options.onObserverError?.(error) } catch { /* Delivery cannot roll back durable execution. */ } }
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.database.transaction('checkpoint-thread-deleted', () => {
      this.assertWriter()
      for (const table of ['writes', 'checkpoints'] as const) {
        for (const row of this.database.sqlite.prepare(`SELECT * FROM ${table} WHERE thread_id=?`).all(threadId)) this.database.delete(table, row)
      }
    })
  }
}
