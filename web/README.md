# specrails Web Manager

## Overview

The specrails web manager is a locally-run dashboard that monitors and controls the specrails pipeline. It visualizes the four pipeline phases (Architect, Developer, Reviewer, Ship) with live state indicators, streams logs in real-time from spawned `claude` CLI processes, and lets you launch pipeline commands directly from the browser.

## Prerequisites

- Node.js 18 or later
- `claude` CLI on your PATH (the `claude` binary from the Claude Code CLI)

## Setup

```bash
cd web
npm install
```

This installs both the server dependencies (Express, WebSocket) and the client dependencies (React, Vite).

## Start

```bash
npm run dev
```

This starts two processes concurrently:
- **Backend server** on `http://127.0.0.1:3001`
- **Frontend client** on `http://localhost:5173`

Open `http://localhost:5173` in your browser to view the dashboard.

## CLI Options

The server accepts these CLI flags (used with `npm run dev:server` or `tsx server/index.ts`):

| Flag | Default | Description |
|------|---------|-------------|
| `--project <name>` | `specrails` | Project name displayed in the dashboard header |
| `--port <n>` | `3001` | Port the backend server listens on |

Example:

```bash
tsx server/index.ts --project my-app --port 4000
```

## Hook Integration

The web manager accepts Claude Code hook events at `POST /hooks/events`. Configure hooks in the target project's `.claude/settings.json` to POST phase transitions as the pipeline runs.

Example `.claude/settings.json` entry for the target repo:

```json
{
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": []
  }
}
```

To manually fire a hook event (useful for testing):

```bash
# Mark the architect phase as running
curl -X POST http://localhost:3001/hooks/events \
  -H 'Content-Type: application/json' \
  -d '{"event":"agent_start","agent":"architect"}'

# Mark the architect phase as done
curl -X POST http://localhost:3001/hooks/events \
  -H 'Content-Type: application/json' \
  -d '{"event":"agent_stop","agent":"architect"}'

# Mark the developer phase as errored
curl -X POST http://localhost:3001/hooks/events \
  -H 'Content-Type: application/json' \
  -d '{"event":"agent_error","agent":"developer"}'
```

Supported `agent` values: `architect`, `developer`, `reviewer`, `ship`

Supported `event` values: `agent_start`, `agent_stop`, `agent_error`

Unknown agents or events are ignored (the server returns 200 and logs a warning).

## Command Examples

Type these in the Actions input at the bottom of the sidebar and press Enter or click Run:

```
/implement #42
/opsx:ff
/review
```

The dashboard spawns `claude --dangerously-skip-permissions <command>` and streams all output to the log panel.

## MVP Limitations

The following are explicitly out of scope for this MVP:

- **No log persistence** — logs are in-memory only; restarting the server clears all history
- **No authentication** — the server binds to `127.0.0.1` (loopback only); do not expose it to a network
- **No multi-project UI** — one project per server instance; run multiple servers on different ports for multiple projects
- **One active process at a time** — submitting a command while one is running returns a 409 error; wait for the current process to finish
