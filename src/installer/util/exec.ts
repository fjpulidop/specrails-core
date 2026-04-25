import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'

import { ExecError } from './errors.js'

export interface RunOptions {
  /** Working directory for the child. Defaults to `process.cwd()`. */
  cwd?: string
  /** Environment variables, merged on top of `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Stream stdio to the parent (default). When `false`, stdout/stderr are captured and returned. */
  inherit?: boolean
  /** Hard timeout in milliseconds. Child is SIGKILL'd on timeout. Defaults to none. */
  timeoutMs?: number
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Cross-platform spawn wrapper.
 *
 * - On Windows sets `shell: true` so `.cmd` / `.bat` shims (claude.cmd,
 *   npm.cmd, gh.cmd) are executable. Required by Node.js since
 *   CVE-2024-27980; without it, spawning a `.cmd` throws.
 * - On POSIX sets `shell: false` to keep argv boundaries clean and
 *   avoid shell-injection surface on user-provided args.
 * - Streams stdio by default so long commands show progress. Set
 *   `inherit: false` to capture stdout/stderr into the returned
 *   {@link RunResult}.
 * - Throws {@link ExecError} on non-zero exit (captured stdout/stderr
 *   attached) unless the caller passed `inherit: true` (stream mode).
 */
export async function runCommand(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const inherit = opts.inherit ?? true
  const useShell = process.platform === 'win32'
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    shell: useShell,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  }

  // When shell:true, Node hands argv to cmd.exe / sh which re-tokenises
  // the command line. Args containing spaces (commit messages, paths
  // with whitespace, JSON strings) get split unless we quote them.
  // POSIX double-quotes work; Windows cmd.exe also accepts them when
  // we escape inner double quotes as `""`.
  const finalArgs = useShell ? args.map(quoteArgForShell) : args

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, finalArgs, spawnOpts)
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | null = null

    if (!inherit) {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        terminateProcessTree(child.pid)
      }, opts.timeoutMs)
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const exitCode = code ?? -1
      if (exitCode === 0) {
        resolve({ code: exitCode, stdout, stderr })
        return
      }
      if (inherit) {
        // In stream mode we did not capture output; surface an ExecError
        // with empty stdout/stderr so callers still get a typed failure.
        reject(new ExecError(`${cmd} ${args.join(' ')}`.trim(), exitCode, '', ''))
        return
      }
      reject(new ExecError(`${cmd} ${args.join(' ')}`.trim(), exitCode, stdout, stderr))
    })
  })
}

/**
 * Runs a command and returns whether it exited zero. Never throws.
 * Useful for feature-detection style probes (`commandExists`,
 * `git --version`).
 */
export async function tryRunCommand(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<boolean> {
  try {
    await runCommand(cmd, args, { ...opts, inherit: false })
    return true
  } catch {
    return false
  }
}

/**
 * Cross-platform check for whether a command is on PATH. Uses `where`
 * on Windows and `which` on POSIX.
 */
export async function commandExists(cmd: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  return tryRunCommand(probe, [cmd], { inherit: false })
}

/**
 * Terminates a child process tree, not just the immediate child.
 *
 * On POSIX, `child.kill('SIGKILL')` to the immediate child is enough
 * because Node sends the signal to the process and (when detached)
 * its group. We don't detach, so a SIGKILL to the leader works for
 * the common case.
 *
 * On Windows, when shell:true is in effect (always, in this module),
 * the immediate child is cmd.exe. Terminating cmd.exe leaves its
 * spawned children orphaned with stdio pipes still open, and Node's
 * 'close' event never fires on the parent handle. The fix is to ask
 * Windows to terminate the entire descendant tree via taskkill /T /F.
 *
 * Falls back silently when the PID is unavailable or taskkill fails —
 * the caller's promise will eventually reject either way (timeout
 * source unchanged), so the worst-case outcome is the original
 * "orphan child holds the pipe" behaviour.
 */
function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return

  if (process.platform === 'win32') {
    try {
      // /T = include child processes, /F = force.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* taskkill missing or failed — fall through to single-process kill */
    }
    return
  }

  // POSIX: SIGKILL the leader. Node delivers the signal directly.
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* process already exited */
  }
}

/**
 * Quotes a single argv entry so it survives re-tokenisation by cmd.exe
 * (Windows shell:true) or sh (POSIX shell:true). Already-quoted
 * arguments and arguments with no whitespace are returned untouched.
 *
 * The quoting strategy is deliberately simple: wrap in double quotes,
 * escape inner double quotes as `\"`. cmd.exe accepts this dialect
 * uniformly and POSIX sh does too.
 */
function quoteArgForShell(arg: string): string {
  if (arg.length === 0) return '""'
  if (!/\s|[<>|&^"`$\\]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}
