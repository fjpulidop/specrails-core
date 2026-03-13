---
change: web-manager-mvp
type: tasks
---

# Tasks: specrails Web Manager — MVP Pipeline Monitor

Tasks are ordered by dependency. Each task has a layer tag, description, files involved, and acceptance criteria.

Layer tags:
- `[core]` — server-side Node.js code, shared types
- `[templates]` — React frontend components
- `[cli]` — project scaffolding, config files, scripts

---

## Task 1 — Scaffold the web/ directory structure [cli]

**Description:** Create the directory skeleton and all configuration files (package.json, tsconfig.json, vite.config.ts, index.html). This is the foundation that all subsequent tasks build on. Do NOT write any application logic — only configuration and empty entry points.

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/client/package.json`
- Create: `web/client/tsconfig.json`
- Create: `web/client/vite.config.ts`
- Create: `web/client/index.html`
- Create: `web/client/src/main.tsx` (minimal — renders `<App />` only)
- Create: `web/server/types.ts` (shared type definitions — see below)

**web/package.json content:**
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

**web/client/vite.config.ts content:**
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
    }
  }
})
```

**web/server/types.ts** must define:
- `PhaseName` union type: `"architect" | "developer" | "reviewer" | "ship"`
- `PhaseState` union type: `"idle" | "running" | "done" | "error"`
- `LogMessage` interface: `{ type: "log"; source: "stdout" | "stderr"; line: string; timestamp: string; processId: string }`
- `PhaseMessage` interface: `{ type: "phase"; phase: PhaseName; state: PhaseState; timestamp: string }`
- `InitMessage` interface: `{ type: "init"; projectName: string; phases: Record<PhaseName, PhaseState>; logBuffer: LogMessage[] }`
- `WsMessage` union: `LogMessage | PhaseMessage | InitMessage`
- `SpawnHandle` interface: `{ processId: string; command: string; startedAt: string }`

**Acceptance criteria:**
- All listed files exist
- `web/package.json` has `dev`, `dev:server`, `dev:client`, `build`, `typecheck` scripts
- `web/client/vite.config.ts` proxies `/api` and `/hooks` to `http://localhost:3001`
- `web/server/types.ts` exports all types listed above with no compilation errors
- `web/client/src/main.tsx` renders `<App />` (App can be a stub returning `<div>specrails manager</div>`)
- `npm install` from `web/` completes without errors

**Dependencies:** None (start here)

---

## Task 2 — Implement the pipeline state machine (hooks.ts) [core]

**Description:** Implement `web/server/hooks.ts`. This module owns all pipeline state — it is the single source of truth for phase states. It exposes an Express router for `POST /hooks/events` and a state accessor used by `index.ts` for the `GET /api/state` endpoint and the `init` message.

**Files:**
- Create: `web/server/hooks.ts`

**Implementation requirements:**

1. Export a `createHooksRouter(broadcast: (msg: WsMessage) => void)` function that returns an Express Router.

2. Internal state:
   ```typescript
   const phases: Record<PhaseName, PhaseState> = {
     architect: 'idle',
     developer: 'idle',
     reviewer: 'idle',
     ship: 'idle',
   }
   ```

3. `POST /hooks/events` handler:
   - Parse `{ event, agent }` from request body
   - Validate `agent` is a known `PhaseName`; if not, log a warning to `console.warn` and return 200
   - Apply state transition (see delta-spec section 6.1)
   - Call `broadcast({ type: 'phase', phase: agent, state: newState, timestamp: new Date().toISOString() })`
   - Return `{ ok: true }`

4. Export `getPhaseStates(): Record<PhaseName, PhaseState>` — returns a shallow copy of current state

5. Export `resetPhases(broadcast: (msg: WsMessage) => void): void` — resets all phases to `idle` and broadcasts four `phase` messages

State transition logic:
```
event='agent_start'  → state = 'running'
event='agent_stop'   → state = 'done'
event='agent_error'  → state = 'error'
```

**Acceptance criteria:**
- `POST /hooks/events` with `{ event: 'agent_start', agent: 'architect' }` causes `architect` phase state to become `running` and broadcasts a `phase` message
- `POST /hooks/events` with unknown `agent` value returns 200 and does not throw
- `getPhaseStates()` returns current state
- `resetPhases()` sets all phases to `idle` and broadcasts 4 messages
- TypeScript compiles without errors

**Dependencies:** Task 1 (types.ts must exist)

---

## Task 3 — Implement the Claude process spawner (spawner.ts) [core]

