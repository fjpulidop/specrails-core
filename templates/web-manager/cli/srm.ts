#!/usr/bin/env node
/**
 * srm — specrails CLI bridge
 *
 * Routes commands to the web-manager when running, or falls back to invoking
 * claude directly when the web-manager is not reachable.
 *
 * Usage:
 *   srm implement #42           → /sr:implement #42 (via web-manager or direct)
 *   srm "any raw prompt"        → raw prompt (no /sr: prefix)
 *   srm --status                → print web-manager state
 *   srm --jobs                  → print job history table
 *   srm --port 5000 <command>   → use port 5000 instead of 4200
 *   srm --help                  → print usage and exit 0
 */

import http from 'http'
import { spawn } from 'child_process'
import { spawn as spawnProc } from 'child_process'
import { createInterface } from 'readline'
import WebSocket from 'ws'
import path from 'path'
import os from 'os'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 4200
const DETECTION_TIMEOUT_MS = 500

const KNOWN_VERBS = new Set([
  'implement',
  'batch-implement',
  'why',
  'product-backlog',
  'update-product-driven-backlog',
  'refactor-recommender',
  'health-check',
  'compat-check',
])

const EXIT_PATTERN = /\[process exited with code (\d+)/

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY === true

function ansi(code: string, text: string): string {
  if (!isTTY) return text
  return `\x1b[${code}m${text}\x1b[0m`
}

const dim = (t: string) => ansi('2', t)
const red = (t: string) => ansi('31', t)
const bold = (t: string) => ansi('1', t)
const dimCyan = (t: string) => ansi('2;36', t)

function srmPrefix(): string {
  return dim('[srm]')
}

function srmLog(msg: string): void {
  process.stdout.write(`${srmPrefix()} ${msg}\n`)
}

function srmError(msg: string): void {
  process.stderr.write(`${srmPrefix()} ${red(`error: ${msg}`)}\n`)
}

function srmWarn(msg: string): void {
  process.stderr.write(`${srmPrefix()} ${dim(`warning: ${msg}`)}\n`)
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

export type ParsedArgs =
  | { mode: 'help' }
  | { mode: 'status'; port: number }
  | { mode: 'jobs'; port: number }
  | { mode: 'hub'; subArgs: string[]; port: number }
  | { mode: 'command'; resolved: string; port: number }
  | { mode: 'raw'; resolved: string; port: number }

export function parseArgs(argv: string[]): ParsedArgs {
  // argv is process.argv.slice(2)
  let port = DEFAULT_PORT
  const args = [...argv]

  // Extract --port <n> from any position
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10)
      if (!isNaN(parsed)) {
        port = parsed
      }
      args.splice(i, 2)
      i--
    }
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { mode: 'help' }
  }

  if (args[0] === '--status') {
    return { mode: 'status', port }
  }

  if (args[0] === '--jobs') {
    return { mode: 'jobs', port }
  }

  if (args[0] === 'hub') {
    return { mode: 'hub', subArgs: args.slice(1), port }
  }

  const first = args[0]

  // Slash-prefixed command: pass through unchanged
  if (first.startsWith('/')) {
    const resolved = args.join(' ')
    return { mode: 'raw', resolved, port }
  }

  // Known verb: inject /sr: prefix
  if (KNOWN_VERBS.has(first)) {
    const resolved = `/sr:${args.join(' ')}`
    return { mode: 'command', resolved, port }
  }

  // Unknown first token: treat as raw prompt
  const resolved = args.join(' ')
  return { mode: 'raw', resolved, port }
}

