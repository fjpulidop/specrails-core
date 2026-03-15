---
change: sqlite-job-persistence
type: delta-spec
---

# Delta Spec — SQLite Job Persistence

## Storage Behavior

1. The web-manager server SHALL persist every job to a SQLite database file at `<cwd>/data/jobs.sqlite`, created on first startup.
2. The server SHALL initialize the database schema on every startup using an idempotent migration system; migrations already applied SHALL NOT be re-applied.
3. A job row SHALL be created in the `jobs` table before the first log line is emitted to WebSocket clients.
4. When a job process exits, the server SHALL update the job row with `finished_at`, `status` (`completed` if exit code is 0, `failed` otherwise), and `exit_code`.
5. The server SHALL persist every observable event (log line, phase transition, stream-json event) to the `events` table in insertion order, identified by `job_id` and a monotonically increasing `seq`.
6. Phase transitions received via `POST /hooks/events` SHALL be stored in the `job_phases` table if an active job exists; phase transitions when no job is active SHALL still update the in-memory state but MUST NOT write to the database.
7. On startup, the server SHALL detect any jobs with `status = 'running'` that have no `finished_at` (orphaned from a prior crash) and SHALL update them to `status = 'failed'` with `finished_at` set to the startup time.

## Claude CLI Invocation

8. The spawner SHALL pass `--output-format stream-json --verbose -p` to the Claude CLI.
9. The spawner SHALL attempt to parse each stdout line as JSON. If parsing succeeds, it SHALL extract display text and store the structured event. If parsing fails, it SHALL treat the line as a plain-text log message.
10. When a `result` event is received from the stream, the server SHALL update the job row with token counts, cost, duration, session_id, and model.

## REST API

11. The server SHALL expose `GET /api/jobs` returning a paginated list of jobs; default limit SHALL be 50, maximum limit SHALL be 200.
12. `GET /api/jobs` SHALL support query parameters: `status`, `from` (ISO date), `to` (ISO date), `limit`, `offset`.
13. The server SHALL expose `GET /api/jobs/:id` returning the full job row, all events, and all phase records for that job; a missing job SHALL return HTTP 404.
14. The server SHALL expose `DELETE /api/jobs/:id` which removes the job and all associated events and phases via cascade delete; a missing job SHALL return HTTP 404.
15. The server SHALL expose `GET /api/stats` returning `totalJobs`, `jobsToday`, `totalCostUsd`, `costToday`, and `avgDurationMs`.
16. `GET /api/state` SHALL include a `currentJobId` field (UUID string or null) in its response.

## WebSocket Protocol

17. The `init` message SHALL include a `recentJobs` array containing the last 10 job summaries (id, command, started_at, status, total_cost_usd).
18. The in-memory circular log buffer (max 5000 lines) SHALL be preserved as the hot cache for real-time WebSocket streaming. SQLite persistence is additive and SHALL NOT replace or modify the existing buffer behavior.

## Fallback Behavior

19. If the SQLite database cannot be opened, the server SHALL log an error and continue operating with the in-memory buffer only; all new REST job endpoints SHALL return HTTP 503 in this degraded mode.
20. If the Claude CLI does not support `--output-format stream-json`, the server SHALL degrade gracefully: log lines are treated as plain text, and no cost/token data is stored; the job completes with whatever exit code is returned.

## Surface Impact of This Change

| Category | Element | Change | Severity |
|----------|---------|--------|----------|
| 3 — Signature Change | `spawnClaude()` function | New `db` parameter added | MINOR (internal API; callers in index.ts only) |
| 3 — Signature Change | `createHooksRouter()` function | New `db` and `activeJobRef` parameters added | MINOR (internal API) |
| 4 — Behavioral Change | `POST /api/spawn` | Also writes to SQLite before responding | ADVISORY |
| 4 — Behavioral Change | Claude CLI invocation | Now includes `--output-format stream-json --verbose -p` | ADVISORY (stdout format changes) |
| 4 — Behavioral Change | `GET /api/state` response | Adds `currentJobId` field | ADVISORY (additive) |
| 4 — Behavioral Change | WS `init` message | Adds `recentJobs` field | ADVISORY (additive) |

No public CLI flags, template placeholders, command names, or agent names are changed by this feature. The surface impact is limited to the web-manager's internal TypeScript API and additive REST/WS shape changes.
