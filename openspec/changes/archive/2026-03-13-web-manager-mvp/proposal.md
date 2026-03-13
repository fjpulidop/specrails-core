---
change: web-manager-mvp
type: feature
status: shipped
github_issue: 29
vpc_fit: 65%
---

# Proposal: specrails Web Manager — MVP Pipeline Monitor

## Problem

The specrails pipeline is a powerful multi-agent orchestration system, but it runs entirely in the Claude Code terminal. Observing what is happening requires reading raw terminal output, switching between worktrees, and mentally tracking which pipeline phase is active. This works for a single developer with eyes on the terminal, but it breaks down in two common scenarios:

1. **Unattended runs**: Long pipeline executions (architect → developer → reviewer → ship) run for 10–30 minutes. There is no way to monitor progress without keeping the terminal in view.
2. **Team visibility**: When multiple people collaborate on a project using specrails, there is no shared view of pipeline state. Each person must interpret the terminal logs independently.

The absence of a visual monitor creates friction and erodes trust in the pipeline — it feels like a black box.

## Solution

A locally-run web manager that provides a single-screen "Pipeline Monitor" dashboard. The manager:

1. **Visualizes** the active pipeline phase (Architect → Developer → Reviewer → Ship) with state indicators (idle / running / done / error) so users know at a glance where the pipeline is.
2. **Streams logs** in real-time from the active Claude Code process, with search and filter capability so users can find events without scrolling.
3. **Launches pipeline commands** (like `/implement`, `/opsx:ff`) via a command input that spawns Claude Code processes — no terminal required.
4. **Runs fully unattended** using `--dangerously-skip-permissions` per-spawn so the pipeline executes without manual approval interruptions.

The manager is a local Node.js server (`web/server/`) that serves a React frontend (`web/client/`). Communication between backend and frontend uses WebSocket for real-time log streaming. Claude Code hooks POST lifecycle events to the server, which routes them to the frontend.

## Scope

**In scope (MVP):**
- Node.js + Express + WebSocket backend
- React + TypeScript (Vite) frontend
- 3-zone layout: Pipeline sidebar, Agent Activity log panel, Actions panel
- Real-time log streaming from spawned `claude` processes
- Phase state tracking (idle / running / done / error) derived from hook events
- Command input that spawns `claude` with `--dangerously-skip-permissions`
- Hook event receiver endpoint (POST `/hooks/events`)
- Search/filter in the log stream
- Single-project scope (project name shown in header, configurable via CLI arg)
- Start script: `npm run dev` from `web/`

**Out of scope (explicit MVP exclusions):**
- File diff visualization
- Multi-project switching (architecture must support it, but UI supports one project)
- VPC persona status updates
- Authentication or network exposure (localhost only)
- Persistent log storage (in-memory only for MVP)
- Process lifecycle management (stop/kill spawned processes from UI)
- Dark/light theme toggle

## Non-goals

- This is NOT a replacement for the Claude Code terminal. It is a companion monitor.
- This is NOT a remote deployment. It runs on `localhost` only.
- This is NOT a general-purpose Claude Code GUI. It is scoped to the specrails pipeline.

## Acceptance Criteria

1. `web/` directory exists at the repo root with the specified structure (server + client subdirectories).
2. Running `npm run dev` from `web/` starts the backend on port 3001 and opens the frontend on port 5173.
3. The frontend renders the 3-zone layout: Pipeline sidebar (left), Agent Activity log panel (right), Actions panel (bottom-left).
4. Pipeline phases (Architect, Developer, Reviewer, Ship) render with correct state indicators. Phase state updates in real-time when hook events arrive.
5. Clicking `[Run]` with a command in the input spawns a `claude` process with `--dangerously-skip-permissions`. Process stdout/stderr stream to the Agent Activity panel via WebSocket.
6. The log panel supports search: typing in the search box filters visible log lines in real-time.
7. The project name appears in the header, configurable via a `--project` CLI flag on the server.
8. A hook event POST to `http://localhost:3001/hooks/events` with a JSON payload updates pipeline state and appears in the log panel.
9. The frontend reconnects automatically when the WebSocket connection drops.
10. All TypeScript files compile without errors (`tsc --noEmit`).

## Motivation

VPC fit score: 65%. Alex (Lead Dev, 5/5) rates this highest — unattended pipeline visibility directly addresses his daily frustration. Sara (Product Founder, 3/5) values the visual layer for demos and stakeholder communication. Kai (OSS Maintainer, 2/5) is neutral — the feature adds a new dependency layer (Node.js web stack) that increases maintenance surface for OSS adopters.

The MVP scope deliberately minimizes maintenance surface: no database, no auth, no deployment configuration. The server process is a dev-time companion, not a production service.