function printHelp(): void {
  process.stdout.write(`
${bold('srm')} — specrails CLI bridge

${bold('Usage:')}
  srm implement #42                Run a known specrails verb (prepends /sr:)
  srm batch-implement #40 #41      Known verbs: ${[...KNOWN_VERBS].join(', ')}
  srm "any raw prompt"             Pass a raw prompt directly to claude
  srm --status                     Print web-manager status and exit
  srm --jobs                       Print recent job history and exit
  srm hub <subcommand>             Manage the hub (multi-project mode)
  srm --port <n>                   Override default port (${DEFAULT_PORT})
  srm --help                       Show this help text

${bold('Execution paths:')}
  Web-manager running → POST /api/spawn + stream logs via WebSocket
  Web-manager not running → spawn claude directly with stream-json output
`.trimStart())
}

// ---------------------------------------------------------------------------
// Web-manager detection
// ---------------------------------------------------------------------------

export interface DetectionResult {
  running: boolean
  baseUrl: string
}

export function detectWebManager(port: number): Promise<DetectionResult> {
  const baseUrl = `http://127.0.0.1:${port}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy()
      resolve({ running: false, baseUrl })
    }, DETECTION_TIMEOUT_MS)

    const req = http.get(`${baseUrl}/api/state`, { timeout: DETECTION_TIMEOUT_MS }, (res) => {
      clearTimeout(timer)
      res.resume() // drain the response
      if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ running: true, baseUrl })
      } else {
        resolve({ running: false, baseUrl })
      }
    })

    req.on('error', () => {
      clearTimeout(timer)
      resolve({ running: false, baseUrl })
    })

    req.on('timeout', () => {
      req.destroy()
      clearTimeout(timer)
      resolve({ running: false, baseUrl })
    })
  })
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
  })
}

function httpPost(url: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const urlObj = new URL(url)
    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }
    const req = http.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------

export function formatTokens(n: number): string {
  return new Intl.NumberFormat('en-US', { useGrouping: true })
    .format(n)
    .replace(/,/g, ' ')
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

export interface SummaryData {
  durationMs: number
  costUsd?: number
  totalTokens?: number
  exitCode: number
}

export function printSummary(data: SummaryData): void {
  const doneLabel = isTTY ? bold('[srm] done') : '[srm] done'
  const durationPart = `duration: ${formatDuration(data.durationMs)}`
  const costPart = data.costUsd != null ? `  cost: $${data.costUsd.toFixed(2)}` : ''
  const tokenPart = data.totalTokens != null ? `  tokens: ${formatTokens(data.totalTokens)}` : ''
  const exitPart = `  exit: ${data.exitCode}`

  process.stdout.write(`${doneLabel}  ${durationPart}${costPart}${tokenPart}${exitPart}\n`)
}

// ---------------------------------------------------------------------------
// Web-manager path
// ---------------------------------------------------------------------------

interface WsLogMessage {
  type: 'log'
  source: 'stdout' | 'stderr'
  line: string
  processId: string
}

interface WsPhaseMessage {
  type: 'phase'
  phase: string
  state: string
}

interface WsInitMessage {
  type: 'init'
  logBuffer: WsLogMessage[]
}

type WsMsg = WsLogMessage | WsPhaseMessage | WsInitMessage | { type: string }

// ---------------------------------------------------------------------------
// Hub mode: resolve project context from CWD
// ---------------------------------------------------------------------------

interface HubProject {
  id: string
  name: string
  path: string
}

async function resolveProjectFromCwd(baseUrl: string): Promise<HubProject | null> {
  try {
    const cwd = process.cwd()
    const res = await httpGet(`${baseUrl}/api/hub/resolve?path=${encodeURIComponent(cwd)}`)
    if (res.status === 200) {
      const data = JSON.parse(res.body) as { project?: HubProject }
      return data.project ?? null
    }
  } catch {
    // Hub endpoint not available — not in hub mode
  }
  return null
}

async function runViaWebManager(command: string, baseUrl: string): Promise<number> {
  // Detect hub mode: check if /api/hub/state is reachable
  let spawnUrl = `${baseUrl}/api/spawn`
  let jobApiBase = `${baseUrl}/api`

  try {
    const hubCheck = await httpGet(`${baseUrl}/api/hub/state`)
    if (hubCheck.status === 200) {
      // Hub mode: resolve project from CWD
      const project = await resolveProjectFromCwd(baseUrl)
      if (!project) {
        srmError(
          'hub is running but no project registered for the current directory.\n' +
          `  Run: srm hub add ${process.cwd()}`
        )
        return 1
      }
      spawnUrl = `${baseUrl}/api/projects/${project.id}/spawn`
      jobApiBase = `${baseUrl}/api/projects/${project.id}`
      srmLog(`project: ${project.name}`)
    }
  } catch {
    // Single-project mode — use default paths
  }

  // Spawn the job
  let spawnRes: { status: number; body: string }
  try {
    spawnRes = await httpPost(spawnUrl, { command })
  } catch (err) {
    srmError('failed to connect to web-manager')
    return 1
  }

  if (spawnRes.status === 409) {
    srmError('web-manager is busy (another job is running)')
    return 1
  }

  if (spawnRes.status >= 400) {
    let errMsg = `spawn failed with HTTP ${spawnRes.status}`
    try {
      const parsed = JSON.parse(spawnRes.body) as { error?: string }
      if (parsed.error) errMsg = parsed.error
    } catch { /* use default */ }
    srmError(errMsg)
    return 1
  }

  let processId: string
  try {
    const parsed = JSON.parse(spawnRes.body) as { jobId?: string; processId?: string }
    // Server returns jobId; processId is the legacy field name used in LogMessage
    processId = (parsed.jobId ?? parsed.processId) ?? ''
    if (!processId) throw new Error('missing jobId')
  } catch {
    srmError('invalid response from /api/spawn')
    return 1
  }

  const startTime = Date.now()

  // Connect WebSocket and stream logs
  const wsUrl = baseUrl.replace(/^http/, 'ws')
  let exitCode = 1
  let resolved = false

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(wsUrl)

    ws.on('message', (data) => {
      let msg: WsMsg
      try {
        msg = JSON.parse(data.toString()) as WsMsg
      } catch {
        return
      }

      if (msg.type === 'init') {
        // Replay only log lines from our processId
        const initMsg = msg as WsInitMessage
        for (const logLine of initMsg.logBuffer) {
          if (logLine.processId === processId) {
            handleLogLine(logLine)
          }
        }
        return
      }

      if (msg.type === 'log') {
        const logMsg = msg as WsLogMessage
        if (logMsg.processId !== processId) return
        handleLogLine(logMsg)
        return
      }

      if (msg.type === 'phase') {
        const phaseMsg = msg as WsPhaseMessage
        process.stdout.write(`  ${dimCyan(`→ [${phaseMsg.phase}] ${phaseMsg.state}`)}\n`)
        return
      }
    })

    function handleLogLine(logMsg: WsLogMessage): void {
      if (resolved) return

      // Check for exit signal
      const match = EXIT_PATTERN.exec(logMsg.line)
      if (match) {
        exitCode = parseInt(match[1], 10)
        resolved = true
        ws.close()
        resolve()
        return
      }

      // Print to appropriate stream, preserving ANSI
      if (logMsg.source === 'stderr') {
        process.stderr.write(`${logMsg.line}\n`)
      } else {
        process.stdout.write(`${logMsg.line}\n`)
      }
    }

    ws.on('close', () => {
      if (!resolved) {
        srmWarn('lost connection to web-manager')
        resolved = true
        resolve()
      }
    })

    ws.on('error', (err) => {
      if (!resolved) {
        srmWarn(`WebSocket error: ${err.message}`)
        resolved = true
        resolve()
      }
    })
  })

  const durationMs = Date.now() - startTime

  // Fetch job metadata for cost/tokens
  let costUsd: number | undefined
  let totalTokens: number | undefined

  try {
    const jobRes = await httpGet(`${jobApiBase}/jobs/${processId}`)
    if (jobRes.status === 200) {
      const parsed = JSON.parse(jobRes.body) as {
        job?: {
          total_cost_usd?: number | null
          tokens_in?: number | null
          tokens_out?: number | null
          duration_ms?: number | null
        }
      }
      if (parsed.job) {
        if (parsed.job.total_cost_usd != null) costUsd = parsed.job.total_cost_usd
        const tokensIn = parsed.job.tokens_in ?? 0
        const tokensOut = parsed.job.tokens_out ?? 0
        if (parsed.job.tokens_in != null || parsed.job.tokens_out != null) {
          totalTokens = tokensIn + tokensOut
        }
        // Prefer server-side duration when available
        if (parsed.job.duration_ms != null) {
          printSummary({ durationMs: parsed.job.duration_ms, costUsd, totalTokens, exitCode })
          return exitCode
        }
      }
    }
  } catch { /* fall through to duration-only summary */ }

  printSummary({ durationMs, costUsd, totalTokens, exitCode })
  return exitCode
}

// ---------------------------------------------------------------------------
// Direct fallback path
// ---------------------------------------------------------------------------

interface StreamJsonResult {
  cost_usd?: number
  input_tokens?: number
  output_tokens?: number
}

async function runDirect(command: string): Promise<number> {
  const startTime = Date.now()

  const args = [
    '--dangerously-skip-permissions',
    '-p',
    ...command.trim().split(/\s+/),
    '--output-format', 'stream-json',
    '--verbose',
  ]

  let child: ReturnType<typeof spawn>
  try {
    child = spawn('claude', args, {
      env: process.env,
      shell: false,
    })
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      srmError('claude binary not found')
    } else {
      srmError(`failed to spawn claude: ${(err as Error).message}`)
    }
    return 1
  }

  let resultData: StreamJsonResult | undefined

  // Stderr: pass through unchanged
  child.stderr?.pipe(process.stderr)

  // Stdout: parse NDJSON line by line
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

  rl.on('line', (line) => {
    if (!line.trim()) return

    let parsed: { type?: string } | null = null
    try {
      parsed = JSON.parse(line) as { type?: string }
    } catch {
      // Non-JSON line: print as-is
      process.stdout.write(`${line}\n`)
      return
    }

    if (parsed.type === 'text') {
      const content = (parsed as { content?: string }).content ?? ''
      if (content) process.stdout.write(`${content}\n`)
    } else if (parsed.type === 'result') {
      resultData = parsed as StreamJsonResult
    }
    // All other types: silently ignore
  })

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => {
      resolve(code ?? 1)
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        srmError('claude binary not found')
      } else {
        srmError(`claude process error: ${err.message}`)
      }
      resolve(1)
    })
  })

  const durationMs = Date.now() - startTime

  let costUsd: number | undefined
  let totalTokens: number | undefined

  if (resultData) {
    if (resultData.cost_usd != null) costUsd = resultData.cost_usd
    const tokensIn = resultData.input_tokens ?? 0
    const tokensOut = resultData.output_tokens ?? 0
    if (resultData.input_tokens != null || resultData.output_tokens != null) {
      totalTokens = tokensIn + tokensOut
    }
  }

  printSummary({ durationMs, costUsd, totalTokens, exitCode })
  return exitCode
}

// ---------------------------------------------------------------------------
// --status handler
// ---------------------------------------------------------------------------

async function handleStatus(port: number): Promise<number> {
  const baseUrl = `http://127.0.0.1:${port}`
  const detection = await detectWebManager(port)

  if (!detection.running) {
    process.stdout.write(`web-manager: not running (${baseUrl})\n`)
    return 1
  }

  try {
    const res = await httpGet(`${baseUrl}/api/state`)
    if (res.status !== 200) {
      process.stdout.write(`web-manager: not running (${baseUrl})\n`)
      return 1
    }

    const state = JSON.parse(res.body) as {
      projectName?: string
      busy?: boolean
      phases?: Record<string, string>
      version?: string
    }

    const version = state.version ? `  (v${state.version})` : ''
    process.stdout.write(`web-manager: running${version}\n`)
    process.stdout.write(`project:     ${state.projectName ?? 'unknown'}\n`)
    process.stdout.write(`busy:        ${state.busy ? 'true' : 'false'}\n`)

    if (state.phases) {
      const phaseStr = Object.entries(state.phases)
        .map(([phase, st]) => `${phase}=${st}`)
        .join('  ')
      process.stdout.write(`phases:      ${phaseStr}\n`)
    }

    return 0
  } catch {
    process.stdout.write(`web-manager: not running (${baseUrl})\n`)
    return 1
  }
}

