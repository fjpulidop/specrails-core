import type { Clock, Ids, TimerHandle } from '../ports.js'

/** Deterministic clock: time only moves through `advance`. */
export class FakeClock implements Clock {
  private current: number
  private seq = 0
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  constructor(start = Date.UTC(2026, 9, 7, 10, 0, 0)) { this.current = start }

  now(): number { return this.current }
  iso(): string { return new Date(this.current).toISOString() }

  after(ms: number, callback: () => void): TimerHandle {
    const id = ++this.seq
    this.timers.set(id, { at: this.current + Math.max(0, ms), callback })
    return { cancel: () => { this.timers.delete(id) } }
  }

  /** Move time forward, firing due timers in order (timers armed by callbacks included). */
  advance(ms: number): void {
    const target = this.current + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      this.timers.delete(due[0])
      this.current = Math.max(this.current, due[1].at)
      due[1].callback()
    }
    this.current = target
  }

  pendingTimers(): number { return this.timers.size }
}

export class SequentialIds implements Ids {
  private counters = { session: 0, turn: 0, input: 0 }
  session(): string { return `session-${++this.counters.session}` }
  turn(): string { return `turn-${++this.counters.turn}` }
  input(): string { return `input-${++this.counters.input}` }
}
