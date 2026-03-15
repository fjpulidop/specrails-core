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

## Using srm

`srm` is a CLI bridge that routes specrails commands either through the web-manager (when running) or directly to `claude` (as fallback).

### Installation

For local development (from the web-manager directory):

```bash
npm install
npm link
```

For global install from an npm registry:

```bash
npm install -g specrails-web-manager
```

After installation, `srm` is available on your PATH.

### Commands

| Invocation | Behaviour |
|---|---|
| `srm implement #42` | Runs `/sr:implement #42` (known verb → auto-prefixed with `/sr:`) |
| `srm batch-implement #40 #41` | Runs `/sr:batch-implement #40 #41` |
| `srm "any raw prompt"` | Passes raw prompt directly to claude (no prefix) |
| `srm --status` | Prints web-manager state; exits 0 if running, 1 if not |
| `srm --jobs` | Prints recent job history table; requires web-manager with SQLite persistence |
| `srm --port <n>` | Overrides default port (4200) for all HTTP/WS calls |
| `srm --help` | Prints usage and exits 0 |

Known verbs: `implement`, `batch-implement`, `why`, `product-backlog`, `update-product-driven-backlog`, `refactor-recommender`, `health-check`, `compat-check`

### Execution paths

**Web-manager running** (detected via a 500ms probe to `GET /api/state`):
1. `POST /api/spawn` submits the command to the web-manager
2. WebSocket streams live log output to your terminal
3. Exit is detected from the `[process exited with code N]` log line
4. Summary line printed with duration, cost, and tokens (when available)

**Web-manager not running** (fallback):
1. `claude --dangerously-skip-permissions -p <command> --output-format stream-json --verbose` is invoked directly
2. `text` lines are printed to stdout; ANSI codes from claude are passed through unchanged
3. Summary line printed from the `result` object in the stream

### Output format

All `srm`-generated lines are prefixed with `[srm]` in dim text.

```
[srm] running: /sr:implement #42
[srm] routing via web-manager at http://127.0.0.1:4200
... (live claude output) ...
[srm] done  duration: 4m32s  cost: $0.08  tokens: 12 400  exit: 0
```

### Notes

- `--jobs` requires the web-manager to have SQLite persistence (#57). Without it, a clear message is shown.
- When stdout is not a TTY (e.g. piped), ANSI codes in `[srm]` annotations are suppressed. Claude output ANSI is always passed through.
- `srm` exits with the same code as the claude process.

---

## MVP Limitations

The following are explicitly out of scope for this MVP:

- **No log persistence** — logs are in-memory only; restarting the server clears all history
- **No authentication** — the server binds to `127.0.0.1` (loopback only); do not expose it to a network
- **No multi-project UI** — one project per server instance; run multiple servers on different ports for multiple projects
- **One active process at a time** — submitting a command while one is running returns a 409 error; wait for the current process to finish