// ---------------------------------------------------------------------------
// --jobs handler
// ---------------------------------------------------------------------------

interface JobRow {
  id: string
  command: string
  started_at: string
  duration_ms: number | null
  exit_code: number | null
  status: string
}

interface JobsResponse {
  jobs: JobRow[]
  total: number
}

function formatJobDuration(ms: number | null): string {
  if (ms == null) return '-'
  return formatDuration(ms)
}

function formatJobStarted(isoStr: string): string {
  try {
    const d = new Date(isoStr)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${min}`
  } catch {
    return isoStr.slice(0, 16)
  }
}

async function handleJobs(port: number): Promise<number> {
  const baseUrl = `http://127.0.0.1:${port}`
  const detection = await detectWebManager(port)

  if (!detection.running) {
    srmError(`web-manager is not running (${baseUrl})`)
    return 1
  }

  let res: { status: number; body: string }
  try {
    res = await httpGet(`${baseUrl}/api/jobs`)
  } catch {
    srmError('failed to fetch job list')
    return 1
  }

  if (res.status === 501 || res.status === 404) {
    srmLog('jobs history requires web-manager with SQLite persistence (#57)')
    return 1
  }

  if (res.status !== 200) {
    srmError(`unexpected response from /api/jobs: HTTP ${res.status}`)
    return 1
  }

  let data: JobsResponse
  try {
    data = JSON.parse(res.body) as JobsResponse
  } catch {
    srmError('invalid response from /api/jobs')
    return 1
  }

  if (!data.jobs || data.jobs.length === 0) {
    srmLog('no jobs recorded yet')
    return 0
  }

  // Column widths
  const idW = 8
  const cmdW = 30
  const startW = 18
  const durW = 8
  const exitW = 4

  const header = [
    'ID'.padEnd(idW),
    'COMMAND'.padEnd(cmdW),
    'STARTED'.padEnd(startW),
    'DURATION'.padEnd(durW),
    'EXIT'.padEnd(exitW),
  ].join('  ')

  process.stdout.write(`${bold(header)}\n`)

  for (const job of data.jobs) {
    const idCell = job.id.slice(0, idW).padEnd(idW)
    const cmdCell = job.command.slice(0, cmdW).padEnd(cmdW)
    const startCell = formatJobStarted(job.started_at).padEnd(startW)
    const durCell = formatJobDuration(job.duration_ms).padEnd(durW)
    const exitCell = (job.exit_code ?? '-').toString().padEnd(exitW)
    process.stdout.write(`${idCell}  ${cmdCell}  ${startCell}  ${durCell}  ${exitCell}\n`)
  }

  return 0
}

// ---------------------------------------------------------------------------
// Hub subcommand group
// ---------------------------------------------------------------------------

const HUB_PID_FILE = path.join(os.homedir(), '.specrails', 'web-manager.pid')

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(HUB_PID_FILE, 'utf-8').trim()
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function hubServerPath(): string {
  // srm lives at cli/dist/srm.js; server is at ../server/index.js (built)
  // In dev mode with tsx, we resolve from __filename
  const base = path.resolve(__dirname, '..')
  // Try compiled JS first, then fall back to tsx dev path
  const compiled = path.join(base, 'server', 'index.js')
  const devTs = path.join(base, 'server', 'index.ts')
  if (fs.existsSync(compiled)) return compiled
  if (fs.existsSync(devTs)) return devTs
  return compiled
}

async function hubStart(port: number): Promise<number> {
  const pid = readPid()
  if (pid !== null && isProcessRunning(pid)) {
    srmLog(`hub already running (pid ${pid}) on port ${port}`)
    return 0
  }

  const serverPath = hubServerPath()
  const isTs = serverPath.endsWith('.ts')
  const args = isTs
    ? ['tsx', serverPath, '--hub', '--port', String(port)]
    : ['node', serverPath, '--hub', '--port', String(port)]

  const child = spawnProc(args[0], args.slice(1), {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SPECRAILS_HUB: '1' },
  })
  child.unref()

  // Wait briefly and confirm it started
  await new Promise<void>((resolve) => setTimeout(resolve, 800))
  const detection = await detectWebManager(port)
  if (detection.running) {
    srmLog(`hub started on http://127.0.0.1:${port}`)
    return 0
  }
  srmError('hub failed to start (check logs)')
  return 1
}

