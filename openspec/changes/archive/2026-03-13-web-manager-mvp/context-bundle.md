---
change: web-manager-mvp
type: context-bundle
---

# Context Bundle: specrails Web Manager — MVP Pipeline Monitor

This document contains everything a developer needs to implement this change without reading any other file. It bundles key context from the design, delta-spec, and codebase.

---

## What You Are Building

A locally-run web dashboard at `web/` in the specrails repo that:

1. **Visualizes** the four pipeline phases (Architect → Developer → Reviewer → Ship) with live state indicators (idle / running / done / error)
2. **Streams logs** in real-time from spawned `claude` CLI processes, with a search/filter input
3. **Launches commands** via a command input that spawns `claude --dangerously-skip-permissions <command>`
4. **Receives Claude Code hook events** via `POST /hooks/events` and translates them into phase state transitions

The system is: Node.js Express + WebSocket server (`web/server/`) + React + TypeScript Vite frontend (`web/client/`).

This is **100% new code** — no existing specrails files are modified.

---

## Files to Create

| Path | Change type | Notes |
|------|------------|-------|
| `web/package.json` | Create | Workspace root. Scripts: `dev`, `dev:server`, `dev:client`, `build`, `typecheck` |
| `web/tsconfig.json` | Create | Server-side TypeScript config |
| `web/server/types.ts` | Create | Shared type definitions — source of truth for all interfaces |
| `web/server/index.ts` | Create | Express + WebSocket server entry point |
| `web/server/spawner.ts` | Create | Claude CLI process spawner |
| `web/server/hooks.ts` | Create | Hook event receiver + pipeline state machine |
| `web/client/package.json` | Create | React frontend dependencies |
| `web/client/tsconfig.json` | Create | Client TypeScript config |
| `web/client/vite.config.ts` | Create | Vite config with `/api` and `/hooks` proxy |
| `web/client/index.html` | Create | Vite HTML entry |
| `web/client/src/main.tsx` | Create | Renders `<App />` |
| `web/client/src/App.tsx` | Create | Root layout: 3-zone CSS grid |
| `web/client/src/components/PipelineSidebar.tsx` | Create | Phase list with state indicator dots |
| `web/client/src/components/AgentActivity.tsx` | Create | Log panel container |
| `web/client/src/components/LogStream.tsx` | Create | Scrollable log renderer |
| `web/client/src/components/SearchBox.tsx` | Create | Filter text input with clear button |
| `web/client/src/components/CommandInput.tsx` | Create | Command dispatch input + Run button |
| `web/client/src/hooks/useWebSocket.ts` | Create | WS client with auto-reconnect |
| `web/client/src/hooks/usePipeline.ts` | Create | Pipeline state derived from WS messages |
| `web/README.md` | Create | Setup and usage docs |

**Do NOT modify:**
- `install.sh`
- `templates/` (any file)
- `.claude/` (any file)
- `openspec/` (any file)
- `CLAUDE.md`
- `README.md` (repo root)
- `package.json` at repo root (there isn't one — do not create one at repo root either)

---

## Exact Implementation

### web/package.json

```json
{
  "name": "specrails-web",
  "private": true,
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "tsx watch server/index.ts",
    "dev:client": "cd client && npm run dev",
    "build": "cd client && npm run build",
    "typecheck": "tsc --noEmit && cd client && tsc --noEmit"
  },
  "dependencies": {
    "express": "^4.18.0",
    "ws": "^8.16.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "@types/ws": "^8.5.0",
    "@types/uuid": "^9.0.0",
    "@types/node": "^20.0.0",
    "concurrently": "^8.2.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  }
}
```

### web/tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist/server",
    "rootDir": "server",
    "skipLibCheck": true
  },
  "include": ["server/**/*.ts"],
  "exclude": ["node_modules", "client"]
}
```

### web/server/types.ts

```typescript
export type PhaseName = 'architect' | 'developer' | 'reviewer' | 'ship'
export type PhaseState = 'idle' | 'running' | 'done' | 'error'

