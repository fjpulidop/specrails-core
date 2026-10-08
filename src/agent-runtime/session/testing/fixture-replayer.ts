import { readFileSync } from 'node:fs'

import type { ProcessExit, ProcessHandlers, ProcessSpawner, ProcessSpec, ProviderProcess } from '../drivers/common/process.js'

/** One recorded transcript row (see the spike harness in the OpenSpec change). */
export interface FixtureRow {
  t: number
  dir: 'in' | 'out' | 'ctl'
  json?: Record<string, unknown> | null
  raw?: string
}

export function loadFixture(file: string): FixtureRow[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as FixtureRow)
}

/** Fields whose recorded values are replaced by the values the driver actually wrote. */
const REMAPPED = ['id', 'uuid', 'command_uuid'] as const

export interface ReplaySession {
  readonly spec: ProcessSpec
  /** Lines the driver wrote to stdin, parsed. */
  readonly written: Array<Record<string, unknown>>
  readonly inputEnded: boolean
  readonly terminated: boolean
  /** Resolves when the replay is blocked waiting for the driver, or finished. */
  idle(): Promise<void>
}

/**
 * Replays a recorded provider transcript as a ProcessSpawner:
 * - `out` rows are emitted in order (time compressed);
 * - before passing an `in` row, replay waits until the driver wrote a line,
 *   then maps recorded ids/uuids to the ones the driver used;
 * - a `ctl kill` row waits for `terminate()` (output after it is what the
 *   provider printed while stopping); `closeStdin` waits for `endInput()`;
 * - after the last row the process stays alive until terminated, like a
 *   resident provider, unless the transcript recorded a clean exit.
 */
export class FixtureReplayer {
  readonly sessions: ReplaySession[] = []

  constructor(private readonly rows: FixtureRow[], private readonly options: { exitAtEnd?: boolean } = {}) {}

  static fromFile(file: string, options?: { exitAtEnd?: boolean }): FixtureReplayer {
    return new FixtureReplayer(loadFixture(file), options)
  }

  get last(): ReplaySession {
    const session = this.sessions.at(-1)
    if (!session) throw new Error('fixture replayer: nothing spawned')
    return session
  }

  readonly spawner: ProcessSpawner = (spec: ProcessSpec, handlers: ProcessHandlers): ProviderProcess => {
    const rows = this.rows
    const ids = new Map<string, unknown>()
    const written: Array<Record<string, unknown>> = []
    let inputsSeen = 0
    let index = 0
    let inputOpen = true
    let terminated = false
    let exit: ProcessExit | null = null
    let resolveExit!: (value: ProcessExit) => void
    const exited = new Promise<ProcessExit>((resolve) => { resolveExit = resolve })
    let idleWaiters: Array<() => void> = []
    let blocked = false
    const exitAtEnd = this.options.exitAtEnd ?? false

    const remap = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key,
          (REMAPPED as readonly string[]).includes(key) && ids.has(JSON.stringify(inner)) ? ids.get(JSON.stringify(inner)) : remap(inner)]))
      }
      return value
    }
    const finish = (result: ProcessExit) => {
      if (exit) return
      exit = result
      blocked = true
      resolveExit(result)
      flushIdle()
    }
    const flushIdle = () => { const waiters = idleWaiters; idleWaiters = []; for (const waiter of waiters) waiter() }

    const step = (): void => {
      if (exit) return
      blocked = false
      while (index < rows.length) {
        const row = rows[index]!
        if (row.dir === 'in') {
          if (written.length <= inputsSeen) { blocked = true; flushIdle(); return }
          const actual = written[inputsSeen]!
          for (const key of REMAPPED) {
            const recorded = row.json?.[key]
            if (recorded !== undefined && actual[key] !== undefined) ids.set(JSON.stringify(recorded), actual[key])
          }
          inputsSeen += 1
          index += 1
          continue
        }
        if (row.dir === 'ctl') {
          const control = row.json ?? {}
          if ('kill' in control) {
            if (!terminated) { blocked = true; flushIdle(); return }
            index += 1
            continue
          }
          if ('closeStdin' in control) {
            if (inputOpen) { blocked = true; flushIdle(); return }
            index += 1
            continue
          }
          if ('end' in control) {
            const match = /exit code=(\S+) sig=(\S+)/.exec(String(control.end))
            const code = match && match[1] !== 'null' ? Number(match[1]) : null
            const signal = match && match[2] !== 'null' ? match[2]! : null
            // A harness timeout means the real process was still alive: stay resident.
            if (terminated || exitAtEnd || (signal !== 'SIGKILL' && signal !== 'SIGTERM')) { finish({ exitCode: code, signal }); return }
            index += 1
            continue
          }
          index += 1
          continue
        }
        index += 1
        if (row.json) handlers.onLine(JSON.stringify(remap(row.json)))
        else if (row.raw) handlers.onLine(row.raw)
        setImmediate(step)
        return
      }
      if (terminated || exitAtEnd) finish({ exitCode: terminated ? null : 0, signal: terminated ? 'SIGTERM' : null })
      else { blocked = true; flushIdle() }
    }

    const session: ReplaySession = {
      spec,
      written,
      get inputEnded() { return !inputOpen },
      get terminated() { return terminated },
      idle: () => (blocked || exit ? Promise.resolve() : new Promise<void>((resolve) => { idleWaiters.push(resolve) })),
    }
    this.sessions.push(session)
    setImmediate(step)

    return {
      pid: 4242,
      exited,
      write(line: string): boolean {
        if (!inputOpen || exit) return false
        written.push(JSON.parse(line) as Record<string, unknown>)
        if (blocked) setImmediate(step)
        return true
      },
      endInput(): void {
        inputOpen = false
        if (blocked) setImmediate(step)
      },
      terminate(): Promise<ProcessExit> {
        terminated = true
        if (blocked) setImmediate(step)
        return exited
      },
    }
  }
}