async function hubStop(): Promise<number> {
  const pid = readPid()
  if (pid === null) {
    srmLog('hub is not running (no pid file)')
    return 0
  }
  if (!isProcessRunning(pid)) {
    srmLog('hub is not running (stale pid file)')
    try { fs.unlinkSync(HUB_PID_FILE) } catch { /* ignore */ }
    return 0
  }
  try {
    process.kill(pid, 'SIGTERM')
    srmLog(`hub stopped (pid ${pid})`)
    return 0
  } catch (err) {
    srmError(`failed to stop hub: ${(err as Error).message}`)
    return 1
  }
}

async function hubStatus(port: number): Promise<number> {
  const pid = readPid()
  const detection = await detectWebManager(port)

  if (!detection.running) {
    process.stdout.write(`hub: not running\n`)
    return 1
  }

  try {
    const res = await httpGet(`${detection.baseUrl}/api/hub/state`)
    const state = JSON.parse(res.body) as { projectCount?: number; projects?: Array<{ name: string }> }
    process.stdout.write(`hub: running (pid ${pid ?? '?'}) on ${detection.baseUrl}\n`)
    process.stdout.write(`projects: ${state.projectCount ?? 0}\n`)
    if (state.projects) {
      for (const p of state.projects) {
        process.stdout.write(`  - ${p.name}\n`)
      }
    }
    return 0
  } catch {
    process.stdout.write(`hub: running on ${detection.baseUrl}\n`)
    return 0
  }
}

