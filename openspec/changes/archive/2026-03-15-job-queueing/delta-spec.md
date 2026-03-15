---
change: job-queueing
type: delta-spec
---

# Delta Spec: Job Queueing & Parallel Execution Management

This document states what the system SHALL do after this change is applied. Each statement is normative.

---

## 1. Job Lifecycle

**1.1** The web-manager SHALL maintain a job queue. Every command submitted via `POST /api/spawn` SHALL create a job record with a unique `jobId`.

**1.2** A job SHALL exist in exactly one of these states at any time: `queued`, `running`, `completed`, `failed`, `canceled`.

**1.3** At most one job SHALL be in `running` state at any time.

**1.4** A `queued` job SHALL transition to `running` when no other job is `running` and the queue is not paused.

**1.5** A `running` job SHALL transition to `completed` when its child process exits with code `0`.

**1.6** A `running` job SHALL transition to `failed` when its child process exits with a non-zero code.

**1.7** A `queued` job SHALL transition to `canceled` when `DELETE /api/jobs/:id` is called for that job ID.

**1.8** A `running` job SHALL transition to `canceled` when `DELETE /api/jobs/:id` is called for that job ID, after the child process exits.

**1.9** When a `running` job reaches a terminal state (`completed`, `failed`, or `canceled`), the queue manager SHALL attempt to start the next `queued` job unless the queue is paused.

---

## 2. Process Kill Behavior

**2.1** When `DELETE /api/jobs/:id` is called on a running job, the server SHALL send SIGTERM to the child process tree (all descendants, not just the top-level PID).

**2.2** If the child process has not exited within 5 seconds of SIGTERM, the server SHALL send SIGKILL.

**2.3** The kill sequence SHALL use `tree-kill` to terminate the entire process group.

**2.4** The `DELETE /api/jobs/:id` response SHALL return `200 { ok: true, status: 'canceling' }` immediately after SIGTERM is sent, before the process has exited. The final `canceled` status SHALL be broadcast via WebSocket when the process exits.

---

## 3. Queue Control

**3.1** `POST /api/queue/pause` SHALL set the queue to paused state. While paused, no new `running` job SHALL be started from the queue when the current job finishes.

**3.2** `POST /api/queue/resume` SHALL clear the paused state and SHALL immediately attempt to start the next queued job if one exists and nothing is running.

**3.3** Paused state SHALL be persisted to SQLite `queue_state` table if SQLite is available.

**3.4** `PUT /api/queue/reorder` SHALL reorder the `queued` jobs according to the `jobIds` array in the request body. The `jobIds` array MUST contain exactly the IDs of all currently-`queued` jobs. If any ID is missing or extra, the server SHALL return `400`.

**3.5** `PUT /api/queue/reorder` SHALL only affect jobs in `queued` state. Running and terminal jobs SHALL NOT be included in `jobIds`.

---

## 4. REST API Contract

**4.1** `POST /api/spawn`:
- Request body: `{ command: string }`
- Response `202`: `{ jobId: string, position: number }` where `position` is `0` if the job started immediately
- Response `400`: `{ error: string }` if command is missing/empty or `claude` binary not found
- The previous `409` response for busy state SHALL NOT be returned by this endpoint

**4.2** `DELETE /api/jobs/:id`:
- Response `200`: `{ ok: true, status: 'canceled' | 'canceling' }`
- Response `404`: `{ error: 'Job not found' }` if the job ID does not exist
- Response `409`: `{ error: 'Job is already in terminal state' }` if the job is `completed`, `failed`, or `canceled`

**4.3** `POST /api/queue/pause`:
- Response `200`: `{ ok: true, paused: true }`

**4.4** `POST /api/queue/resume`:
- Response `200`: `{ ok: true, paused: false }`

**4.5** `PUT /api/queue/reorder`:
- Request body: `{ jobIds: string[] }`
- Response `200`: `{ ok: true, queue: string[] }`
- Response `400`: `{ error: string }` if jobIds do not exactly match the current queued set

**4.6** `GET /api/queue`:
- Response `200`: `{ jobs: Job[], paused: boolean, activeJobId: string | null }`
- `jobs` includes all non-archived jobs (queued, running, and recent terminal jobs)

**4.7** `GET /api/state` SHALL continue to return `{ projectName, phases, busy: boolean }` unchanged. `busy` SHALL be `true` when `activeJobId !== null`.

---

## 5. WebSocket Protocol

