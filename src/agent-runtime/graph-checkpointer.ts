import {
  BaseCheckpointSaver, copyCheckpoint, WRITES_IDX_MAP,
  type ChannelVersions, type Checkpoint, type CheckpointListOptions, type CheckpointMetadata, type CheckpointTuple, type PendingWrite,
} from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'

/** One serialized LangGraph value: the serializer's type tag plus base64 bytes. */
export interface SerializedBlob { type: string; data: string }
export interface SerializedCheckpointEntry {
  threadId: string
  ns: string
  id: string
  parentId?: string
  checkpoint: SerializedBlob
  metadata: SerializedBlob
}
export interface SerializedWriteEntry {
  threadId: string
  ns: string
  checkpointId: string
  taskId: string
  idx: number
  channel: string
  value: SerializedBlob
}
/** The complete LangGraph checkpoint history of one run, as stored inside the run envelope. */
export interface SerializedGraphStore {
  format: 1
  checkpoints: SerializedCheckpointEntry[]
  writes: SerializedWriteEntry[]
}
export interface GraphStoreIO {
  /** The store persisted with the run, or undefined for a new run. */
  load(): SerializedGraphStore | undefined
  /** Persist the complete store. The engine writes it atomically with the ledger. */
  save(store: SerializedGraphStore): Promise<void>
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
function key(...parts: string[]): string { return JSON.stringify(parts) }
function assertKey(field: string, value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || (value && !SAFE_KEY.test(value))) throw new Error(`Invalid checkpoint ${field}`)
  return value
}

/**
 * LangGraph checkpointer whose whole history lives inside the run's durable
 * envelope. Every checkpoint or pending write is persisted through the same
 * atomic file write as the host ledger, so traversal state and receipts can
 * never disagree after a crash. Values are serialized by LangGraph's own
 * serializer and stored as base64 so the envelope stays plain JSON.
 */
export class FileCheckpointSaver extends BaseCheckpointSaver {
  private readonly checkpoints = new Map<string, SerializedCheckpointEntry>()
  private readonly writes = new Map<string, SerializedWriteEntry>()

  constructor(private readonly io: GraphStoreIO) {
    super()
    const stored = io.load()
    if (stored) {
      if (stored.format !== 1 || !Array.isArray(stored.checkpoints) || !Array.isArray(stored.writes)) throw new Error('Invalid graph checkpoint store')
      for (const entry of stored.checkpoints) this.checkpoints.set(key(entry.threadId, entry.ns, entry.id), entry)
      for (const entry of stored.writes) this.writes.set(key(entry.threadId, entry.ns, entry.checkpointId, entry.taskId, String(entry.idx)), entry)
    }
  }

  /** A JSON snapshot of the complete store. */
  serialize(): SerializedGraphStore {
    return { format: 1, checkpoints: [...this.checkpoints.values()], writes: [...this.writes.values()] }
  }

  private async dump(value: unknown): Promise<SerializedBlob> {
    const [type, bytes] = await this.serde.dumpsTyped(value)
    return { type, data: Buffer.from(bytes).toString('base64') }
  }
  private async load<T>(blob: SerializedBlob): Promise<T> {
    return await this.serde.loadsTyped(blob.type, Buffer.from(blob.data, 'base64')) as T
  }
  private persist(): Promise<void> { return this.io.save(this.serialize()) }

  private async tuple(entry: SerializedCheckpointEntry): Promise<CheckpointTuple> {
    const pendingWrites = await Promise.all([...this.writes.values()]
      .filter(write => write.threadId === entry.threadId && write.ns === entry.ns && write.checkpointId === entry.id)
      .map(async write => [write.taskId, write.channel, await this.load(write.value)] as [string, string, unknown]))
    const result: CheckpointTuple = {
      config: { configurable: { thread_id: entry.threadId, checkpoint_ns: entry.ns, checkpoint_id: entry.id } },
      checkpoint: await this.load<Checkpoint>(entry.checkpoint),
      metadata: await this.load<CheckpointMetadata>(entry.metadata),
      pendingWrites,
    }
    if (entry.parentId !== undefined) result.parentConfig = { configurable: { thread_id: entry.threadId, checkpoint_ns: entry.ns, checkpoint_id: entry.parentId } }
    return result
  }

  private entries(threadId: string | undefined, ns: string | undefined): SerializedCheckpointEntry[] {
    return [...this.checkpoints.values()]
      .filter(entry => (threadId === undefined || entry.threadId === threadId) && (ns === undefined || entry.ns === ns))
      .sort((a, b) => b.id.localeCompare(a.id))
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = assertKey('thread_id', config.configurable?.thread_id)
    const ns = assertKey('checkpoint_ns', config.configurable?.checkpoint_ns ?? '', true)
    const checkpointId = config.configurable?.checkpoint_id as string | undefined
    if (checkpointId !== undefined) {
      const entry = this.checkpoints.get(key(threadId, ns, assertKey('checkpoint_id', checkpointId)))
      return entry ? this.tuple(entry) : undefined
    }
    const latest = this.entries(threadId, ns)[0]
    return latest ? this.tuple(latest) : undefined
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined
    const ns = config.configurable?.checkpoint_ns as string | undefined
    const only = config.configurable?.checkpoint_id as string | undefined
    const before = options?.before?.configurable?.checkpoint_id as string | undefined
    let remaining = options?.limit
    for (const entry of this.entries(threadId, ns)) {
      if (only !== undefined && entry.id !== only) continue
      if (before !== undefined && entry.id >= before) continue
      const tuple = await this.tuple(entry)
      if (options?.filter && !Object.entries(options.filter).every(([name, value]) => (tuple.metadata as Record<string, unknown> | undefined)?.[name] === value)) continue
      if (remaining !== undefined) { if (remaining <= 0) break; remaining -= 1 }
      yield tuple
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    const threadId = assertKey('thread_id', config.configurable?.thread_id)
    const ns = assertKey('checkpoint_ns', config.configurable?.checkpoint_ns ?? '', true)
    const id = assertKey('checkpoint_id', checkpoint.id)
    const parentId = config.configurable?.checkpoint_id as string | undefined
    const entry: SerializedCheckpointEntry = {
      threadId, ns, id, ...(parentId !== undefined ? { parentId } : {}),
      checkpoint: await this.dump(copyCheckpoint(checkpoint)), metadata: await this.dump(metadata),
    }
    this.checkpoints.set(key(threadId, ns, id), entry)
    await this.persist()
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: id } }
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = assertKey('thread_id', config.configurable?.thread_id)
    const ns = assertKey('checkpoint_ns', config.configurable?.checkpoint_ns ?? '', true)
    const checkpointId = assertKey('checkpoint_id', config.configurable?.checkpoint_id)
    assertKey('task_id', taskId)
    let changed = false
    for (const [index, [channel, value]] of writes.entries()) {
      const idx = WRITES_IDX_MAP[channel] ?? index
      const writeKey = key(threadId, ns, checkpointId, taskId, String(idx))
      if (idx >= 0 && this.writes.has(writeKey)) continue
      this.writes.set(writeKey, { threadId, ns, checkpointId, taskId, idx, channel, value: await this.dump(value) })
      changed = true
    }
    if (changed) await this.persist()
  }

  async deleteThread(threadId: string): Promise<void> {
    for (const [name, entry] of this.checkpoints) if (entry.threadId === threadId) this.checkpoints.delete(name)
    for (const [name, entry] of this.writes) if (entry.threadId === threadId) this.writes.delete(name)
    await this.persist()
  }
}
