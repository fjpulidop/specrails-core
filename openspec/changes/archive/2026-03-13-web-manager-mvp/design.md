---
change: web-manager-mvp
type: design
---

# Technical Design: specrails Web Manager — MVP Pipeline Monitor

## Architecture Overview

The web manager is a new top-level `web/` directory at the specrails repo root. It is an independent Node.js + React application — it has no build coupling with the rest of specrails (no shared package.json, no import paths crossing the boundary).

```
specrails/
├── web/                        ← new
│   ├── server/                 ← Node.js backend (TypeScript)
│   │   ├── index.ts            ← Express server + WebSocket upgrade
│   │   ├── spawner.ts          ← Claude CLI process manager
│   │   └── hooks.ts            ← Hook event receiver + pipeline state machine
│   ├── client/                 ← React frontend (Vite + TypeScript)
│   │   ├── src/
│   │   │   ├── App.tsx         ← Root layout (3 zones)
│   │   │   ├── components/
│   │   │   │   ├── PipelineSidebar.tsx   ← Phase list with state indicators
│   │   │   │   ├── AgentActivity.tsx     ← Log panel container
│   │   │   │   ├── LogStream.tsx         ← Virtualized log line renderer
│   │   │   │   ├── SearchBox.tsx         ← Filter input
│   │   │   │   └── CommandInput.tsx      ← Command dispatch input + Run button
│   │   │   └── hooks/
│   │   │       ├── useWebSocket.ts       ← WS connection with auto-reconnect
│   │   │       └── usePipeline.ts        ← Pipeline state derived from WS events
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── package.json            ← Workspace root + dev script
│   └── tsconfig.json           ← Root tsconfig (paths for server)
```

### Technology choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Backend runtime | Node.js 18+ | Already available in any dev environment; matches project's existing TypeScript-compatible tooling |
| Backend framework | Express 4 | Minimal boilerplate; well-understood; sufficient for HTTP + WebSocket upgrade |
| WebSocket library | `ws` | De facto standard for Node.js; no opinion on transport format |
| Frontend build | Vite 5 | Fast HMR; TypeScript-first; zero-config for React |
| Frontend framework | React 18 + TypeScript | Specified in issue; component model fits the 3-zone layout |
| Styling | CSS Modules or plain CSS | No CSS framework dependency — minimal surface area |
| Process spawning | Node.js `child_process.spawn` | POSIX-portable; supports streaming stdout/stderr without buffering |

---

## Data Flow

```
User clicks [Run]
     │
     ▼
CommandInput.tsx  ──POST /api/spawn──►  spawner.ts
                                              │
                                        spawn(claude, args)
                                              │
                                    stdout/stderr lines
                                              │
                                     broadcast to all
                                     WS clients as
                                     { type: "log", line, source }
                                              │
                   ◄──────────────────────────┘
              LogStream.tsx appends line

Claude Code process runs
     │
     ▼
Claude Code hook fires
     │
   POST /hooks/events  ──►  hooks.ts
                                 │
                           update pipeline state
                           broadcast { type: "phase", ... }
                                 │
              ◄──────────────────┘
         PipelineSidebar.tsx updates indicators
```

### WebSocket message schema

All messages are JSON. Two top-level types:

```typescript
// Log line from spawned process
{
  type: "log";
  source: "stdout" | "stderr";
  line: string;
  timestamp: string;  // ISO 8601
  processId: string;  // uuid of the spawn
}

// Pipeline phase update from hook event
{
  type: "phase";
  phase: "architect" | "developer" | "reviewer" | "ship";
  state: "idle" | "running" | "done" | "error";
  timestamp: string;
}

// Initial state sync on WS connect
{
  type: "init";
  projectName: string;
  phases: Record<string, PhaseState>;
  logBuffer: LogLine[];  // last N lines in memory
}
```

### Hook event schema (inbound POST /hooks/events)

Claude Code hooks are configured in `.claude/settings.json`. The MVP hook payload follows the Claude Code hook format:

```json
{
  "event": "agent_start" | "agent_stop" | "agent_error",
  "agent": "architect" | "developer" | "reviewer" | "ship",
  "timestamp": "<ISO 8601>"
}
```

The `hooks.ts` module maintains a pipeline state machine in memory. It maps hook events to phase state transitions.

---

## Backend Design

### `web/server/index.ts`

Responsibilities:
- Parse CLI args (`--project <name>`, `--port <n>`, default port 3001)
- Create Express app
- Register routes: `POST /api/spawn`, `POST /hooks/events`, `GET /api/state`
- Upgrade HTTP server to support WebSocket via `ws` library
- Broadcast helper: push message to all connected WS clients
- Serve the Vite build in production (static files from `client/dist/`)

In development, the frontend runs on Vite's own dev server (port 5173). The server runs on port 3001. Vite proxies `/api` and `/hooks` to the backend.

