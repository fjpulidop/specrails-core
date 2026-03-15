---
change: sqlite-job-persistence
type: design
---

# SQLite Job Persistence — Technical Design

## 1. Architecture Overview

```
POST /api/spawn
      │
      ▼
spawner.ts  ──── stream-json stdout ────►  db.ts (better-sqlite3)
      │                                          │
      │  broadcast(msg)                          │  INSERT events
      ▼                                          │  UPDATE jobs
in-memory logBuffer (hot cache)                 ▼
      │                                    jobs.sqlite
      ▼                                          │
WebSocket clients                    REST endpoints (GET /api/jobs, etc.)
```

The in-memory buffer remains the WebSocket hot path. SQLite is written synchronously (better-sqlite3 is synchronous by design) on every event, so no queue or async complexity is introduced.

## 2. SQLite Schema

### Database file location

`<cwd>/data/jobs.sqlite` — relative to the web-manager working directory. The `data/` directory is created at startup if absent.

### Tables

```sql
-- Schema versioning
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per pipeline run
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT    PRIMARY KEY,       -- UUID (same as processId)
  command         TEXT    NOT NULL,
  started_at      TEXT    NOT NULL,          -- ISO 8601
  finished_at     TEXT,                      -- NULL while running
  status          TEXT    NOT NULL DEFAULT 'running',  -- queued|running|completed|failed|canceled
  exit_code       INTEGER,
  -- Token/cost data (populated from stream-json result event)
  tokens_in            INTEGER,
  tokens_out           INTEGER,
  tokens_cache_read    INTEGER,
  tokens_cache_create  INTEGER,
  total_cost_usd       REAL,
  num_turns            INTEGER,
  model                TEXT,
  duration_ms          INTEGER,
  duration_api_ms      INTEGER,
  session_id           TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_started_at ON jobs(started_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Every observable event for a job
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,              -- monotonically increasing within a job
  event_type  TEXT    NOT NULL,             -- 'log' | 'phase' | 'system_prompt' | 'assistant' | 'tool_use' | 'tool_result' | 'result'
  source      TEXT,                         -- 'stdout' | 'stderr' | NULL for non-log
  payload     TEXT    NOT NULL,             -- JSON blob of the full event
  timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_job_id ON events(job_id);

-- Per-job phase tracking (one row per phase per job, upserted on transitions)
CREATE TABLE IF NOT EXISTS job_phases (
  job_id      TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  phase       TEXT    NOT NULL,             -- architect|developer|reviewer|ship
  state       TEXT    NOT NULL,             -- idle|running|done|error
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (job_id, phase)
);
```

### Migration strategy

- `db.ts` exports an `initDb(dbPath: string): Database` function.
- On startup, it calls `applyMigrations(db)` which reads `schema_migrations` and applies any not-yet-applied migration functions in order.
- Migration 1 is the initial schema above.
- Future migrations append to a `MIGRATIONS` array in `db.ts`. No external files — migrations live in code.

## 3. stream-json Output Parsing

### Current spawner behavior

```
spawn('claude', ['--dangerously-skip-permissions', ...args])
readline stdout/stderr → emitLine()
```

### New spawner behavior

```
spawn('claude', ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '-p', ...args])
readline stdout → try JSON.parse(line)
  success → handleStructuredEvent(parsed)
  failure → treat as plain text log line (graceful degradation)
```

### Structured event handling

Claude Code `stream-json` emits newline-delimited JSON objects. Relevant types:

| `type` field | Action |
|---|---|
| `system_prompt` | Store in events table; no WS broadcast |
| `assistant` | Store in events table; broadcast as log line (content text extracted) |
| `tool_use` | Store in events table; broadcast tool name + input as log line |
| `tool_result` | Store in events table; no broadcast (too verbose) |
| `result` | Extract cost/token/duration fields → update job row; store in events; broadcast as exit log line |
| anything else | Store raw in events table; broadcast as log line |