**Description:** Implement `web/server/spawner.ts`. This module manages spawning `claude` CLI processes, streaming their output as WebSocket messages, and enforcing the single-active-spawn constraint.

**Files:**
- Create: `web/server/spawner.ts`

**Implementation requirements:**

1. Import: `child_process.spawn`, `readline`, `which` (use `child_process.execSync('which claude')` to detect), `uuid`

2. Module-level state:
   ```typescript
   let activeProcess: ChildProcess | null = null
   let activePid: string | null = null
   ```

3. Export `isSpawnActive(): boolean` — returns `activeProcess !== null`

4. Export `spawnClaude(command: string, broadcast: (msg: WsMessage) => void, resetPhases: () => void): SpawnHandle | null`:
   - Check if `claude` is on PATH using `which claude` (execSync, catch error → return null with a specific error code)
   - If a process is already active, throw `Error('SPAWN_BUSY')`
   - Call `resetPhases()` to reset phase states before spawning
   - Generate `processId = uuidv4()`
   - `spawn('claude', ['--dangerously-skip-permissions', ...command.split(' ')], { env: process.env })`
   - Attach `readline` interfaces to stdout and stderr
   - For each line: `broadcast({ type: 'log', source: 'stdout'|'stderr', line, timestamp, processId })`
   - Also push each line to the shared log buffer (passed as a parameter or via a module-level buffer accessor)
   - On `close` event: `broadcast` a log line `[process exited with code ${code}]`, set `activeProcess = null`
   - Return `SpawnHandle`

5. Export `getLogBuffer(): LogMessage[]` — returns a copy of the circular buffer (last 5000 lines, drops oldest 1000 when full)

**Error handling:**
- `claude` not on PATH: export `ClaudeNotFoundError` class extending `Error`
- Spawn busy: export `SpawnBusyError` class extending `Error`

**Acceptance criteria:**
- `spawnClaude` with a valid command starts a child process and broadcasts log lines
- `isSpawnActive()` returns `true` while a process runs, `false` after exit
- `spawnClaude` throws `SpawnBusyError` if called while active
- `spawnClaude` throws `ClaudeNotFoundError` if `claude` is not on PATH
- `getLogBuffer()` returns the last 5000 lines, capped
- TypeScript compiles without errors

**Dependencies:** Task 1 (types.ts)

---

## Task 4 — Implement the Express + WebSocket server (index.ts) [core]

**Description:** Implement `web/server/index.ts`. This is the entry point that wires together Express routes, WebSocket upgrades, and the hooks/spawner modules.

**Files:**
- Create: `web/server/index.ts`

**Implementation requirements:**

1. Parse CLI args using `process.argv`:
   - `--project <name>` → `projectName` (default: `"specrails"`)
   - `--port <n>` → `port` (default: `3001`)

2. Create Express app. Register middleware: `express.json()`.

3. Create `http.Server` from the Express app (needed for WS upgrade).

4. Create `WebSocketServer({ noServer: true })` from `ws`.

5. On `server.on('upgrade', ...)`: call `wss.handleUpgrade(...)`.

6. On `wss.on('connection', ws)`:
   - Send `init` message: `{ type: 'init', projectName, phases: getPhaseStates(), logBuffer: getLogBuffer().slice(-500) }`
   - Add `ws` to a `clients: Set<WebSocket>` set
   - On `ws.on('close')`: remove from set

7. `broadcast(msg: WsMessage)`: iterate `clients`, send JSON to each open client

8. Register routes:
   - `app.use('/hooks', createHooksRouter(broadcast))`
   - `POST /api/spawn`: validate body, call `spawnClaude(command, broadcast, () => resetPhases(broadcast))`. Handle `ClaudeNotFoundError` → 400, `SpawnBusyError` → 409
   - `GET /api/state`: return `{ projectName, phases: getPhaseStates(), busy: isSpawnActive() }`

9. `server.listen(port, '127.0.0.1', ...)`: log `Server running on http://127.0.0.1:${port}` to stdout

**Acceptance criteria:**
- Server starts on port 3001 by default
- `--project "my-project"` sets project name in `init` messages
- A new WebSocket client receives an `init` message immediately on connect
- `POST /api/spawn` with `{ command: "/implement #42" }` returns `{ processId: "<uuid>" }` or error
- `GET /api/state` returns current state
- TypeScript compiles without errors

**Dependencies:** Tasks 2, 3

---

## Task 5 — Implement useWebSocket hook [templates]

