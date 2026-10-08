import crossSpawn from 'cross-spawn'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { cliProcessEnvironment } from '../../../cli-process.js'

export interface ProcessSpec {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface ProcessHandlers {
  /** One complete stdout line (without the trailing newline). */
  onLine(line: string): void
  /** Bounded stderr tail updates, for diagnostics only. */
  onStderr?(chunk: string): void
}

export interface ProcessExit { exitCode: number | null; signal: string | null }

/**
 * A long-lived provider process with line-oriented stdout. Unlike the one-shot
 * `runCliProcess`, nothing accumulates: lines are handed over as they arrive.
 */
export interface ProviderProcess {
  readonly pid: number | undefined
  /** Write one line to stdin; false when input is already closed. */
  write(line: string): boolean
  endInput(): void
  /**
   * Ask the whole process tree to stop (SIGTERM / taskkill), then force it
   * (SIGKILL / taskkill /F) after `graceMs`. Resolves once the process exited.
   */
  terminate(graceMs: number): Promise<ProcessExit>
  readonly exited: Promise<ProcessExit>
}

export type ProcessSpawner = (spec: ProcessSpec, handlers: ProcessHandlers) => ProviderProcess

/** Longest stdout line accepted; longer lines are dropped and reported. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024

/** Production spawner: cross-spawn, own process group on POSIX, tree-kill on every platform. */
export const spawnResidentProcess: ProcessSpawner = (spec, handlers) => {
  const env = cliProcessEnvironment(spec.env)
  const child = crossSpawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let inputOpen = true
  let exit: ProcessExit | null = null

  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('error', (error) => {
      handlers.onStderr?.(`spawn error: ${error.message}`)
      if (!exit) { exit = { exitCode: null, signal: 'spawn-error' }; resolve(exit) }
    })
    child.once('close', (code, signal) => {
      const rest = pending + decoder.end()
      pending = ''
      if (rest.trim()) handlers.onLine(rest.replace(/\r$/, ''))
      if (!exit) { exit = { exitCode: code, signal }; resolve(exit) }
    })
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    pending += decoder.write(chunk)
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (line.length > 0) handlers.onLine(line)
    }
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
      handlers.onStderr?.(`dropped an stdout line larger than ${MAX_LINE_BYTES} bytes`)
      pending = ''
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => handlers.onStderr?.(chunk.toString('utf8').slice(-8_192)))
  child.stdin?.on('error', () => { inputOpen = false })

  const signalTree = (force: boolean): void => {
    const pid = child.pid
    if (!pid || exit) return
    if (process.platform === 'win32') {
      const taskkill = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
      execFile(taskkill, ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, env, timeout: 10_000 }, () => {
        if (force) { try { child.kill('SIGKILL') } catch { /* already exited */ } }
      })
      return
    }
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM') } catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* already exited */ } }
  }

  let termination: Promise<ProcessExit> | null = null
  return {
    get pid() { return child.pid },
    exited,
    write(line: string): boolean {
      if (!inputOpen || exit || !child.stdin || child.stdin.destroyed) return false
      child.stdin.write(`${line}\n`, 'utf8')
      return true
    },
    endInput(): void {
      if (!inputOpen) return
      inputOpen = false
      child.stdin?.end()
    },
    terminate(graceMs: number): Promise<ProcessExit> {
      if (exit) return Promise.resolve(exit)
      termination ??= (async () => {
        signalTree(false)
        let timer: ReturnType<typeof setTimeout> | undefined
        const forced = new Promise<void>((resolve) => { timer = setTimeout(() => { signalTree(true); resolve() }, Math.max(0, graceMs)) })
        const result = await Promise.race([exited, forced.then(() => exited)])
        clearTimeout(timer)
        return result
      })()
      return termination
    },
  }
}
