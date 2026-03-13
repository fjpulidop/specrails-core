---
name: project_web_manager_pattern
description: Design patterns for the web-manager-mvp feature — Node.js/React companion app, WebSocket protocol, hook integration, and architectural boundaries
type: project
---

# Web Manager MVP — Design Patterns

## Core architectural decision

The web manager lives in `web/` at repo root — a fully self-contained Node.js + React workspace with its own `package.json`. It does NOT share a root-level `package.json` with the rest of specrails (which has none). This keeps the Bash + Markdown installer clean.

**Why:** Adding Node.js deps at repo root would pollute the installer environment and create confusion about what `npm install` means in this project.

## WebSocket message protocol

Three message types with a `type` discriminator:
- `init` — sent once per WS connection with current state + last 500 log lines
- `log` — streamed line from spawned process (`source: "stdout" | "stderr"`)
- `phase` — pipeline phase state change (`state: "idle" | "running" | "done" | "error"`)

Shared types live in `web/server/types.ts`. The client duplicates the types locally — it does NOT import from the server.

## Hook integration

Claude Code hooks POST to `http://localhost:3001/hooks/events`. Payload: `{ event, agent }`. The server maps these to phase state transitions. Unknown events return 200 silently — dashboard degrades gracefully.

Hook setup in target repos is manual (documented in web/README.md). MVP does not auto-configure hooks.

## Single-spawn constraint

Only one `claude` process active at a time. Concurrent spawn attempts return HTTP 409. This is a design constraint, not a technical limitation — sequential pipeline commands are the valid use case.

## `--dangerously-skip-permissions` per-spawn

Always passed per spawn. NOT in global `.claude/settings.json`. This limits the permission grant to web-manager-launched processes only.

## Phases

Four fixed phases: architect, developer, reviewer, ship. New spawn resets all phases to `idle` and broadcasts 4 phase messages before the first log line.

## Log buffer

In-memory circular buffer, max 5000 lines. Drops oldest 1000 when full. Init message replays last 500 lines to new WS clients.

## Multi-project readiness

`projectName` is on every WS message and in `GET /api/state`. Architecture is project-keyed but MVP UI shows one project. Adding multi-project requires only a project selector component + server-side scoping.