### `web/server/spawner.ts`

Responsibilities:
- `spawnClaude(command: string): SpawnHandle` — spawns `claude --dangerously-skip-permissions <command>`
- Captures stdout and stderr line-by-line using readline
- Emits each line to the broadcast channel as a `log` message
- Assigns a `processId` (uuid) per spawn
- Tracks active spawns (map of processId → ChildProcess)
- On process exit: emits a `log` line with exit code summary

Design constraints:
- One active spawn at a time in MVP (concurrent spawn rejection returns HTTP 409)
- The `claude` binary must be on PATH; if not found, return HTTP 400 with a descriptive error
- `--dangerously-skip-permissions` is always passed — this is not configurable in MVP

```typescript
interface SpawnHandle {
  processId: string;
  command: string;
  startedAt: string;
}
```

### `web/server/hooks.ts`

Responsibilities:
- Express router for `POST /hooks/events`
- In-memory pipeline state: `Map<PhaseName, PhaseState>`
- Initial state: all phases `idle`
- State transition table:

| Hook event | Phase | New state |
|-----------|-------|-----------|
| `agent_start` | `architect` | `running` |
| `agent_stop` (success) | `architect` | `done` |
| `agent_error` | `architect` | `error` |
| `agent_start` | `developer` | `running` |
| ... same pattern for all phases | | |

- After state update: broadcast `{ type: "phase", phase, state, timestamp }` to all WS clients
- `GET /api/state` endpoint returns current pipeline state + project name (for frontend `init` sync)

---

## Frontend Design

### Layout (App.tsx)

Three CSS grid zones:

```
┌──────────────┬──────────────────────────────────────────────┐
│ Header: "specrails manager"           [project name]        │
├──────────────┬──────────────────────────────────────────────┤
│ PIPELINE     │  AGENT ACTIVITY                              │
│              │  [LogStream]                                 │
│ PipelineSide │  [SearchBox]                                 │
│ bar          │                                              │
├──────────────┤                                              │
│ ACTIONS      │                                              │
│ CommandInput │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

Grid layout: `grid-template-columns: 240px 1fr` / `grid-template-rows: 48px 1fr`. The left column is split internally into Pipeline (top) and Actions (bottom) using flexbox with `flex-direction: column`.

### `PipelineSidebar.tsx`

- Renders a vertical list of phases: Architect, Developer, Reviewer, Ship
- Each phase has a state indicator dot: idle (gray), running (yellow pulse), done (green), error (red)
- Phase order is fixed: Architect → Developer → Reviewer → Ship
- Receives `phases` state from `usePipeline` hook

### `AgentActivity.tsx`

- Container for `LogStream` + `SearchBox`
- Passes `filterText` from `SearchBox` down to `LogStream`
- Maintains auto-scroll-to-bottom behavior (disabled when user scrolls up)

### `LogStream.tsx`

- Renders log lines as a scrollable list
- Filters lines by `filterText` (case-insensitive substring match)
- Distinguishes stdout (white) vs stderr (orange/yellow) visually
- `timestamp` shown in dim monospace prefix
- No virtualization in MVP — browser DOM handles up to ~5000 lines without issue

### `SearchBox.tsx`

- Controlled input, calls `onFilter(text)` on change
- Placeholder: "Search logs..."
- Clear button (×) when non-empty

### `CommandInput.tsx`

- Text input: "Enter command (e.g., /implement #42)"
- `[Run]` button — calls `POST /api/spawn` with `{ command }` body
- Disabled while a process is active (server returns 409, button shows loading state)
- On 409: shows "A process is already running" inline message

### `useWebSocket.ts`

- Opens WebSocket to `ws://localhost:3001`
- On `open`: sends `{ type: "ping" }` (server responds with `init` message containing current state + log buffer)
- On `message`: dispatches to registered message handlers
- Auto-reconnect: exponential backoff, max 5 retries, then shows "Disconnected" banner
- Reconnect resets to 1s, 2s, 4s, 8s, 16s

### `usePipeline.ts`

- Subscribes to `phase` messages from `useWebSocket`
- Maintains `phases` state: `Record<PhaseName, PhaseState>`
- Initialized from `init` message on connect
- Exposes `{ phases, projectName }`

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/spawn` | Spawn a claude process. Body: `{ command: string }`. Returns: `{ processId }` or 409 if busy |
| `POST` | `/hooks/events` | Receive a Claude Code hook event. Body: hook payload. Returns: 200 |
| `GET` | `/api/state` | Return current pipeline state + project name. Returns: `{ phases, projectName, logBuffer }` |
| `GET` | `/` | Serve frontend (production) |

WebSocket endpoint: `ws://localhost:3001` (upgrade from HTTP)

---

## Project Structure Details

### `web/package.json` (workspace root)

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

### `web/client/package.json`

