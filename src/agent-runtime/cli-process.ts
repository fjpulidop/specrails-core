import crossSpawn from 'cross-spawn'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { AgentExecutionError } from './executor-types.js'

export interface CliInvocation { command: string; args: string[]; stdin?: string }
export interface CliDuplexControl { send(line: string): void; complete(): void }
export interface CliProcessOptions { cwd: string; signal?: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; duplex?: (control: CliDuplexControl) => void }
export interface CliProcessResult { stdout: string; stderr: string; exitCode: number }
export type CliProcessRunner = (invocation: CliInvocation, options: CliProcessOptions) => Promise<CliProcessResult>
const PROMPT_MARKER = '__SPECRAILS_KIMI_STDIN__'
const BOOTSTRAP = "const fs=require('node:fs');const u=require('node:url');const entry=process.argv[1];const i=process.argv.lastIndexOf('-p')+1;if(i<2||process.argv[i]!=='__SPECRAILS_KIMI_STDIN__')throw Error('Missing prompt marker');process.argv[i]=fs.readFileSync(0,'utf8');import(u.pathToFileURL(entry).href).catch(()=>{process.exitCode=1});"

/** Kimi print mode requires -p. Standard npm shims can transport even large prompts via stdin without cmd.exe parsing them. */
export function windowsKimiInvocation(invocation: CliInvocation, options: { env?: NodeJS.ProcessEnv; exists?: (file: string) => boolean; read?: (file: string) => string; node?: string } = {}): CliInvocation {
  const env = options.env ?? process.env, exists = options.exists ?? existsSync
  const search = Object.entries(env).reverse().find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  let binary: string | undefined
  for (const entry of search.split(';').map(value => value.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) {
    binary = ['kimi.cmd', 'kimi.bat', 'kimi.exe', 'kimi.com'].map(name => path.win32.join(entry, name)).find(exists)
    if (binary) break
  }
  if (!binary) throw new AgentExecutionError('Kimi executable was not found on Windows PATH', 'provider_not_found')
  if (/\.(cmd|bat)$/i.test(binary)) {
    const shim = (options.read ?? (file => readFileSync(file, 'utf8')))(binary)
    const entry = /%dp0%[\\/]([^"\r\n]*?\.(?:mjs|cjs|js))["']?\s+%\*/i.exec(shim)?.[1]
    if (!entry) throw new AgentExecutionError('Unsupported Kimi Windows shim; install the standard npm distribution or a native executable', 'unsupported_windows_shim')
    const localNode = path.win32.join(path.win32.dirname(binary), 'node.exe')
    // process.execPath can be the Desktop pkg sidecar, not a Node interpreter.
    const nodeBinary = options.node ?? (exists(localNode) ? localNode : 'node')
    const args = [...invocation.args], index = args.indexOf('-p') + 1
    if (index === 0) return { command: nodeBinary, args: [path.win32.join(path.win32.dirname(binary), entry), ...args], stdin: invocation.stdin }
    const prompt = args[index]
    args[index] = PROMPT_MARKER
    return { command: nodeBinary, args: ['-e', BOOTSTRAP, path.win32.join(path.win32.dirname(binary), entry), ...args], stdin: prompt }
  }
  if (JSON.stringify(invocation.args).length + binary.length > 28_000) throw new AgentExecutionError('Kimi prompt exceeds the native Windows command line limit; use the standard npm Kimi installation', 'windows_argument_limit')
  return { ...invocation, command: binary }
}
export function cliProcessEnvironment(base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env = { ...base }
  // A nested invocation must not accidentally inherit the surrounding workflow's transport.
  delete env.CLAUDECODE
  delete env.SPECRAILS_INVOCATION_ID
  if (platform === 'win32') {
    for (const name of ['SystemRoot', 'windir', 'ComSpec', 'PATH']) {
      const aliases = Object.keys(env).filter(key => key.toLowerCase() === name.toLowerCase())
      // Match cross-spawn's last-defined alias precedence, then supply one key
      // to both executable lookup and the Windows child's environment block.
      const value = aliases.length ? env[aliases[aliases.length - 1]] : undefined
      for (const key of aliases) delete env[key]
      if (value !== undefined) env[name] = value
    }
    env.SystemRoot ??= env.windir ?? 'C:\\Windows'
    env.windir ??= env.SystemRoot
    env.ComSpec ??= path.win32.join(env.SystemRoot, 'System32', 'cmd.exe')
  }
  return env
}
export const runCliProcess: CliProcessRunner = async (raw, options) => {
  if (options.signal?.aborted) throw new AgentExecutionError('Agent cancelled', 'aborted')
  const env = cliProcessEnvironment(options.env ?? process.env)
  const invocation = process.platform === 'win32' && raw.command === 'kimi' ? windowsKimiInvocation(raw, { env }) : raw
  return new Promise<CliProcessResult>((resolve, reject) => {
    const child = crossSpawn(invocation.command, invocation.args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' })
    let stdout = '', stderr = '', pending = '', failure: Error | undefined, completed = false
    const decoder = new StringDecoder('utf8')
    let termination: Promise<void> | undefined
    const terminate = (): void => {
      if (termination || !child.pid) return
      const pid = child.pid
      termination = process.platform === 'win32'
        ? new Promise<void>(done => {
          const taskkill = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
          execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, env, timeout: 10_000 }, () => { try { child.kill('SIGKILL') } catch { /* exited */ } done() })
        })
        : Promise.resolve().then(() => { try { process.kill(-pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* exited */ } } })
    }
    const fail = (error: Error): void => { failure ??= error; terminate() }
    const abort = (): void => fail(new AgentExecutionError('Agent cancelled', 'aborted'))
    const timer = setTimeout(() => fail(new AgentExecutionError('Agent timed out', 'timeout')), options.timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failure) return
      const text = decoder.write(chunk)
      stdout += text; pending += text
      if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { fail(new AgentExecutionError('CLI output exceeded 8 MiB', 'output_limit')); return }
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1)
        try { options.onLine?.(line) } catch (error) { fail(error instanceof Error ? error : new Error('CLI stream observer failed')) }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-32_768) })
    child.stdin?.on('error', () => { /* EPIPE is resolved by the process close result. */ })
    child.once('error', error => { failure ??= new AgentExecutionError(`Cannot launch ${raw.command}: ${error.message}`, 'provider_spawn_error') })
    child.once('close', (code) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      void (termination ?? Promise.resolve()).then(() => {
        if (failure) { reject(failure); return }
        try { if (pending) options.onLine?.(pending) } catch (error) { reject(error); return }
        resolve({ stdout, stderr, exitCode: completed ? 0 : code ?? -1 })
      })
    })
    if (options.duplex) {
      try {
        options.duplex({ send: line => { if (!failure && !completed) child.stdin?.write(line + '\n', 'utf8') }, complete: () => { completed = true; terminate() } })
      } catch (error) { fail(error instanceof Error ? error : new Error('Duplex initialization failed')) }
    } else child.stdin?.end(invocation.stdin ?? '', 'utf8')
  })
}
