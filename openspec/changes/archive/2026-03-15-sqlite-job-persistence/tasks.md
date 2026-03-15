---
change: sqlite-job-persistence
type: tasks
---

# Tasks — SQLite Job Persistence

## Layer Legend

- `[server]` — Node.js/Express server code in `templates/web-manager/server/`
- `[client]` — React client code in `templates/web-manager/client/src/`
- `[tests]` — Test files (vitest)

---

## Task 1 `[server]` — Add `better-sqlite3` dependency

**Files:** `templates/web-manager/package.json`

**Description:** Add `better-sqlite3` to `dependencies` and `@types/better-sqlite3` to `devDependencies`. Run `npm install` to generate the updated lockfile.

**Acceptance criteria:**
- `package.json` contains `"better-sqlite3": "^9.4.0"` in dependencies.
- `package.json` contains `"@types/better-sqlite3": "^7.6.0"` in devDependencies.
- `npm install` completes without error.
- `import Database from 'better-sqlite3'` compiles without type errors.

**Dependencies:** None

---

## Task 2 `[server]` — Create `db.ts` with schema, migrations, and data-access functions

**Files:** `templates/web-manager/server/db.ts` (new file)

**Description:** Create the database module that owns all SQLite interactions. This file:
1. Defines the `MIGRATIONS` array (migration 1 = initial schema for `schema_migrations`, `jobs`, `events`, `job_phases` tables plus indexes).
2. Exports `initDb(dbPath: string): Database` which opens the DB (creating the file and `data/` dir if needed), runs `applyMigrations`, and returns the handle.
3. Exports `createJob`, `finishJob`, `appendEvent`, `upsertPhase`, `listJobs`, `getJob`, `getJobEvents`, `deleteJob`, `getStats` as documented in the design.
4. On orphan detection: after migrations run, executes an UPDATE to mark any `status = 'running'` rows as `failed` with current timestamp.

**Acceptance criteria:**
- `initDb(':memory:')` returns a working Database without error.
- `createJob` followed by `getJob` returns the inserted row.
- `finishJob` updates status, exit_code, finished_at, and token/cost fields.
- `appendEvent` inserts a row retrievable by `getJobEvents`.
- `upsertPhase` inserts then updates on second call (upsert behavior).
- `listJobs` respects `limit`, `offset`, `status`, `from`, `to` filters.
- `getStats` returns correct counts and sums from seeded data.
- `deleteJob` removes the job and cascades to events and job_phases.
- Orphan detection: a `running` row with no `finished_at` is updated to `failed` on `initDb`.

**Dependencies:** Task 1

---

## Task 3 `[server]` — Add new types to `types.ts`

**Files:** `templates/web-manager/server/types.ts`

**Description:** Add the following exported types to the shared types file:
- `JobStatus` union type
- `JobRow` interface
- `EventRow` interface
- `StatsRow` interface
- `JobSummary` interface (id, command, started_at, status, total_cost_usd)
- Update `InitMessage` to add `recentJobs: JobSummary[]`
- Update `SpawnHandle` to ensure it already has or add `processId`

**Acceptance criteria:**
- All new types compile without error.
- `InitMessage.recentJobs` is typed as `JobSummary[]`.
- Existing type exports are unchanged (no renames or removals).

**Dependencies:** None (parallel with Task 2)

---

## Task 4 `[server]` — Upgrade `spawner.ts` to stream-json + SQLite writes

**Files:** `templates/web-manager/server/spawner.ts`