**Description:** Implement `web/client/src/hooks/useWebSocket.ts`. This hook manages the WebSocket connection lifecycle including auto-reconnect.

**Files:**
- Create: `web/client/src/hooks/useWebSocket.ts`

**Implementation requirements:**

1. `useWebSocket(url: string, onMessage: (msg: WsMessage) => void)` hook

2. Internal state: `connectionStatus: 'connecting' | 'connected' | 'disconnected'`

3. On mount: open WebSocket to `url`

4. On `message` event: parse JSON, call `onMessage`

5. On `close` event: attempt reconnect with exponential backoff: 1000ms, 2000ms, 4000ms, 8000ms, 16000ms. After 5 failed attempts, set status to `'disconnected'` and stop retrying.

6. On `open` event: reset retry counter, set status to `'connected'`

7. On unmount: close WebSocket, cancel pending reconnect timeout

8. Return `{ connectionStatus }`

**Note on types:** Define a client-side copy of `WsMessage` (duplicate of server types — do NOT import from server). Keep it simple: use `any` for the message body in the hook itself; `usePipeline` will narrow the type.

**Acceptance criteria:**
- Hook connects to WebSocket on mount
- Hook attempts reconnect on disconnect, up to 5 times with backoff
- `connectionStatus` reflects actual connection state
- Hook cleans up on unmount (no memory leaks)
- TypeScript compiles without errors

**Dependencies:** Task 1 (structure must exist)

---

## Task 6 — Implement usePipeline hook [templates]

**Description:** Implement `web/client/src/hooks/usePipeline.ts`. This hook derives pipeline state from WebSocket messages.

**Files:**
- Create: `web/client/src/hooks/usePipeline.ts`

**Client-side type definitions (local to client):**
```typescript
type PhaseName = 'architect' | 'developer' | 'reviewer' | 'ship'
type PhaseState = 'idle' | 'running' | 'done' | 'error'

interface PhaseMap {
  architect: PhaseState
  developer: PhaseState
  reviewer: PhaseState
  ship: PhaseState
}
```

**Implementation requirements:**

1. `usePipeline()` hook

2. Internal state:
   - `phases: PhaseMap` — all `idle` initially
   - `projectName: string` — `""` initially
   - `logLines: LogLine[]` — `[]` initially (where `LogLine = { source, line, timestamp, processId }`)

3. Use `useWebSocket` passing a message handler:
   - On `type === 'init'`: set `phases`, `projectName`, append `logBuffer` to `logLines`
   - On `type === 'phase'`: update the specific phase in `phases`
   - On `type === 'log'`: append to `logLines`

4. Return `{ phases, projectName, logLines, connectionStatus }`

**Acceptance criteria:**
- `phases` updates when `phase` messages arrive
- `logLines` grows as `log` messages arrive
- `projectName` is set from `init` message
- `connectionStatus` from `useWebSocket` is forwarded
- TypeScript compiles without errors

**Dependencies:** Task 5

---

## Task 7 — Implement LogStream and SearchBox components [templates]

**Description:** Implement `web/client/src/components/LogStream.tsx` and `web/client/src/components/SearchBox.tsx`. These two are tightly coupled (SearchBox filters LogStream) and are implemented together.

**Files:**
- Create: `web/client/src/components/LogStream.tsx`
- Create: `web/client/src/components/SearchBox.tsx`

**LogStream.tsx requirements:**
1. Props: `lines: LogLine[]`, `filterText: string`
2. Filter `lines` by `filterText` (case-insensitive `line.toLowerCase().includes(filterText.toLowerCase())`)
3. Render filtered lines in a scrollable container (`overflow-y: auto`, fixed height)
4. Each line: `<span class="timestamp">{timestamp}</span> <span class={source}>{line}</span>`
5. `stdout` lines: white text. `stderr` lines: `#ff9800` (orange) text
6. Auto-scroll to bottom when new lines arrive (via `useEffect` + `ref.current.scrollTop = ref.current.scrollHeight`)
7. Pause auto-scroll when `scrollTop + clientHeight < scrollHeight - 20` (user scrolled up)
8. Resume auto-scroll when user scrolls to within 20px of bottom

**SearchBox.tsx requirements:**
1. Props: `value: string`, `onChange: (value: string) => void`
2. Controlled input with placeholder "Search logs..."
3. Show a clear button (×) when `value` is non-empty, clicking it calls `onChange('')`
4. No extra dependencies

