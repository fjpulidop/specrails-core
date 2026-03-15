---
change: sqlite-job-persistence
type: feature
status: proposed
github_issue: 57
vpc_fit: 95%
---

# SQLite Job Persistence & History

## Problem

The web-manager's in-memory circular buffer (5000 lines) and module-level phase variables are lost on every server restart. Operators cannot review what ran earlier today, debug a failed pipeline run post-mortem, or track cost trends over time. Every server restart is an amnesia event.

## Solution

Replace the ephemeral state model with a two-tier storage architecture:

- **Hot layer**: keep the existing in-memory log buffer as the real-time WebSocket cache. No behavior change for live clients.
- **Cold layer**: add SQLite via `better-sqlite3` as the durable persistence layer. Every job, every event, every phase transition, and every token/cost observation is written to SQLite in real time.

The CLI spawner is upgraded to use `--output-format stream-json --verbose -p` instead of raw stdout capture, which gives the server structured JSON events from Claude Code including token counts, cost, duration, session_id, and model per turn.

New REST endpoints expose historical data: job list with pagination and filters, full job detail with events, job deletion, and aggregate stats.

## Scope

### In scope

- SQLite schema for jobs, events, and phase transitions
- Migration strategy (schema versioning table, applied-once migrations)
- Upgrade spawner to parse `stream-json` output and write to SQLite
- Four new REST endpoints: `GET /api/jobs`, `GET /api/jobs/:id`, `DELETE /api/jobs/:id`, `GET /api/stats`
- Job History panel in the React client (list of past jobs with status, cost, duration)
- Stats bar in the React client (today's job count, total cost, active session info)
- Retain in-memory buffer as hot cache; SQLite is persistence only
- `package.json` updated: add `better-sqlite3`, `@types/better-sqlite3`

### Non-goals

- Multi-project database sharding (the DB is per web-manager instance)
- Full-text search over log events
- Export to external observability systems (Datadog, etc.)
- Automatic log retention / TTL pruning (the DB grows until manually cleaned)
- Authentication / authorization on the new endpoints

## Acceptance Criteria

1. After server restart, `GET /api/jobs` returns all previously run jobs with correct status and timestamps.
2. `GET /api/jobs/:id` returns all stored events for a job in insertion order.
3. `POST /api/spawn` creates a job row with status `running` before the first log line is emitted.
4. When a job exits, its row is updated with `finished_at`, `status` (completed/failed), `exit_code`, and token/cost data parsed from the final `stream-json` result event.
5. Phase transitions (`/hooks/events`) are persisted to the events table tagged by job id.
6. `GET /api/stats` returns correct aggregate totals (recalculated from stored rows).
7. The React client displays a job history list with job id, command, started_at, status, and cost.
8. The React client displays a stats bar showing today's job count and cumulative cost.
9. In-memory circular buffer continues to work as before for real-time WebSocket clients.
10. All existing server tests continue to pass.

## Motivation

Pipeline runs in specrails can take 10–30 minutes and cost real money. Operators need post-mortem visibility into what ran and what it cost. Today that information vanishes on restart. SQLite is the lowest-friction persistence layer for a single-instance Node.js server — no daemon, no network, one file.
