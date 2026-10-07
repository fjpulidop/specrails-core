import type { Clock, TimerHandle } from '../ports.js'

/** The timers one session can hold; each kind has at most one armed timer. */
export type TimerKind = 'idle' | 'stall' | 'backgroundMax' | 'turnInactivity' | 'settle' | 'interruptGrace' | 'flush'

/** Named, cancellable timers for one session. Re-arming a kind replaces it. */
export class SessionTimers {
  private readonly armed = new Map<TimerKind, TimerHandle>()

  constructor(private readonly clock: Clock) {}

  arm(kind: TimerKind, ms: number, callback: () => void): void {
    this.cancel(kind)
    const handle = this.clock.after(ms, () => {
      if (this.armed.get(kind) !== handle) return
      this.armed.delete(kind)
      callback()
    })
    this.armed.set(kind, handle)
  }

  /** Arm only when not already armed (deadlines that must not slide). */
  ensure(kind: TimerKind, ms: number, callback: () => void): void {
    if (!this.armed.has(kind)) this.arm(kind, ms, callback)
  }

  isArmed(kind: TimerKind): boolean {
    return this.armed.has(kind)
  }

  cancel(...kinds: TimerKind[]): void {
    for (const kind of kinds) {
      this.armed.get(kind)?.cancel()
      this.armed.delete(kind)
    }
  }

  cancelAll(): void {
    this.cancel(...this.armed.keys())
  }
}
