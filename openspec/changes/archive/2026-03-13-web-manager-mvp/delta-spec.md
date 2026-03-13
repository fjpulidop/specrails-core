---
change: web-manager-mvp
type: delta-spec
---

# Delta Spec: specrails Web Manager — MVP Pipeline Monitor

This document describes the normative specification for the web manager. It defines what the system SHALL do after this change is applied.

---

## 1. New Capability: Web Manager

**Spec statement:** specrails SHALL include a locally-runnable web manager at `web/` that provides a real-time pipeline monitor dashboard.

### 1.1 Runtime requirements

The web manager:
- MUST run on Node.js 18 or later
- MUST start with a single command: `npm run dev` from the `web/` directory
- MUST be entirely optional — the absence of `web/` MUST NOT affect any existing specrails functionality
- MUST bind the backend server to `127.0.0.1` (loopback) by default
- MUST accept a `--project <name>` CLI argument to set the project name displayed in the header
- MUST accept a `--port <n>` CLI argument to override the default backend port (3001)

### 1.2 Backend server

The backend server:
- MUST expose an HTTP server on port 3001 (default)
- MUST upgrade HTTP connections to WebSocket at the root path (`ws://localhost:3001`)
- MUST expose the following HTTP endpoints (see section 5)
- MUST broadcast WebSocket messages to all connected clients when pipeline state changes or a log line is produced
- MUST send an `init` message to each newly connected WebSocket client containing current pipeline state and the last 500 log lines

### 1.3 Frontend

The frontend:
- MUST be served by Vite dev server on port 5173 in development
- MUST render the 3-zone layout described in section 3
- MUST connect to the backend WebSocket on load
- MUST reconnect automatically on WebSocket connection loss, using exponential backoff (1s, 2s, 4s, 8s, 16s), up to 5 retries
- MUST display a "Disconnected" banner when reconnection is exhausted

---

## 2. Process Spawning

**Spec statement:** The web manager SHALL spawn `claude` processes on behalf of the user and stream their output in real-time.

### 2.1 Spawn behavior

When `POST /api/spawn` is called:
- The server MUST verify that `claude` is available on `PATH`. If not found, it MUST return HTTP 400 with `{ "error": "claude binary not found" }`.
- The server MUST spawn the process as: `claude --dangerously-skip-permissions <command>`
- The server MUST capture stdout and stderr line-by-line
- The server MUST broadcast each captured line as a `log` WebSocket message (see section 4.1)
- The server MUST assign a unique `processId` (UUID v4) to each spawn
- The server MUST reject concurrent spawns: if a process is already running, it MUST return HTTP 409 with `{ "error": "A process is already running" }`

### 2.2 Process lifecycle

- When the spawned process exits, the server MUST broadcast a final `log` message indicating the exit code
- The server MUST update its internal "busy" flag to `false` after the process exits, allowing new spawns

### 2.3 In-memory log buffer

- The server MUST maintain an in-memory circular buffer of the last 5000 log lines across all spawns in the current session
- When the buffer exceeds 5000 lines, the oldest 1000 lines MUST be dropped

---

## 3. Dashboard Layout

**Spec statement:** The dashboard SHALL render a 3-zone layout: Pipeline sidebar (left), Agent Activity panel (right), Actions panel (bottom-left).

### 3.1 Header zone

- MUST display the text "specrails manager"
- MUST display the project name in the top-right (from server `init` message or `--project` arg)

### 3.2 Pipeline sidebar

- MUST display the four pipeline phases in order: Architect, Developer, Reviewer, Ship
- Each phase MUST display a state indicator reflecting one of four states:
  - `idle`: gray indicator, no animation
  - `running`: yellow indicator, pulsing animation
  - `done`: green indicator, static
  - `error`: red indicator, static
- Phase state MUST update in real-time when `phase` WebSocket messages arrive
- All phases MUST initialize to `idle` on connect (unless `init` message contains non-idle states)

### 3.3 Agent Activity panel

- MUST display the log stream of all captured process output
- MUST render `stdout` lines and `stderr` lines with visual distinction (color or label)
- MUST prepend each line with a dimmed monospace timestamp
- MUST support search/filter: a text input MUST filter visible log lines by case-insensitive substring match in real-time
- MUST auto-scroll to the bottom as new lines arrive
- MUST pause auto-scroll when the user scrolls up manually
- MUST resume auto-scroll when the user scrolls back to the bottom

### 3.4 Actions panel