**Description:** Refactor the spawner to:
1. Accept a `db: Database` parameter as the 4th argument to `spawnClaude`.
2. Change the spawn args to include `--output-format stream-json --verbose -p` before the user command args.
3. Call `createJob(db, ...)` immediately after the guard checks pass (before `spawn()`).
4. Track a `seq` counter starting at 0 for this job.
5. In the stdout readline handler: attempt `JSON.parse(line)`. On success: call `appendEvent(db, ...)` with the parsed event type and payload; extract a human-readable display string for `emitLine`. On failure: call `appendEvent(db, ...)` with `event_type: 'log'`; call `emitLine` as before.
6. In the stderr readline handler: call `appendEvent(db, ...)` with `event_type: 'log', source: 'stderr'`.
7. In the `close` handler: call `finishJob(db, processId, { exitCode: code, ... })`. If a `result` event was parsed, pass its token/cost fields to `finishJob`.
8. Store the latest parsed `result` event in a closure variable so the `close` handler can access it.

**Text extraction rules for stream-json types:**
- `assistant`: join `content[*].text` fields
- `tool_use`: `"[tool: <name>]"` prefix + truncated input JSON (first 120 chars)
- `tool_result`: do not broadcast (too verbose); store only
- `result`: emit the exit summary line as today: `[process exited with code N]` plus cost if available
- `system_prompt`: do not broadcast
- anything unknown: emit `JSON.stringify(event)` as the log line

**Acceptance criteria:**
- `spawnClaude` accepts the `db` parameter without TypeScript error.
- The spawned Claude process receives `--output-format stream-json --verbose -p` in its args.
- After a stdout line is emitted and `await`ed in tests, a corresponding event row exists in the in-memory test DB.
- The `result` event's cost/token fields are written to the job row on close.
- Malformed (non-JSON) stdout lines are treated as plain text log messages (no crash).
- The existing `getLogBuffer()` function still returns messages (in-memory buffer unchanged).

**Dependencies:** Tasks 1, 2, 3

---

## Task 5 `[server]` — Update `hooks.ts` to persist phase transitions

**Files:** `templates/web-manager/server/hooks.ts`

**Description:** Update `createHooksRouter` signature to accept `db: Database` and `activeJobRef: { current: string | null }` in addition to `broadcast`. In the `POST /hooks/events` handler, after updating the in-memory phase and broadcasting, call `upsertPhase(db, activeJobRef.current, agent, newState)` if `activeJobRef.current` is not null.

**Acceptance criteria:**
- `createHooksRouter` compiles with the new parameters.
- When `activeJobRef.current` is set, a phase transition creates/updates a row in `job_phases`.
- When `activeJobRef.current` is null, the phase transition still broadcasts and updates in-memory state but does not write to DB.
- Existing hook behavior (in-memory state update, broadcast) is unchanged.

**Dependencies:** Tasks 2, 3

---

## Task 6 `[server]` — Wire `db` and `activeJobRef` in `index.ts`; add new REST endpoints

**Files:** `templates/web-manager/server/index.ts`

**Description:**
1. Import `initDb` from `./db` and call it at startup: `const db = initDb(path.join(process.cwd(), 'data', 'jobs.sqlite'))`.
2. Declare `const activeJobRef = { current: null as string | null }`.
3. Update the `POST /api/spawn` handler to pass `db` to `spawnClaude`. In the `onResetPhases` callback, also set `activeJobRef.current = null`. After a successful spawn, set `activeJobRef.current = handle.processId`.
4. Update `createHooksRouter(broadcast)` call to `createHooksRouter(broadcast, db, activeJobRef)`.
5. Update the WS `init` message to include `recentJobs: listJobs(db, { limit: 10 }).jobs`.
6. Update `GET /api/state` to include `currentJobId: activeJobRef.current`.
7. Add `GET /api/jobs` endpoint with pagination/filter logic.
8. Add `GET /api/jobs/:id` endpoint.
9. Add `DELETE /api/jobs/:id` endpoint.
10. Add `GET /api/stats` endpoint.

**Acceptance criteria:**
- Server starts without error and creates `data/jobs.sqlite`.
- `GET /api/jobs` returns `{ jobs: [], total: 0 }` on a fresh DB.
- `GET /api/stats` returns zeroed stats on a fresh DB.
- `POST /api/spawn` + process exit results in a retrievable job via `GET /api/jobs/:id`.
- `GET /api/state` includes `currentJobId` field.
- `DELETE /api/jobs/:id` returns 404 for unknown ids.
- All existing routes (`/hooks/events`, `GET /api/state`, `POST /api/spawn`) continue to work as before.