async function hubAdd(projectPath: string, port: number): Promise<number> {
  const detection = await detectWebManager(port)
  if (!detection.running) {
    srmError('hub is not running. Start it first with: srm hub start')
    return 1
  }
  try {
    const res = await httpPost(`${detection.baseUrl}/api/hub/projects`, {
      path: path.resolve(projectPath),
    })
    if (res.status === 201) {
      const data = JSON.parse(res.body) as { project?: { name: string; id: string } }
      srmLog(`added project: ${data.project?.name ?? projectPath}`)
      return 0
    } else if (res.status === 409) {
      srmLog('project already registered')
      return 0
    } else {
      let errMsg = `HTTP ${res.status}`
      try { errMsg = (JSON.parse(res.body) as { error?: string }).error ?? errMsg } catch { /* use default */ }
      srmError(`failed to add project: ${errMsg}`)
      return 1
    }
  } catch (err) {
    srmError(`failed to connect to hub: ${(err as Error).message}`)
    return 1
  }
}

async function hubRemove(projectId: string, port: number): Promise<number> {
  const detection = await detectWebManager(port)
  if (!detection.running) {
    srmError('hub is not running')
    return 1
  }
  try {
    const deleteRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const urlObj = new URL(`${detection.baseUrl}/api/hub/projects/${projectId}`)
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'DELETE',
      }
      const req = http.request(options, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
    if (deleteRes.status === 200) {
      srmLog(`project removed`)
      return 0
    } else {
      srmError(`failed to remove project: HTTP ${deleteRes.status}`)
      return 1
    }
  } catch (err) {
    srmError(`failed to connect to hub: ${(err as Error).message}`)
    return 1
  }
}