**Acceptance criteria:**
- `LogStream` renders only lines containing `filterText`
- `LogStream` auto-scrolls to bottom as lines are added
- Auto-scroll pauses when user scrolls up
- `stderr` lines render in a distinct color from `stdout` lines
- `SearchBox` calls `onChange` on every keystroke
- Clear button appears only when value is non-empty
- TypeScript compiles without errors

**Dependencies:** Task 6 (LogLine type defined in usePipeline)

---

## Task 8 — Implement PipelineSidebar component [templates]

**Description:** Implement `web/client/src/components/PipelineSidebar.tsx`. Renders the phase list with animated state indicators.

**Files:**
- Create: `web/client/src/components/PipelineSidebar.tsx`

**Implementation requirements:**
1. Props: `phases: PhaseMap`
2. Render four items in order: Architect, Developer, Reviewer, Ship
3. Between each phase, render a `↓` connector arrow
4. Each item: a colored dot + phase label
5. Dot colors:
   - `idle`: `#6b7280` (gray)
   - `running`: `#eab308` (yellow) with CSS `@keyframes pulse` animation
   - `done`: `#22c55e` (green)
   - `error`: `#ef4444` (red)
6. CSS can be inline styles or a CSS module (`PipelineSidebar.module.css`)

**Acceptance criteria:**
- All four phases render in correct order
- Dot color reflects phase state
- `running` state shows a pulsing animation
- Component renders without errors when all phases are `idle`
- TypeScript compiles without errors

**Dependencies:** Task 6 (PhaseMap type)

---

## Task 9 — Implement CommandInput component [templates]

**Description:** Implement `web/client/src/components/CommandInput.tsx`. Handles command entry and dispatching to the backend.

**Files:**
- Create: `web/client/src/components/CommandInput.tsx`

**Implementation requirements:**
1. Local state: `command: string`, `isLoading: boolean`, `errorMessage: string | null`
2. Text input: placeholder `"Enter command (e.g., /implement #42)"`, controlled by `command`
3. `[Run]` button:
   - Disabled when `command.trim() === ''` or `isLoading === true`
   - Shows "Running..." text when `isLoading`
4. On submit:
   - Set `isLoading = true`, `errorMessage = null`
   - `fetch('/api/spawn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) })`
   - On 200: set `isLoading = false`, clear `command`
   - On 409: set `isLoading = false`, `errorMessage = 'A process is already running'`
   - On 400 (claude not found): set `isLoading = false`, parse response JSON, set `errorMessage = response.error`
   - On other error: set `isLoading = false`, `errorMessage = 'Failed to start process'`
5. Render `errorMessage` below the input when non-null (red text)
6. Allow Enter key press to trigger submit (same as clicking Run)

**Acceptance criteria:**
- `[Run]` is disabled when input is empty
- `[Run]` shows loading state after click until server responds
- 409 response renders "A process is already running"
- 400 response renders the server error message
- Enter key submits the command
- TypeScript compiles without errors

**Dependencies:** Task 1 (server must be running for manual test, but component can compile without it)

---

## Task 10 — Implement AgentActivity component [templates]

**Description:** Implement `web/client/src/components/AgentActivity.tsx`. Container component that composes LogStream and SearchBox.

**Files:**
- Create: `web/client/src/components/AgentActivity.tsx`

**Implementation requirements:**
1. Props: `logLines: LogLine[]`
2. Local state: `filterText: string` (initially `""`)
3. Render `<SearchBox value={filterText} onChange={setFilterText} />`
4. Render `<LogStream lines={logLines} filterText={filterText} />`
5. Layout: SearchBox at top, LogStream fills remaining height (`flex-direction: column`, `flex: 1` on LogStream)

**Acceptance criteria:**
- Typing in the SearchBox filters LogStream in real-time
- LogStream fills available height
- TypeScript compiles without errors

**Dependencies:** Tasks 7

---

## Task 11 — Implement root App.tsx layout [templates]

**Description:** Implement `web/client/src/App.tsx` as the root layout component wiring all components and hooks together.

**Files:**
- Modify: `web/client/src/App.tsx` (replace stub from Task 1)

**Implementation requirements:**
1. Call `usePipeline()` to get `{ phases, projectName, logLines, connectionStatus }`
2. Layout structure (CSS grid):
   ```
   grid-template-areas:
     "header header"
     "sidebar activity"
   grid-template-columns: 240px 1fr
   grid-template-rows: 48px 1fr
   height: 100vh
   ```
