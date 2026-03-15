# specrails Web Manager

## Overview

The specrails web manager is a locally-run dashboard that monitors and controls the specrails pipeline. It visualizes the four pipeline phases (Architect, Developer, Reviewer, Ship) with live state indicators, streams logs in real-time from spawned `claude` CLI processes, and lets you launch pipeline commands directly from the browser.

## Prerequisites

- Node.js 18 or later
- `claude` CLI on your PATH (the `claude` binary from the Claude Code CLI)

## Setup

```bash
cd .claude/web-manager
npm install
```

This installs both the server dependencies (Express, WebSocket) and the client dependencies (React, Vite).

## Start

**Always start from your project root**, not from inside the web-manager directory. This ensures the project name is detected correctly:

```bash
cd .claude/web-manager && npm run dev
```

Or specify the project name explicitly:

```bash
cd .claude/web-manager && SPECRAILS_PROJECT_NAME=my-project npm run dev
```

This starts two processes concurrently:
- **Backend server** on `http://127.0.0.1:4200`
- **Frontend client** on `http://localhost:4201`

Open `http://localhost:4201` in your browser to view the dashboard.

## CLI Options

The server accepts these CLI flags (used with `npm run dev:server` or `tsx server/index.ts`):

| Flag | Default | Description |
|------|---------|-------------|
| `--project <name>` | basename of `cwd` | Project name displayed in the dashboard header |
| `--port <n>` | `4200` | Port the backend server listens on |

Example:

```bash
tsx server/index.ts --project my-app --port 4000
```

You can also set the project name via environment variable: `SPECRAILS_PROJECT_NAME=my-app npm run dev`

## How It Connects to the Pipeline

The `/sr:implement` pipeline automatically detects whether the web manager is running and sends phase transition notifications. **No manual hook configuration is required.**

When you run `/sr:implement`, the orchestrator:
1. Checks if `http://127.0.0.1:4200` is reachable (Phase -1 pre-flight)
2. If yes, sends `POST /hooks/events` notifications at each phase transition:
   - Architect starts/completes
   - Developer starts/completes
   - Reviewer starts/completes
   - Ship starts/completes
3. If not reachable, the pipeline runs normally without notifications

All notifications are fire-and-forget — a failed notification never blocks the pipeline.

## Manual Hook Testing

To manually fire a hook event (useful for testing the dashboard):

```bash
# Mark the architect phase as running
curl -sf -X POST http://127.0.0.1:4200/hooks/events \
  -H 'Content-Type: application/json' \
  -d '{"event":"agent_start","agent":"architect"}'

# Mark the architect phase as done
curl -sf -X POST http://127.0.0.1:4200/hooks/events \
  -H 'Content-Type: application/json' \
  -d '{"event":"agent_stop","agent":"architect"}'

# Mark the developer phase as errored
curl -sf -X POST http://127.0.0.1:4200/hooks/events \
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