export interface LogMessage {
  type: 'log'
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
  processId: string
}

export interface PhaseMessage {
  type: 'phase'
  phase: PhaseName
  state: PhaseState
  timestamp: string
}

export interface InitMessage {
  type: 'init'
  projectName: string
  phases: Record<PhaseName, PhaseState>
  logBuffer: LogMessage[]
}

export type WsMessage = LogMessage | PhaseMessage | InitMessage

export interface SpawnHandle {
  processId: string
  command: string
  startedAt: string
}

export class ClaudeNotFoundError extends Error {
  constructor() {
    super('claude binary not found')
    this.name = 'ClaudeNotFoundError'
  }
}

export class SpawnBusyError extends Error {
  constructor() {
    super('A process is already running')
    this.name = 'SpawnBusyError'
  }
}
```

### web/server/hooks.ts

```typescript
import { Router, Request, Response } from 'express'
import type { PhaseName, PhaseState, WsMessage } from './types'

const PHASE_NAMES: PhaseName[] = ['architect', 'developer', 'reviewer', 'ship']

const phases: Record<PhaseName, PhaseState> = {
  architect: 'idle',
  developer: 'idle',
  reviewer: 'idle',
  ship: 'idle',
}

function isValidPhase(value: string): value is PhaseName {
  return PHASE_NAMES.includes(value as PhaseName)
}

function eventToState(event: string): PhaseState | null {
  if (event === 'agent_start') return 'running'
  if (event === 'agent_stop') return 'done'
  if (event === 'agent_error') return 'error'
  return null
}

export function getPhaseStates(): Record<PhaseName, PhaseState> {
  return { ...phases }
}

export function resetPhases(broadcast: (msg: WsMessage) => void): void {
  for (const phase of PHASE_NAMES) {
    phases[phase] = 'idle'
    broadcast({
      type: 'phase',
      phase,
      state: 'idle',
      timestamp: new Date().toISOString(),
    })
  }
}

export function createHooksRouter(broadcast: (msg: WsMessage) => void): Router {
  const router = Router()

  router.post('/events', (req: Request, res: Response) => {
    const { event, agent } = req.body ?? {}

    if (!agent || !isValidPhase(agent)) {
      console.warn(`[hooks] unknown agent: ${agent}`)
      res.json({ ok: true })
      return
    }

    const newState = eventToState(event)
    if (!newState) {
      console.warn(`[hooks] unknown event: ${event}`)
      res.json({ ok: true })
      return
    }

    phases[agent] = newState
    broadcast({
      type: 'phase',
      phase: agent,
      state: newState,
      timestamp: new Date().toISOString(),
    })

    res.json({ ok: true })
  })

  return router
}
```

### web/server/spawner.ts

```typescript
import { spawn, execSync, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { v4 as uuidv4 } from 'uuid'
import type { WsMessage, LogMessage, SpawnHandle } from './types'
import { ClaudeNotFoundError, SpawnBusyError } from './types'

// Circular log buffer
const LOG_BUFFER_MAX = 5000
const LOG_BUFFER_DROP = 1000
const logBuffer: LogMessage[] = []

let activeProcess: ChildProcess | null = null

function appendToBuffer(msg: LogMessage): void {
  logBuffer.push(msg)
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.splice(0, LOG_BUFFER_DROP)
  }
}