- MUST contain a text input for entering pipeline commands (e.g., `/implement #42`)
- MUST contain a `[Run]` button that dispatches the command via `POST /api/spawn`
- The `[Run]` button MUST be disabled when the input is empty
- The `[Run]` button MUST show a loading/disabled state while a process is active
- When a spawn is rejected (HTTP 409), the panel MUST display the message "A process is already running"
- When the `claude` binary is not found (HTTP 400), the panel MUST display the error inline

---

## 4. WebSocket Message Protocol

**Spec statement:** The WebSocket protocol SHALL use JSON messages with a `type` discriminator field.

### 4.1 Log message

```
{
  type: "log",
  source: "stdout" | "stderr",
  line: string,
  timestamp: string,   // ISO 8601
  processId: string    // UUID v4
}
```

### 4.2 Phase update message

```
{
  type: "phase",
  phase: "architect" | "developer" | "reviewer" | "ship",
  state: "idle" | "running" | "done" | "error",
  timestamp: string    // ISO 8601
}
```

### 4.3 Init message

Sent once per WebSocket connection, immediately after open:

```
{
  type: "init",
  projectName: string,
  phases: {
    architect: PhaseState,
    developer: PhaseState,
    reviewer: PhaseState,
    ship: PhaseState
  },
  logBuffer: LogMessage[]   // last min(500, buffer.length) log messages
}
```

### 4.4 Message ordering

- The server MUST send the `init` message before any other messages on a new connection
- Log messages MUST be broadcast in the order they are received from the spawned process
- Phase messages MUST be broadcast immediately upon receiving a hook event

---

## 5. HTTP API

**Spec statement:** The backend SHALL expose the following HTTP endpoints.

### 5.1 POST /api/spawn

- Request body: `{ "command": string }`
- Success (200): `{ "processId": string }`
- Busy (409): `{ "error": "A process is already running" }`
- Bad request (400): `{ "error": "claude binary not found" }` or `{ "error": "command is required" }`

### 5.2 POST /hooks/events

- Request body: Claude Code hook payload (see section 6)
- Success (200): `{ "ok": true }`
- The endpoint MUST NOT return errors for unrecognized event types — it MUST return 200 and ignore the event

### 5.3 GET /api/state

- No request body
- Success (200): `{ "projectName": string, "phases": PhasesObject, "busy": boolean }`

---

## 6. Hook Event Handling

**Spec statement:** The server SHALL accept Claude Code hook events via POST /hooks/events and translate them into pipeline phase state transitions.

### 6.1 Supported hook events

| `event` value | `agent` value | Phase state transition |
|---------------|---------------|------------------------|
| `agent_start` | `architect` | architect → `running` |
| `agent_stop` | `architect` | architect → `done` |
| `agent_error` | `architect` | architect → `error` |
| `agent_start` | `developer` | developer → `running` |
| `agent_stop` | `developer` | developer → `done` |
| `agent_error` | `developer` | developer → `error` |
| `agent_start` | `reviewer` | reviewer → `running` |
| `agent_stop` | `reviewer` | reviewer → `done` |
| `agent_error` | `reviewer` | reviewer → `error` |
| `agent_start` | `ship` | ship → `running` |
| `agent_stop` | `ship` | ship → `done` |
| `agent_error` | `ship` | ship → `error` |

### 6.2 Unknown events

- Events with unrecognized `event` or `agent` values MUST be ignored (no state change, no error)
- The server MUST log a warning to its own stderr for unrecognized events

### 6.3 Pipeline reset

- A new spawn (POST /api/spawn) MUST reset all phase states to `idle`
- The reset MUST be broadcast as four `phase` messages before the first `log` message

---

## 7. Development Workflow

**Spec statement:** The web manager SHALL support a standard development workflow without manual build steps.

### 7.1 Development mode

- `npm run dev` from `web/` MUST start both the backend (tsx watch) and frontend (Vite) concurrently
- The Vite dev server MUST proxy `/api/*` and `/hooks/*` requests to `http://localhost:3001`
- Hot module replacement MUST work for all frontend components

### 7.2 TypeScript

- All TypeScript files MUST compile without errors when running `tsc --noEmit`
- Shared types (WebSocket message shapes, phase state enum) SHOULD be defined in `web/server/types.ts` and referenced from both server and client
- The client MUST NOT import from the server directly — shared types are duplicated or copied

### 7.3 No existing file modifications

- This change MUST NOT modify any file outside of `web/`
- The `web/` directory MUST be self-contained