**5.1** The server SHALL broadcast a `queue` message whenever the queue state changes (enqueue, dequeue, status change, pause, resume, reorder).

**5.2** The `queue` message schema SHALL be:
```
{
  type: "queue",
  jobs: Job[],
  activeJobId: string | null,
  paused: boolean,
  timestamp: string
}
```

**5.3** The `init` message SHALL include a `queue` field with the initial queue state:
```
{
  type: "init",
  projectName: string,
  phases: Record<PhaseName, PhaseState>,
  logBuffer: LogMessage[],
  queue: { jobs: Job[], activeJobId: string | null, paused: boolean }
}
```

**5.4** Log messages (`type: "log"`) SHALL retain the `processId` field. For jobs managed by the queue, `processId` SHALL equal the `jobId`.

---

## 6. SQLite Integration (conditional on #57)

**6.1** When SQLite is available on startup, the server SHALL query for jobs with `status = 'queued'` and restore them to the in-memory queue in `queue_position` order.

**6.2** When SQLite is available on startup, the server SHALL update all jobs with `status = 'running'` to `status = 'failed'` (the process is no longer alive).

**6.3** When SQLite is unavailable, the queue SHALL operate in-memory only. Queue state SHALL be lost on server restart in this mode.

**6.4** Every job status transition SHALL be persisted to SQLite (update `status`, `finished_at`, `exit_code` columns) when SQLite is available.

---

## 7. Client UI

**7.1** The client SHALL display a job list showing all jobs with status indicators:
- `running`: yellow pulsing dot
- `queued`: gray dot with numeric position badge
- `completed`: green check indicator
- `failed`: red indicator with exit code
- `canceled`: dim gray indicator

**7.2** The client SHALL display a "Kill" button on the active running job. Clicking it SHALL call `DELETE /api/jobs/:id`.

**7.3** The client SHALL display a "×" dismiss button on queued jobs. Clicking it SHALL call `DELETE /api/jobs/:id`.

**7.4** The client SHALL display a "Pause" / "Resume" toggle for the queue. The toggle SHALL call `POST /api/queue/pause` or `POST /api/queue/resume`.

**7.5** `POST /api/spawn` returning `202` SHALL cause the client to clear the command input and display a temporary `"Queued (position N)"` confirmation message for 2 seconds.

**7.6** The `CommandInput` component SHALL NOT display a "409 already running" error message. This error state is removed.

---

## Surface Impact of This Change

| # | Category | Element | Change | Severity |
|---|----------|---------|--------|----------|
| 1 | Signature Change | `POST /api/spawn` response | HTTP status 200 → 202; body `{ processId }` → `{ jobId, position }` | BREAKING (MINOR) |
| 2 | Removal | `409` response from `POST /api/spawn` | No longer returned | BREAKING (MINOR) |
| 3 | Removal | `spawner.ts` module | File deleted; API removed | BREAKING (internal) |
| 4 | Behavioral Change | `GET /api/state` `busy` field | Now driven by `activeJobId !== null` instead of `activeProcess !== null` | ADVISORY |
| 5 | Signature Change | `init` WsMessage | New `queue` field added | BREAKING (MINOR — new required field for clients) |

### Migration Guide

**Change 1 & 2 — POST /api/spawn response shape:**
Any code calling `POST /api/spawn` and checking the response must be updated:
- Replace references to `processId` with `jobId`
- Replace HTTP 409 handling with success handling (jobs queue, never reject)
- Update any code expecting HTTP 200 to accept HTTP 202

Affected file: `templates/web-manager/client/src/components/CommandInput.tsx`

**Change 3 — spawner.ts deleted:**
Any code importing from `./spawner` must be updated to import from `./queue-manager`:
- `spawnClaude(...)` → `queueManager.enqueue(...)`
- `isSpawnActive()` → `queueManager.getActiveJobId() !== null`
- `getLogBuffer()` → `queueManager.getLogBuffer()`
- `SpawnBusyError` → no replacement needed (never thrown)
- `SpawnHandle` → replaced by `Job`

Affected files: `templates/web-manager/server/index.ts`, `templates/web-manager/server/index.test.ts`

**Change 5 — init WsMessage queue field:**
Client code consuming the `init` message must handle the new `queue` field. The field is always present after this change. Clients that ignore unknown fields (as the current `usePipeline.ts` does) will not break, but they will not display queue state. A full update to `usePipeline.ts` is required.