function claudeOnPath(): boolean {
  try {
    execSync('which claude', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function isSpawnActive(): boolean {
  return activeProcess !== null
}

export function getLogBuffer(): LogMessage[] {
  return [...logBuffer]
}

export function spawnClaude(
  command: string,
  broadcast: (msg: WsMessage) => void,
  onResetPhases: () => void
): SpawnHandle {
  if (!claudeOnPath()) {
    throw new ClaudeNotFoundError()
  }
  if (activeProcess !== null) {
    throw new SpawnBusyError()
  }

  onResetPhases()

  const processId = uuidv4()
  const startedAt = new Date().toISOString()

  // Split command string into args, respecting quoted strings is not needed
  // for MVP — simple space split is sufficient for slash commands like /implement #42
  const args = ['--dangerously-skip-permissions', ...command.trim().split(/\s+/)]
  const child = spawn('claude', args, {
    env: process.env,
    shell: false,
  })

  activeProcess = child

  function emitLine(source: 'stdout' | 'stderr', line: string): void {
    const msg: LogMessage = {
      type: 'log',
      source,
      line,
      timestamp: new Date().toISOString(),
      processId,
    }
    appendToBuffer(msg)
    broadcast(msg)
  }

  const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })

  stdoutReader.on('line', (line) => emitLine('stdout', line))
  stderrReader.on('line', (line) => emitLine('stderr', line))

  child.on('close', (code) => {
    emitLine('stdout', `[process exited with code ${code ?? 'unknown'}]`)
    activeProcess = null
  })

  return { processId, command, startedAt }
}
```

### web/server/index.ts

```typescript
import http from 'http'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import type { WsMessage } from './types'
import { ClaudeNotFoundError, SpawnBusyError } from './types'
import { createHooksRouter, getPhaseStates, resetPhases } from './hooks'
import { spawnClaude, isSpawnActive, getLogBuffer } from './spawner'

// Parse CLI args
let projectName = 'specrails'
let port = 3001

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--project' && process.argv[i + 1]) {
    projectName = process.argv[++i]
  } else if (process.argv[i] === '--port' && process.argv[i + 1]) {
    port = parseInt(process.argv[++i], 10)
  }
}

const app = express()
app.use(express.json())

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

const clients = new Set<WebSocket>()

function broadcast(msg: WsMessage): void {
  const data = JSON.stringify(msg)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws)

  const initMsg: WsMessage = {
    type: 'init',
    projectName,
    phases: getPhaseStates(),
    logBuffer: getLogBuffer().slice(-500),
  }
  ws.send(JSON.stringify(initMsg))

  ws.on('close', () => {
    clients.delete(ws)
  })
})

// Routes
app.use('/hooks', createHooksRouter(broadcast))