The `result` event carries: `total_cost_usd`, `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, `num_turns`, `session_id`, `model`, `duration_ms`, `api_duration_ms`.

### Graceful degradation

If `--output-format stream-json` is not supported by the installed Claude version (the line is not valid JSON), each stdout line is treated as a plain-text log line. The job row stores no token/cost data. This is logged as a warning but does not break spawning.

## 4. New Module: `db.ts`

Location: `templates/web-manager/server/db.ts`

Exports:
```typescript
export function initDb(dbPath: string): Database
export function createJob(db: Database, job: NewJob): void
export function finishJob(db: Database, jobId: string, result: JobResult): void
export function appendEvent(db: Database, jobId: string, seq: number, event: AppEvent): void
export function upsertPhase(db: Database, jobId: string, phase: string, state: string): void
export function listJobs(db: Database, opts: ListJobsOpts): JobRow[]
export function getJob(db: Database, jobId: string): JobRow | undefined
export function getJobEvents(db: Database, jobId: string): EventRow[]
export function deleteJob(db: Database, jobId: string): void
export function getStats(db: Database): StatsRow
```

The `Database` instance is created once in `index.ts` at startup and passed to spawner and route handlers. This avoids a module-level singleton while keeping the DB handle accessible everywhere needed.

## 5. Updated `spawner.ts`

### Signature changes

```typescript
// Before
export function spawnClaude(
  command: string,
  broadcast: (msg: WsMessage) => void,
  onResetPhases: () => void
): SpawnHandle

// After
export function spawnClaude(
  command: string,
  broadcast: (msg: WsMessage) => void,
  onResetPhases: () => void,
  db: Database                          // new parameter
): SpawnHandle
```

### Internal changes

- Add `--output-format stream-json --verbose -p` to spawn args.
- Track a per-process event `seq` counter (starts at 0, increments per event).
- On each stdout line: attempt JSON parse.
  - If parsed: call `appendEvent(db, ...)` and extract display text for broadcast.
  - If not parsed: call `appendEvent(db, ...)` with `event_type: 'log'`, broadcast as before.
- On stderr lines: `appendEvent(db, ...)` with `event_type: 'log'`, `source: 'stderr'`.
- On `close`: call `finishJob(db, processId, { exitCode, ... })`.
- Call `createJob(db, ...)` before `spawn()` call.

## 6. Updated `hooks.ts`

The hooks router needs the active job id to call `upsertPhase(db, ...)`. Since job id comes from the spawner, pass it via a shared mutable ref:

```typescript
// index.ts
const activeJobRef = { current: null as string | null }

// spawner.ts: set activeJobRef.current = processId on spawn, null on close
// hooks router: read activeJobRef.current when handling phase events
```

Pass `activeJobRef` and `db` into both `createHooksRouter` and `spawnClaude`.

## 7. New REST Endpoints

All new endpoints are added directly to `index.ts` or extracted to a `routes/jobs.ts` module (preferred for cleanliness).

### `GET /api/jobs`

Query params:
- `status`: filter by status string (optional)
- `from`: ISO date lower bound on `started_at` (optional)
- `to`: ISO date upper bound on `started_at` (optional)
- `limit`: integer, default 50, max 200
- `offset`: integer, default 0

Response: `{ jobs: JobRow[], total: number }`

### `GET /api/jobs/:id`

Response: `{ job: JobRow, events: EventRow[], phases: JobPhaseRow[] }`

Returns 404 if job not found.

### `DELETE /api/jobs/:id`

Deletes job and all cascade-deleted events and phases.
Response: `{ ok: true }` or 404.

### `GET /api/stats`

Response:
```json
{
  "totalJobs": 42,
  "jobsToday": 3,
  "totalCostUsd": 12.34,
  "costToday": 1.50,
  "avgDurationMs": 45000
}
```

## 8. Updated `GET /api/state`

Extend the existing endpoint to include the current job id:

```json
{
  "projectName": "...",
  "phases": { ... },
  "busy": true,
  "currentJobId": "uuid-or-null"
}
```

## 9. Updated WebSocket `init` Message

Extend `InitMessage` to include recent job summary for the reconnecting client:

```typescript
interface InitMessage {
  type: 'init'
  projectName: string
  phases: Record<PhaseName, PhaseState>
  logBuffer: LogMessage[]
  recentJobs: JobSummary[]   // last 10 jobs
}
```

`JobSummary` = `{ id, command, started_at, status, total_cost_usd }`.

## 10. New Types in `types.ts`

```typescript
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface JobRow {
  id: string
  command: string
  started_at: string
  finished_at: string | null
  status: JobStatus
  exit_code: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache_read: number | null
  tokens_cache_create: number | null
  total_cost_usd: number | null
  num_turns: number | null
  model: string | null
  duration_ms: number | null
  duration_api_ms: number | null
  session_id: string | null
}