**Dependencies:** Tasks 2, 3, 4, 5

---

## Task 7 `[tests]` — Update `spawner.test.ts` for new signature and DB writes

**Files:** `templates/web-manager/server/spawner.test.ts`

**Description:** Update all `spawnClaude(command, broadcast, onReset)` calls to `spawnClaude(command, broadcast, onReset, db)` where `db = initDb(':memory:')`. Add new test cases:
- Spawning creates a job row in the DB.
- A stdout line (plain text) creates an event row with `event_type: 'log'`.
- A valid stream-json line creates an event row with the correct `event_type`.
- A `result` stream-json event updates the job row with cost/token fields on close.
- A malformed JSON line is handled as plain text (no crash, event row still written).

**Acceptance criteria:**
- All 14 existing spawner tests still pass.
- 5 new test cases pass.
- `vi.resetModules()` pattern still works (DB is injected, not a module singleton).

**Dependencies:** Tasks 2, 4

---

## Task 8 `[tests]` — Update `index.test.ts` for new DB-backed endpoints

**Files:** `templates/web-manager/server/index.test.ts`

**Description:** Update `createTestApp()` to create an in-memory DB with `initDb(':memory:')` and wire it through the app factory (mirror what `index.ts` does). Add test cases for:
- `GET /api/jobs` returns empty list on fresh DB.
- `GET /api/jobs/:id` returns 404 for unknown id.
- `DELETE /api/jobs/:id` returns 404 for unknown id.
- `GET /api/stats` returns zeroed stats on fresh DB.
- `GET /api/state` includes `currentJobId: null` when idle.
- After a successful spawn, `GET /api/jobs` returns 1 job with status `running`.

**Acceptance criteria:**
- All 7 existing API tests still pass.
- 6 new test cases pass.

**Dependencies:** Tasks 2, 3, 5, 6

---

## Task 9 `[tests]` — Create `db.test.ts`

**Files:** `templates/web-manager/server/db.test.ts` (new file)

**Description:** Unit tests for all `db.ts` exports using an in-memory DB. Cover:
- `initDb(':memory:')` applies migration 1 successfully.
- Orphan detection marks a `running` job as `failed` on `initDb`.
- `createJob` + `getJob` round-trip.
- `finishJob` updates all fields correctly.
- `appendEvent` + `getJobEvents` returns events in `seq` order.
- `upsertPhase` inserts on first call, updates on second.
- `listJobs` paginates correctly.
- `listJobs` filters by status.
- `listJobs` filters by `from`/`to` date range.
- `deleteJob` cascades to events and job_phases.
- `getStats` computes correct totals.

**Acceptance criteria:**
- 11 test cases, all passing.
- No file I/O (`:memory:` DB only).

**Dependencies:** Task 2

---

## Task 10 `[client]` — Add `JobSummary` type and update `usePipeline.ts`

**Files:** `templates/web-manager/client/src/hooks/usePipeline.ts`

**Description:** Add `JobSummary` interface to the client types (local duplicate, per existing convention of not importing from server). Update `usePipeline` to:
1. Add `recentJobs` state initialized to `[]`.
2. On `init` message, set `recentJobs` from `msg.recentJobs ?? []`.
3. Expose `recentJobs` in the hook return value.

**Acceptance criteria:**
- `usePipeline` return type includes `recentJobs: JobSummary[]`.
- `init` message handling populates `recentJobs` correctly.
- TypeScript compiles without error.

**Dependencies:** None (can be done in parallel with server tasks)

---

## Task 11 `[client]` — Create `StatsBar.tsx` component

**Files:** `templates/web-manager/client/src/components/StatsBar.tsx` (new file)