async function hubList(port: number): Promise<number> {
  const detection = await detectWebManager(port)
  if (!detection.running) {
    srmError('hub is not running')
    return 1
  }
  try {
    const res = await httpGet(`${detection.baseUrl}/api/hub/projects`)
    const data = JSON.parse(res.body) as { projects: Array<{ id: string; name: string; path: string }> }
    if (!data.projects || data.projects.length === 0) {
      srmLog('no projects registered')
      return 0
    }
    const idW = 36
    const nameW = 24
    process.stdout.write(`${bold('ID'.padEnd(idW))}  ${bold('NAME'.padEnd(nameW))}  ${bold('PATH')}\n`)
    for (const p of data.projects) {
      process.stdout.write(`${p.id.padEnd(idW)}  ${p.name.padEnd(nameW)}  ${p.path}\n`)
    }
    return 0
  } catch (err) {
    srmError(`failed to fetch projects: ${(err as Error).message}`)
    return 1
  }
}

async function handleHub(subArgs: string[], port: number): Promise<number> {
  const sub = subArgs[0]

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(`
${bold('srm hub')} — manage the specrails hub (multi-project mode)

${bold('Usage:')}
  srm hub start              Start the hub server
  srm hub stop               Stop the hub server
  srm hub status             Show hub status and registered projects
  srm hub add <path>         Register a project by path
  srm hub remove <id>        Unregister a project by ID
  srm hub list               List all registered projects
`.trimStart())
    return 0
  }

  if (sub === 'start') {
    return hubStart(port)
  }
  if (sub === 'stop') {
    return hubStop()
  }
  if (sub === 'status') {
    return hubStatus(port)
  }
  if (sub === 'add') {
    const projectPath = subArgs[1]
    if (!projectPath) {
      srmError('usage: srm hub add <path>')
      return 1
    }
    return hubAdd(projectPath, port)
  }
  if (sub === 'remove') {
    const projectId = subArgs[1]
    if (!projectId) {
      srmError('usage: srm hub remove <id>')
      return 1
    }
    return hubRemove(projectId, port)
  }
  if (sub === 'list') {
    return hubList(port)
  }

  srmError(`unknown hub subcommand: ${sub}`)
  return 1
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const parsed = parseArgs(argv)

  if (parsed.mode === 'help') {
    printHelp()
    process.exit(0)
  }

  if (parsed.mode === 'status') {
    const code = await handleStatus(parsed.port)
    process.exit(code)
  }

  if (parsed.mode === 'jobs') {
    const code = await handleJobs(parsed.port)
    process.exit(code)
  }

  if (parsed.mode === 'hub') {
    const code = await handleHub(parsed.subArgs, parsed.port)
    process.exit(code)
  }

  // Command or raw: resolve command string
  const command = parsed.resolved
  const port = parsed.port

  srmLog(`running: ${command}`)

  const detection = await detectWebManager(port)

  let exitCode: number

  if (detection.running) {
    srmLog(`routing via web-manager at ${detection.baseUrl}`)
    exitCode = await runViaWebManager(command, detection.baseUrl)
  } else {
    srmLog('web-manager not running — invoking claude directly')
    exitCode = await runDirect(command)
  }

  process.exit(exitCode)
}

// Only run main() when this file is executed directly (not when imported in tests)
if (require.main === module) {
  main().catch((err: unknown) => {
    srmError((err as Error).message ?? String(err))
    process.exit(1)
  })
}