export interface EventRow {
  id: number
  job_id: string
  seq: number
  event_type: string
  source: string | null
  payload: string  // JSON
  timestamp: string
}

export interface StatsRow {
  totalJobs: number
  jobsToday: number
  totalCostUsd: number
  costToday: number
  avgDurationMs: number | null
}
```

## 11. React Client Changes

### New component: `JobHistory.tsx`

Location: `templates/web-manager/client/src/components/JobHistory.tsx`

Renders a scrollable list of past jobs fetched from `GET /api/jobs`. Each row: job id (truncated), command, started_at (formatted), status badge (color-coded), total_cost_usd.

Polls `GET /api/jobs` every 5 seconds OR refreshes on WS reconnect. No real-time push for history panel (polling is sufficient and avoids new WS message type complexity).

### New component: `StatsBar.tsx`

Location: `templates/web-manager/client/src/components/StatsBar.tsx`

Renders a single-line stats strip: "Today: 3 jobs | $1.50 | All time: 42 jobs | $12.34". Fetches from `GET /api/stats` on mount and on WS reconnect.

### Layout change in `App.tsx`

Add a third row to the grid for the history/stats area below the main activity panel:

```
"header  header"
"sidebar activity"
"sidebar history"
```

The history panel occupies the bottom portion of the activity column. PipelineSidebar stays unchanged in the sidebar area.

### `usePipeline.ts` changes

- Handle the `recentJobs` field in the `init` message.
- Expose `recentJobs` from the hook return value.

## 12. `package.json` Changes

```json
"dependencies": {
  "better-sqlite3": "^9.4.0",
  ...
},
"devDependencies": {
  "@types/better-sqlite3": "^7.6.0",
  ...
}
```

## 13. Design Decisions

### Why better-sqlite3 (synchronous) over async SQLite wrappers?

The server is I/O-bound on the Claude CLI subprocess. All DB writes happen in the readline `line` event handler, which is already synchronous in its critical section. Using a synchronous SQLite driver avoids async/await complexity in the event pipeline and eliminates the possibility of events being written out of order due to Promise scheduling. better-sqlite3 is the de-facto standard for synchronous SQLite in Node.js.

### Why pass `db` as a parameter rather than a module singleton?

The existing test pattern (`vi.resetModules()` between tests) means module-level singletons are reset on each test run — but a SQLite connection must be opened once and closed explicitly. Passing `db` as a parameter makes the dependency explicit, allows tests to inject an in-memory `:memory:` DB, and avoids resource leaks.

### Why store raw JSON in `events.payload` rather than structured columns?

Event shapes differ significantly across `stream-json` types. A single JSON blob column is far simpler than a wide nullable-column table and supports future event types without schema migrations. Querying specific fields within events is not a current requirement — callers receive the full payload and parse client-side.

### Why polling for job history rather than WebSocket push?

Job history is not latency-sensitive. A 5-second polling interval is imperceptible to users and avoids adding a new WS message type (`jobs_updated`) and the client-side merge logic that would require. The trade-off is minimal; upgrade to push is straightforward later.

### Why `activeJobRef` instead of exporting `currentJobId` from spawner?

The hooks router needs to write phase transitions for the current job, but hooks.ts must not import from spawner.ts (circular dependency risk). A shared mutable ref object passed from `index.ts` to both modules is the dependency-inversion pattern that keeps the module graph acyclic.

## 14. Edge Cases

| Case | Handling |
|---|---|
| Server crashes mid-job | Job row remains with `status: 'running'` and no `finished_at`. On next startup, a startup sweep marks any orphaned `running` jobs as `status: 'failed'` with a synthetic `finished_at`. |
| `stream-json` unavailable (old Claude version) | `--output-format` flag not recognized → Claude prints an error to stderr → the server treats stderr lines as plain text. The job finishes with exit code != 0 → status `failed`. No cost data stored. |
| DB file corrupted | `better-sqlite3` throws on open; server logs error and falls back to in-memory-only mode (no persistence). The in-memory buffer still works for real-time clients. |
| Job deleted while WS clients are streaming it | Deletion is allowed. The in-memory buffer is unaffected. WS clients see no change; only future `GET /api/jobs/:id` calls return 404. |
| Very large event payload (tool_result with big output) | `payload` TEXT has no SQLite size limit. No truncation — store full payload. Future optimization: truncate `tool_result` payloads > 64 KB. |
