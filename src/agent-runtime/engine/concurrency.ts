import { EngineError } from './contracts.js'

interface Waiter {
  weight: number
  resolve(release: () => void): void
  reject(error: unknown): void
  signal?: AbortSignal
  abort(): void
}

/** FIFO weighted permits prevent writers starving behind new read branches. */
export class ConcurrencyGate {
  private available: number
  private readonly queue: Waiter[] = []

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new EngineError('invalid_arguments', 'Concurrency must be a positive integer')
    this.available = capacity
  }

  acquire(signal?: AbortSignal, weight = 1): Promise<() => void> {
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > this.capacity) return Promise.reject(new EngineError('invalid_arguments', 'Invalid permit weight'))
    if (signal?.aborted) return Promise.reject(new EngineError('aborted', 'Execution cancelled while waiting for admission'))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { weight, resolve, reject, signal, abort: () => {
        const index = this.queue.indexOf(waiter)
        if (index < 0) return
        this.queue.splice(index, 1)
        signal?.removeEventListener('abort', waiter.abort)
        reject(new EngineError('aborted', 'Execution cancelled while waiting for admission'))
        this.drain()
      } }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      this.queue.push(waiter)
      this.drain()
    })
  }

  private drain(): void {
    while (this.queue.length && this.queue[0]!.weight <= this.available) {
      const waiter = this.queue.shift()!
      waiter.signal?.removeEventListener('abort', waiter.abort)
      this.available -= waiter.weight
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.available += waiter.weight
        this.drain()
      })
    }
  }
}

/** All branches share this gate; a write owns the complete repository effect window. */
export class RepositoryEffectGate {
  private readonly permits = new ConcurrencyGate(Number.MAX_SAFE_INTEGER)
  acquire(effect: 'read' | 'write', signal?: AbortSignal): Promise<() => void> {
    return this.permits.acquire(signal, effect === 'write' ? this.permits.capacity : 1)
  }
}