app.post('/api/spawn', (req, res) => {
  const { command } = req.body ?? {}
  if (!command || typeof command !== 'string' || !command.trim()) {
    res.status(400).json({ error: 'command is required' })
    return
  }

  try {
    const handle = spawnClaude(
      command,
      broadcast,
      () => resetPhases(broadcast)
    )
    res.json({ processId: handle.processId })
  } catch (err) {
    if (err instanceof ClaudeNotFoundError) {
      res.status(400).json({ error: err.message })
    } else if (err instanceof SpawnBusyError) {
      res.status(409).json({ error: err.message })
    } else {
      console.error('[spawn] unexpected error:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
})

app.get('/api/state', (_req, res) => {
  res.json({
    projectName,
    phases: getPhaseStates(),
    busy: isSpawnActive(),
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`specrails web manager running on http://127.0.0.1:${port}`)
})
```

### web/client/vite.config.ts

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/hooks': 'http://localhost:3001',
    },
  },
})
```

### web/client/index.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>specrails manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### web/client/src/main.tsx

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

### web/client/src/hooks/useWebSocket.ts

```typescript
import { useEffect, useRef, useState, useCallback } from 'react'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000]

export function useWebSocket(
  url: string,
  onMessage: (data: unknown) => void
): { connectionStatus: ConnectionStatus } {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  const connect = useCallback(() => {
    const ws = new WebSocket(url)
    wsRef.current = ws
    setConnectionStatus('connecting')

    ws.onopen = () => {
      retryCountRef.current = 0
      setConnectionStatus('connected')
    }

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data)
        onMessageRef.current(parsed)
      } catch {
        // ignore malformed messages
      }
    }

    ws.onclose = () => {
      wsRef.current = null
      const attempt = retryCountRef.current
      if (attempt >= BACKOFF_DELAYS.length) {
        setConnectionStatus('disconnected')
        return
      }
      const delay = BACKOFF_DELAYS[attempt]
      retryCountRef.current += 1
      retryTimeoutRef.current = setTimeout(connect, delay)
    }
  }, [url])

  useEffect(() => {
    connect()
    return () => {
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  return { connectionStatus }
}
```

### web/client/src/hooks/usePipeline.ts

```typescript
import { useState, useCallback } from 'react'
import { useWebSocket } from './useWebSocket'

type PhaseName = 'architect' | 'developer' | 'reviewer' | 'ship'
type PhaseState = 'idle' | 'running' | 'done' | 'error'

export interface PhaseMap {
  architect: PhaseState
  developer: PhaseState
  reviewer: PhaseState
  ship: PhaseState
}

export interface LogLine {
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
  processId: string
}

const INITIAL_PHASES: PhaseMap = {
  architect: 'idle',
  developer: 'idle',
  reviewer: 'idle',
  ship: 'idle',
}

export function usePipeline() {
  const [phases, setPhases] = useState<PhaseMap>(INITIAL_PHASES)
  const [projectName, setProjectName] = useState('')
  const [logLines, setLogLines] = useState<LogLine[]>([])

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type: string } & Record<string, unknown>

    if (msg.type === 'init') {
      setProjectName((msg.projectName as string) ?? '')
      setPhases((msg.phases as PhaseMap) ?? INITIAL_PHASES)
      const buf = (msg.logBuffer as LogLine[]) ?? []
      setLogLines(buf)
    } else if (msg.type === 'phase') {
      setPhases((prev) => ({
        ...prev,
        [msg.phase as PhaseName]: msg.state as PhaseState,
      }))
    } else if (msg.type === 'log') {
      setLogLines((prev) => [
        ...prev,
        {
          source: msg.source as 'stdout' | 'stderr',
          line: msg.line as string,
          timestamp: msg.timestamp as string,
          processId: msg.processId as string,
        },
      ])
    }
  }, [])

  const { connectionStatus } = useWebSocket('ws://localhost:3001', handleMessage)

  return { phases, projectName, logLines, connectionStatus }
}
```

### web/client/src/components/SearchBox.tsx

```tsx
interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
}

export function SearchBox({ value, onChange }: SearchBoxProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px', borderBottom: '1px solid #1e293b' }}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search logs..."
        style={{
          flex: 1,
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 4,
          color: '#e2e8f0',
          padding: '4px 8px',
          fontSize: 13,
        }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          style={{ marginLeft: 6, background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16 }}
        >
          ×
        </button>
      )}
    </div>
  )
}
```

### web/client/src/components/LogStream.tsx

```tsx
import { useEffect, useRef } from 'react'
import type { LogLine } from '../hooks/usePipeline'

interface LogStreamProps {
  lines: LogLine[]
  filterText: string
}

export function LogStream({ lines, filterText }: LogStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)

  const filtered = filterText
    ? lines.filter((l) => l.line.toLowerCase().includes(filterText.toLowerCase()))
    : lines

  useEffect(() => {
    const container = containerRef.current
    if (!container || userScrolledRef.current) return
    container.scrollTop = container.scrollHeight
  }, [filtered.length])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
    userScrolledRef.current = !atBottom
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        fontFamily: 'monospace',
        fontSize: 12,
        padding: '8px',
        backgroundColor: '#0f172a',
      }}
    >
      {filtered.map((line, i) => (
        <div key={`${line.processId}-${i}`} style={{ lineHeight: '1.5', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <span style={{ color: '#475569', marginRight: 8 }}>
            {line.timestamp.slice(11, 19)}
          </span>
          <span style={{ color: line.source === 'stderr' ? '#fb923c' : '#e2e8f0' }}>
            {line.line}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
```

### web/client/src/components/AgentActivity.tsx

```tsx
import { useState } from 'react'
import { LogStream } from './LogStream'
import { SearchBox } from './SearchBox'
import type { LogLine } from '../hooks/usePipeline'

interface AgentActivityProps {
  logLines: LogLine[]
}

export function AgentActivity({ logLines }: AgentActivityProps) {
  const [filterText, setFilterText] = useState('')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <SearchBox value={filterText} onChange={setFilterText} />
      <LogStream lines={logLines} filterText={filterText} />
    </div>
  )
}
```

### web/client/src/components/PipelineSidebar.tsx

```tsx
import type { PhaseMap } from '../hooks/usePipeline'

type PhaseName = 'architect' | 'developer' | 'reviewer' | 'ship'
type PhaseState = 'idle' | 'running' | 'done' | 'error'

const PHASES: { name: PhaseName; label: string }[] = [
  { name: 'architect', label: 'Architect' },
  { name: 'developer', label: 'Developer' },
  { name: 'reviewer', label: 'Reviewer' },
  { name: 'ship', label: 'Ship' },
]

const STATE_COLORS: Record<PhaseState, string> = {
  idle: '#6b7280',
  running: '#eab308',
  done: '#22c55e',
  error: '#ef4444',
}

interface PipelineSidebarProps {
  phases: PhaseMap
}

export function PipelineSidebar({ phases }: PipelineSidebarProps) {
  return (
    <div style={{ padding: '16px 12px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Pipeline
      </div>
      {PHASES.map((phase, idx) => {
        const state = phases[phase.name]
        const color = STATE_COLORS[state]
        const isRunning = state === 'running'
        return (
          <div key={phase.name}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  backgroundColor: color,
                  flexShrink: 0,
                  animation: isRunning ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }}
              />
              <span style={{ fontSize: 13, color: state === 'idle' ? '#64748b' : '#e2e8f0' }}>
                {phase.label}
              </span>
            </div>
            {idx < PHASES.length - 1 && (
              <div style={{ color: '#334155', fontSize: 12, paddingLeft: 3, lineHeight: 1 }}>↓</div>
            )}
          </div>
        )
      })}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}
```

### web/client/src/components/CommandInput.tsx

```tsx
import { useState, KeyboardEvent } from 'react'

export function CommandInput() {
  const [command, setCommand] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleRun() {
    if (!command.trim() || isLoading) return
    setIsLoading(true)
    setErrorMessage(null)

    try {
      const res = await fetch('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      })

      if (res.ok) {
        setCommand('')
      } else {
        const body = await res.json().catch(() => ({}))
        const msg = body.error ?? (res.status === 409 ? 'A process is already running' : 'Failed to start process')
        setErrorMessage(msg)
      }
    } catch {
      setErrorMessage('Failed to connect to server')
    } finally {
      setIsLoading(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleRun()
  }

  return (
    <div style={{ padding: '12px', borderTop: '1px solid #1e293b' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Actions
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter command (e.g., /implement #42)"
          style={{
            flex: 1,
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 4,
            color: '#e2e8f0',
            padding: '6px 8px',
            fontSize: 13,
          }}
        />
        <button
          onClick={handleRun}
          disabled={!command.trim() || isLoading}
          style={{
            background: isLoading || !command.trim() ? '#334155' : '#3b82f6',
            color: '#e2e8f0',
            border: 'none',
            borderRadius: 4,
            padding: '6px 14px',
            fontSize: 13,
            cursor: isLoading || !command.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {isLoading ? 'Running...' : 'Run'}
        </button>
      </div>
      {errorMessage && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{errorMessage}</div>
      )}
    </div>
  )
}
```

### web/client/src/App.tsx

```tsx
import { usePipeline } from './hooks/usePipeline'
import { PipelineSidebar } from './components/PipelineSidebar'
import { AgentActivity } from './components/AgentActivity'
import { CommandInput } from './components/CommandInput'

const GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateAreas: '"header header" "sidebar activity"',
  gridTemplateColumns: '240px 1fr',
  gridTemplateRows: '48px 1fr',
  height: '100vh',
  backgroundColor: '#0f172a',
  color: '#e2e8f0',
  fontFamily: 'system-ui, sans-serif',
  margin: 0,
  overflow: 'hidden',
}

export default function App() {
  const { phases, projectName, logLines, connectionStatus } = usePipeline()

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0f172a; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0f172a; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
      `}</style>
      <div style={GRID_STYLE}>
        {/* Header */}
        <header
          style={{
            gridArea: 'header',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            borderBottom: '1px solid #1e293b',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          <span>specrails manager</span>
          <span style={{ color: '#64748b', fontSize: 12 }}>{projectName}</span>
        </header>

        {/* Left sidebar */}
        <aside
          style={{
            gridArea: 'sidebar',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderRight: '1px solid #1e293b',
            overflow: 'hidden',
          }}
        >
          <PipelineSidebar phases={phases} />
          <CommandInput />
        </aside>

        {/* Main activity panel */}
        <main style={{ gridArea: 'activity', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {connectionStatus === 'disconnected' && (
            <div
              style={{
                background: '#7f1d1d',
                color: '#fca5a5',
                padding: '8px 16px',
                fontSize: 13,
              }}
            >
              Disconnected from server. Check that the web manager is running.
            </div>
          )}
          <AgentActivity logLines={logLines} />
        </main>
      </div>
    </>
  )
}
```

---

## Existing Patterns to Follow

### kebab-case everywhere

File names, directory names: all kebab-case. Exception: React components by convention use PascalCase for the file name. In this codebase, follow the component naming for `.tsx` files and kebab-case for everything else.

### No modifications to existing files

This is 100% additive. The `web/` directory is self-contained. Do not touch `install.sh`, `templates/`, `.claude/`, `openspec/`, or any root-level file.

### TypeScript strict mode

`web/tsconfig.json` sets `"strict": true`. All code must compile under strict mode. Use explicit types where inference is not clear. No `any` except in the WebSocket message handler where the type is narrowed immediately after.

### No test framework yet

The project has no test framework. Task 13 is manual verification. Do not add Jest, Vitest, or any test runner — this is consistent with the project's current state.

---

## Conventions Checklist

Before marking any task complete, verify:

- [ ] TypeScript compiles with `tsc --noEmit` (no errors)
- [ ] No `{{PLACEHOLDER}}` strings anywhere in `web/` (not applicable — no template files here)
- [ ] No modifications to files outside `web/`
- [ ] File names are kebab-case (except `.tsx` component files in PascalCase and standard names like `README.md`, `index.html`)
- [ ] `set -euo pipefail` — not applicable (no shell scripts in this feature)
- [ ] No new shell scripts that lack `set -euo pipefail`
- [ ] `npm install` from `web/` succeeds cleanly

---

## Risks Table

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| `claude` binary name differs per platform | Medium | High | Use `which claude` on Unix, `where claude` on Windows; fail with clear error |
| WebSocket upgrade conflicts with Express routes | Low | High | Use `noServer: true` WS mode + manual upgrade handler (pattern shown above) |
| Hook payload schema differs from assumed format | Medium | Medium | `hooks.ts` returns 200 for all unknown events; dashboard degrades gracefully |
| Large log volume freezes browser | Low | Medium | 5000-line buffer cap on server; DOM renders only filtered subset |
| `tsx watch` not available in target environment | Low | Low | `tsx` is in devDependencies; document Node.js 18+ requirement in README |
| Port 3001 or 5173 already in use | Low | Low | `--port` flag on server; Vite auto-increments port if 5173 is busy |