3. Header: `<header>specrails manager <span>{projectName}</span></header>`
4. Left column: `<aside>` containing `<PipelineSidebar phases={phases} />` (top) and `<CommandInput />` (bottom), using `flex-direction: column`
5. Right column: `<main>` containing `<AgentActivity logLines={logLines} />`
6. When `connectionStatus === 'disconnected'`: render a banner at top: "Disconnected from server. Check that the web manager is running."
7. Apply minimal CSS reset: `margin: 0`, `box-sizing: border-box`, monospace font for log content, dark background `#0f172a`, light foreground `#e2e8f0`

**Acceptance criteria:**
- Layout renders all 3 zones at correct proportions
- Project name appears in header (from `usePipeline`)
- Disconnected banner renders when `connectionStatus === 'disconnected'`
- No console errors on initial render
- TypeScript compiles without errors

**Dependencies:** Tasks 6, 8, 9, 10

---

## Task 12 — Write web/README.md [cli]

**Description:** Write `web/README.md` with setup and usage instructions for the web manager.

**Files:**
- Create: `web/README.md`

**Required sections:**
1. **Overview** — one paragraph: what the web manager does
2. **Prerequisites** — Node.js 18+, `claude` CLI on PATH
3. **Setup** — `cd web && npm install`
4. **Start** — `npm run dev` → backend on port 3001, frontend on port 5173
5. **CLI options** — `--project <name>` and `--port <n>` for the server
6. **Hook integration** — how to configure `.claude/settings.json` in the target project to POST events to `http://localhost:3001/hooks/events`. Include an example hook command using `curl`.
7. **Command examples** — example commands to type in the dashboard: `/implement #42`, `/opsx:ff`
8. **MVP limitations** — explicitly list what is out of scope: no persistence, no auth, no multi-project UI, one active process at a time

**Acceptance criteria:**
- All 8 sections are present
- Hook integration section includes a working `curl` command example
- Prerequisites and setup steps are accurate
- File follows kebab-case (filename is `README.md` — standard exception)

**Dependencies:** None (can be written any time after the design is stable)

---

## Task 13 — End-to-end verification [cli]

**Description:** Verify the complete system works together. This is a manual verification task performed after Tasks 1–12 are complete.

**Files:** Read-only verification

**Steps:**
1. `cd web && npm install` — no errors
2. `npm run typecheck` — TypeScript compiles without errors for both server and client
3. `npm run dev` — both server (port 3001) and client (port 5173) start
4. Open `http://localhost:5173` — dashboard renders with 3 zones, all phases show `idle`
5. POST a hook event: `curl -X POST http://localhost:3001/hooks/events -H 'Content-Type: application/json' -d '{"event":"agent_start","agent":"architect"}'` — Architect phase indicator turns yellow/running in the dashboard
6. POST stop event: `curl -X POST http://localhost:3001/hooks/events -H 'Content-Type: application/json' -d '{"event":"agent_stop","agent":"architect"}'` — Architect phase turns green/done
7. Type `echo hello` in the command input (if `claude` is not available, use a test command and verify error handling), click Run — log lines stream to the Agent Activity panel
8. Type in the search box — log lines filter correctly
9. Disconnect the server (Ctrl+C), observe the disconnected banner, restart the server, observe reconnect

**Acceptance criteria:**
- All 9 steps produce the expected result
- No TypeScript errors
- No unhandled promise rejections in browser console

**Dependencies:** Tasks 1–12

---

## Execution Order

```
Task 1 (scaffold)
  ├── Task 2 (hooks.ts)   ──┐
  ├── Task 3 (spawner.ts) ──┤
  │                         └── Task 4 (index.ts)
  ├── Task 5 (useWebSocket)
  │     └── Task 6 (usePipeline)
  │           ├── Task 7 (LogStream + SearchBox)
  │           │     └── Task 10 (AgentActivity)
  │           ├── Task 8 (PipelineSidebar)
  │           └── Task 9 (CommandInput) ─ independent, can run in parallel
  │                 └─────────────────────── Task 11 (App.tsx) ←── Tasks 8, 9, 10
  └── Task 12 (README) — independent
                              └── Task 13 (verification) ← all tasks
```

### Minimum critical path

Task 1 → Task 2 + Task 3 (parallel) → Task 4 (server complete)
Task 1 → Task 5 → Task 6 → Task 7 → Task 10 → Task 11 (frontend complete)
Task 11 + Task 4 → Task 13 (verification)

Tasks 8, 9, and 12 can run in parallel with the critical path after their dependencies are met.