```json
{
  "name": "specrails-web-client",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.0",
    "vite": "^5.3.0"
  }
}
```

### `web/client/vite.config.ts`

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

---

## Claude Code Hook Configuration

To receive hook events, `.claude/settings.json` in the TARGET project (not specrails itself) needs hook entries. In MVP, this is a manual setup step documented in the web manager's README.

Hook registration (example for target repo's `.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": [],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3001/hooks/events -H 'Content-Type: application/json' -d '{\"event\":\"notification\",\"message\":\"$CLAUDE_NOTIFICATION_MESSAGE\"}'"
          }
        ]
      }
    ]
  }
}
```

Note: Claude Code hook environment variables and exact payload schema should be verified against the Claude Code documentation before implementation. The MVP hook integration is best-effort; the dashboard remains functional even without hooks (logs still stream from spawned processes).

---

## Design Decisions and Rationale

### Why a separate `web/` directory, not integrated into the repo root

specrails is a Bash + Markdown project. Introducing a Node.js workspace at the repo root would pollute the installer's environment with `node_modules`, `package.json`, and build artifacts. A dedicated `web/` subtree keeps the installer clean and makes the web manager an opt-in add-on.

### Why `--dangerously-skip-permissions` per-spawn, not in global settings

Global `--dangerously-skip-permissions` in `.claude/settings.json` affects all Claude Code sessions, including non-web-manager usage. Per-spawn limits the permission grant to processes the web manager explicitly launches, preserving the security model for all other uses.

### Why in-memory log storage

MVP. A SQLite or file-based log store would require a migration strategy, schema versioning, and disk management. The dashboard is a session monitor, not a log archive. If log persistence is needed, it is a Phase 2 feature.

### Why no authentication

The server binds to `127.0.0.1` (loopback only) by default. LAN exposure is not in scope. Adding auth to a loopback-only dev tool introduces friction with zero security benefit. If network exposure is ever needed, auth is a prerequisite for that feature, not this one.

### Why one active spawn at a time

Pipeline commands are stateful and sequential. Allowing concurrent spawns would produce interleaved log output with no way to associate lines with phases. The 409 rejection is a guardrail, not a limitation to remove later — concurrent execution of pipeline commands is not a valid use case.

### Multi-project readiness

The `projectName` field is on every message. The server stores state in a plain object that could be keyed by project in the future. The frontend's `usePipeline` hook accepts `projectName` from the `init` message. No UI changes are needed to add multi-project switching — only a project selector component and server-side scoping.

---

## Edge Cases

- **`claude` not on PATH**: `POST /api/spawn` returns HTTP 400 with `{ error: "claude binary not found" }`. Frontend renders inline error in `CommandInput`.
- **Server restart mid-pipeline**: All in-memory state is lost. Frontend reconnects, receives an `init` with all phases `idle`, and the log buffer is empty. The user will see the reconnect banner and can re-run the command.
- **Hook event for unknown phase**: `hooks.ts` ignores unknown phase names and logs a warning to server stderr. Pipeline state is not corrupted.
- **WebSocket client connects mid-pipeline**: The `init` message replays the last 500 log lines from the in-memory buffer and the current phase states. The client renders a "connected mid-session" experience.
- **Large log volume**: The in-memory log buffer is capped at 5000 lines. When the cap is reached, the oldest 1000 lines are dropped (sliding window). The `LogStream` component renders only the filtered subset of what the server sends.
- **Empty command input**: Frontend validates non-empty before POSTing. `[Run]` is disabled when the input is empty.

---

## Files Changed Summary

### New Files

| Path | Description |
|------|-------------|
| `web/package.json` | Workspace root with dev/build scripts |
| `web/tsconfig.json` | TypeScript config for server code |
| `web/server/index.ts` | Express + WebSocket server |
| `web/server/spawner.ts` | Claude CLI process spawner |
| `web/server/hooks.ts` | Hook event receiver + pipeline state machine |
| `web/client/package.json` | Vite React frontend dependencies |
| `web/client/tsconfig.json` | TypeScript config for client code |
| `web/client/vite.config.ts` | Vite config with dev proxy |
| `web/client/index.html` | Vite HTML entry |
| `web/client/src/App.tsx` | Root layout component |
| `web/client/src/components/PipelineSidebar.tsx` | Phase indicator list |
| `web/client/src/components/AgentActivity.tsx` | Log panel container |
| `web/client/src/components/LogStream.tsx` | Log line renderer |
| `web/client/src/components/SearchBox.tsx` | Filter input |
| `web/client/src/components/CommandInput.tsx` | Command dispatch |
| `web/client/src/hooks/useWebSocket.ts` | WS client with reconnect |
| `web/client/src/hooks/usePipeline.ts` | Pipeline state hook |
| `web/README.md` | Setup and usage instructions |

### Modified Files

None. The web manager is entirely additive. No existing specrails files are changed.