**Description:** Create a component that:
1. On mount, fetches `GET /api/stats` and stores result in local state.
2. Re-fetches when a `connected` WebSocket status is received (passed as a prop or via a `refreshSignal` counter prop).
3. Renders: `"Today: N jobs | $X.XX | All time: N jobs | $X.XX"` in a compact single-line strip.
4. Handles loading state (shows dash placeholders) and fetch error (shows "Stats unavailable").

**Props:** `{ refreshSignal: number }` (incremented by parent on WS reconnect)

**Acceptance criteria:**
- Renders correctly with mock fetch data.
- Shows dash placeholders while loading.
- `refreshSignal` change triggers a re-fetch.

**Dependencies:** Task 6 (needs the endpoint to exist for manual testing; component can be built against mock data)

---

## Task 12 `[client]` — Create `JobHistory.tsx` component

**Files:** `templates/web-manager/client/src/components/JobHistory.tsx` (new file)

**Description:** Create a component that:
1. Accepts `initialJobs: JobSummary[]` prop (from WS `init` message via `usePipeline`).
2. Polls `GET /api/jobs?limit=20` every 5 seconds, merging results with `initialJobs`.
3. Renders a scrollable table: job id (first 8 chars), command (truncated to 40 chars), started_at (locale time string), status badge, total_cost_usd (formatted as `$X.XXXX` or `-`).
4. Status badge colors: `running` = yellow, `completed` = green, `failed` = red, `canceled` = gray.

**Props:** `{ initialJobs: JobSummary[] }`

**Acceptance criteria:**
- Renders correctly with a seeded list of `initialJobs`.
- Status badge color matches the spec.
- Polling interval is 5000ms (verified in test or by inspection).
- Long commands are truncated with `...`.

**Dependencies:** Task 10

---

## Task 13 `[client]` — Update `App.tsx` layout to include history and stats panels

**Files:** `templates/web-manager/client/src/App.tsx`

**Description:** Update the CSS grid to add a `history` area below `activity`. Import and render `StatsBar` above the `JobHistory` panel in the new area. Pass `recentJobs` from `usePipeline` to `JobHistory`. Pass a `refreshSignal` to `StatsBar` (increment when `connectionStatus` transitions to `connected`).

Grid template:
```css
grid-template-areas: '"header header" "sidebar activity" "sidebar history"';
grid-template-rows: '48px 1fr 200px';
```

**Acceptance criteria:**
- `StatsBar` and `JobHistory` render in the new grid area.
- `recentJobs` is wired from `usePipeline` to `JobHistory`.
- `AgentActivity` (log stream) occupies the `activity` row as before.
- TypeScript compiles without error.

**Dependencies:** Tasks 10, 11, 12

---

## Task 14 `[server]` — Add `.gitignore` entry for `data/` directory

**Files:** `templates/web-manager/.gitignore` (create if absent)

**Description:** Ensure `data/` and `data/jobs.sqlite` are not committed to the specrails repo.

**Acceptance criteria:**
- `data/` is in `.gitignore`.
- `git status` does not show `data/` as untracked after server startup.

**Dependencies:** None

---

## Execution Order

```
Task 1  (add dep)
  └── Task 2 (db.ts)
        ├── Task 9 (db.test.ts)
        └── Task 3 (types.ts)  ← also independent
              ├── Task 4 (spawner.ts)
              │     └── Task 7 (spawner.test.ts)
              ├── Task 5 (hooks.ts)
              └── Task 6 (index.ts + routes)
                    └── Task 8 (index.test.ts)

Task 14 (gitignore) ← independent, can do any time

Task 10 (usePipeline) ← independent client task
  ├── Task 11 (StatsBar)
  ├── Task 12 (JobHistory)
  └── Task 13 (App.tsx) ← after 11 and 12
```

Server tasks (1–9, 14) can proceed in parallel with client tasks (10–13) after Task 3.
