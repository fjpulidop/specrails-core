---
change: job-queueing
type: design
---

# Technical Design: Job Queueing & Parallel Execution Management

## Architecture Overview

The core change is the introduction of a `QueueManager` class that replaces the module-level `activeProcess` variable in `spawner.ts`. The `QueueManager` owns the entire job lifecycle: enqueueing, dequeuing, process spawning, process kill, and state broadcasting.

`spawner.ts` is renamed to `queue-manager.ts`. The public API surface for `index.ts` changes accordingly. `hooks.ts` gains job-scoped phase reset logic. The client gains a `JobQueueSidebar` component and `useQueue` hook. Existing components (`CommandInput`, `PipelineSidebar`) are updated to consume the new queue-aware state.

### Updated file map

```
templates/web-manager/
├── server/
│   ├── queue-manager.ts     NEW — replaces spawner.ts (QueueManager class + public API)
│   ├── spawner.ts           DELETED — logic moves to queue-manager.ts
│   ├── index.ts             MODIFIED — new routes, import from queue-manager
│   ├── hooks.ts             MODIFIED — phases scoped per-job via activeJobId
│   └── types.ts             MODIFIED — new queue types (JobStatus, Job, QueueMessage, etc.)
└── client/src/
    ├── components/
    │   ├── CommandInput.tsx          MODIFIED — shows queued confirmation instead of 409 error
    │   ├── PipelineSidebar.tsx       MODIFIED — scoped to active job
    │   └── JobQueueSidebar.tsx       NEW — job list with status + kill button
    └── hooks/
        ├── usePipeline.ts            MODIFIED — adds queue state
        └── useQueue.ts               NEW — queue-specific state derivation
```

---

## Job State Machine

```
         POST /api/spawn
               │
               ▼
          ┌─────────┐
          │ queued  │──── DELETE /api/jobs/:id ──► canceled
          └────┬────┘
               │ (queue drain: no running job AND queue not paused)
               ▼
          ┌─────────┐
          │ running │──── DELETE /api/jobs/:id ──► (SIGTERM → SIGKILL 5s) → canceled
          └────┬────┘
               │
        ┌──────┴──────┐
        ▼             ▼
  ┌──────────┐  ┌────────┐
  │completed │  │ failed │
  └──────────┘  └────────┘
```

**State definitions:**
- `queued`: Job is waiting in line. Position in queue = `queuedJobs.indexOf(jobId) + 1`.
- `running`: One and only one job is in this state at any time.
- `completed`: Process exited with code 0.
- `failed`: Process exited with non-zero code OR SIGKILL was required.
- `canceled`: Job was removed while queued, or killed while running.

**Transitions:**
- `queued → running`: Auto-triggered by `_drainQueue()` when no running job and queue not paused.
- `running → completed`: Child process `close` event with `code === 0`.
- `running → failed`: Child process `close` event with `code !== 0`.
- `running → canceled`: `DELETE /api/jobs/:id` on the active job.
- `queued → canceled`: `DELETE /api/jobs/:id` on a queued job.

---

## SQLite Schema Additions

This feature adds a `status` column to the `jobs` table and a new `queue_state` table. Both are additive; the base schema is defined by #57.

### Jobs table modification

```sql
-- Added column (migration M002)
ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'
  CHECK(status IN ('queued', 'running', 'completed', 'failed', 'canceled'));

ALTER TABLE jobs ADD COLUMN queue_position INTEGER;
```

### Queue state table (new)

```sql
-- Migration M003
CREATE TABLE IF NOT EXISTS queue_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed row
INSERT OR IGNORE INTO queue_state (key, value) VALUES ('paused', 'false');
```

The `queue_state` table stores scalar config values for the queue. The `paused` key persists pause state across restarts. This avoids adding columns to `jobs` for per-instance config.

### Startup restore query

On `QueueManager` initialization (after DB is ready), the manager runs:

```sql
SELECT id, command, started_at
FROM jobs
WHERE status = 'queued'
ORDER BY queue_position ASC;
```

These rows are loaded into the in-memory `_queue: string[]` array (array of job IDs). Jobs previously in `running` state are set to `failed` on startup (the process is no longer running — the server was restarted mid-job).

```sql
UPDATE jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP
WHERE status = 'running';
```

This recovery is only applied when SQLite is available. Without SQLite, the queue starts empty.

---

## API Design

### Modified: POST /api/spawn

**Before:**
```
Request:  { command: string }
Response: { processId: string }  |  409 { error: string }
```

**After:**
```
Request:  { command: string }
Response: 202 { jobId: string, position: number }
  position = 0 means started immediately (was empty queue)
  position = N means N jobs are ahead of it
```

The response status changes from 200 to 202 (Accepted) to signal that the request was accepted for processing but may not have started yet. The `processId` field in the response is removed — callers now use `jobId`.

**Note on backward compatibility:** The `position = 0` case (immediate start) is the common case for single-command workflows, so the behavioral change is minimal. Existing clients that checked for 409 will now never see a 409 from this endpoint — jobs queue instead of rejecting.

### New: DELETE /api/jobs/:id

```
Response (queued job):   200 { ok: true, status: 'canceled' }
Response (running job):  200 { ok: true, status: 'canceling' }
  The status is 'canceling' immediately; the job transitions to 'canceled'
  after the process exits (SIGTERM or SIGKILL).
Response (terminal job): 409 { error: 'Job is already in terminal state' }
Response (not found):    404 { error: 'Job not found' }
```

### New: POST /api/queue/pause

```
Response: 200 { ok: true, paused: true }
```

Sets internal `_paused = true`. Does not affect the currently running job.

### New: POST /api/queue/resume

```
Response: 200 { ok: true, paused: false }
```

Sets `_paused = false`. Immediately calls `_drainQueue()` which will start the next queued job if one exists and nothing is running.

### New: PUT /api/queue/reorder

```
Request:  { jobIds: string[] }
  jobIds must contain exactly the IDs of all currently-queued jobs (non-terminal, non-running).
  Any omitted IDs or IDs not in queued state return 400.

Response: 200 { ok: true, queue: string[] }
  queue = the new ordered array of jobIds
Response: 400 { error: string }  — if jobIds mismatch queued jobs
```

### New: GET /api/queue

```
Response: 200 {
  jobs: Job[],       // all non-archived jobs (queued + running + recent terminal)
  paused: boolean,
  activeJobId: string | null
}
```

This replaces `GET /api/state` for queue-aware clients. `GET /api/state` continues to work unchanged for backwards compatibility — it returns `busy: true` whenever `activeJobId !== null`.

---

## QueueManager Class Design

```typescript
// server/queue-manager.ts

export class QueueManager {
  private _queue: string[]               // ordered job IDs in queued state
  private _jobs: Map<string, Job>        // all in-memory job records
  private _activeProcess: ChildProcess | null
  private _activeJobId: string | null
  private _paused: boolean
  private _killTimer: NodeJS.Timeout | null
  private _broadcast: (msg: WsMessage) => void
  private _db: Database | null           // better-sqlite3 instance, nullable

  constructor(broadcast: (msg: WsMessage) => void, db: Database | null)

  // Public API
  enqueue(command: string): Job          // creates job, adds to queue, calls _drainQueue
  cancel(jobId: string): void            // queued: remove; running: kill
  pause(): void
  resume(): void
  reorder(jobIds: string[]): void
  getJobs(): Job[]
  getActiveJobId(): string | null
  isPaused(): boolean
  getLogBuffer(): LogMessage[]           // delegates to internal log buffer

  // Private
  private _drainQueue(): void            // starts next job if conditions met
  private _startJob(jobId: string): void // spawns process, wires events
  private _onJobExit(jobId: string, code: number | null): void
  private _kill(jobId: string): void     // SIGTERM + 5s SIGKILL fallback
  private _broadcastQueueState(): void   // sends 'queue' WsMessage
  private _persistJob(job: Job): void    // writes to SQLite if available
}
```

### Kill sequence

```
_kill(jobId):
  1. Send SIGTERM to _activeProcess
  2. Start 5s timer (_killTimer)
  3. On process close (before timer): clearTimeout(_killTimer), _onJobExit(jobId, code)
  4. On timer fires: send SIGKILL, set _killTimer = null
     (process close event will fire, _onJobExit handles it)
```

The `tree-kill` package (already present in `node_modules` per the glob scan) is used to kill the entire process tree, not just the top-level `claude` process. This prevents orphaned agent subprocess chains.

### Log buffer scoping

The existing in-memory log buffer is retained as-is (global 5000-line circular buffer). Log messages retain their `processId` field (now equal to `jobId`). Clients can filter the log stream by `processId` to see only lines for a specific job.

No per-job log buffer scoping is added in this change — that is a future optimization. The global buffer is sufficient for the expected use case.

---

## WebSocket Protocol Extensions

### New message type: `queue`

```typescript
interface QueueMessage {
  type: 'queue'
  jobs: Job[]           // all non-archived jobs
  activeJobId: string | null
  paused: boolean
  timestamp: string
}
```

Broadcast on every queue state change: enqueue, dequeue, cancel, pause, resume, reorder, job status change.

### Modified message type: `init`

The existing `init` message gains a `queue` field:

```typescript
interface InitMessage {
  type: 'init'
  projectName: string
  phases: Record<PhaseName, PhaseState>
  logBuffer: LogMessage[]
  queue: {              // NEW
    jobs: Job[]
    activeJobId: string | null
    paused: boolean
  }
}
```

### New type: `Job`

```typescript
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface Job {
  id: string
  command: string
  status: JobStatus
  queuePosition: number | null   // null for non-queued jobs
  startedAt: string | null       // ISO 8601, null if not yet started
  finishedAt: string | null
  exitCode: number | null
}
```

---

## Phase State Scoping

Currently `hooks.ts` holds a single shared phase state object. When a new job starts, `resetPhases()` is called to clear it. This behavior is preserved — the phase state in `hooks.ts` always reflects the **currently running job's** pipeline progress.

No change to the reset mechanism is required. The `QueueManager._startJob()` calls `resetPhases(broadcast)` before spawning, exactly as `spawnClaude` did before.

The UI implication: when a queued job starts running, the PipelineSidebar resets to all-idle. This is correct and expected.

---

## UI Design

### JobQueueSidebar component (new)

```
┌─────────────────────────────────────────┐
│ QUEUE                          [Pause]  │
├─────────────────────────────────────────┤
│ ● running  /implement #41     [Kill]    │
│   architect ► developer                 │
├─────────────────────────────────────────┤
│ #2 queued  /implement #42               │
│ #3 queued  /implement #43               │
│ ✓ completed /implement #40 2m ago      │
└─────────────────────────────────────────┘
```

- Running job: yellow pulse dot, "Kill" button (calls `DELETE /api/jobs/:id`)
- Queued job: gray dot, queue position badge (#2, #3...)
- Completed: green check, elapsed time
- Failed: red X, exit code
- Canceled: dim gray dash

The "Kill" button is only shown for the running job. Queued jobs have a small "×" dismiss button that calls `DELETE /api/jobs/:id`.

The "Pause" / "Resume" toggle calls `POST /api/queue/pause` or `POST /api/queue/resume`.

### CommandInput modifications

The error handling for 409 is removed. Instead:
- Response 202: clear input, show brief `"Queued (position N)"` confirmation that fades after 2s
- Response 400 (claude not found): unchanged — show error message
- The button text changes from "Run" to "Queue" to reflect the new semantics

### PipelineSidebar modifications

No structural change. The sidebar continues showing the four phases for the currently running job. The phase state is always scoped to the running job, reset on each new job start. No change needed in `PipelineSidebar.tsx`.

### usePipeline hook modifications

`usePipeline` currently returns `{ phases, projectName, logLines, connectionStatus }`. It gains:

```typescript
// added to return
queue: {
  jobs: Job[]
  activeJobId: string | null
  paused: boolean
}
```

The hook processes the new `queue` WsMessage type and the `queue` field in `init`.

### App.tsx layout modifications

The left column (currently: PipelineSidebar + CommandInput) is reorganized:

```
Left column (flex-column):
  ├── JobQueueSidebar (flex: 1, scrollable)
  └── CommandInput (fixed height, bottom)
```

`PipelineSidebar` is folded into `JobQueueSidebar` as a sub-section showing the active job's pipeline phases. Or, alternatively, kept as a separate section above the job list. The simpler approach is to keep `PipelineSidebar` separate and show it only when `activeJobId !== null`.

**Design decision**: Keep `PipelineSidebar` as a separate component above `JobQueueSidebar` in the left column. This avoids re-rendering the phase list inside every job card and keeps the two concerns decoupled. The left column becomes a three-zone flex column: `PipelineSidebar` (top, fixed height), `JobQueueSidebar` (middle, flex: 1, scrollable), `CommandInput` (bottom, fixed height).

---

## Migration from spawner.ts

The public API exported from `spawner.ts` that `index.ts` consumes:

| Current (spawner.ts) | New (queue-manager.ts) |
|---|---|
| `spawnClaude(command, broadcast, onResetPhases)` | `queueManager.enqueue(command)` |
| `isSpawnActive()` | `queueManager.getActiveJobId() !== null` |
| `getLogBuffer()` | `queueManager.getLogBuffer()` |
| `SpawnBusyError` | Removed (no longer thrown) |
| `SpawnHandle` | Replaced by `Job` |

`index.ts` imports `QueueManager` and instantiates it once at startup. The `POST /api/spawn` route calls `queueManager.enqueue(command)` instead of `spawnClaude(...)`.

---

## Error Handling

| Scenario | Server behavior | Client behavior |
|---|---|---|
| claude not on PATH at enqueue time | `enqueue()` throws `ClaudeNotFoundError`; job is not created; 400 returned | CommandInput shows error message |
| claude not on PATH at dequeue time | `_startJob()` catches error; job status set to `failed`; `queue` broadcast sent | JobQueueSidebar shows job as failed |
| Kill on already-terminal job | 409 returned | UI should have already removed Kill button; defensive handling |
| Reorder with mismatched IDs | 400 returned | UI prevents reorder if IDs do not match |
| DB unavailable (SQLite not set up) | Queue operates in-memory; no startup restore | No difference in normal operation |

---

## Edge Cases

1. **Server restart with queued jobs**: If SQLite is available, queued jobs are restored and auto-drain resumes (unless paused). If SQLite is unavailable, the queue is lost on restart — this is the same behavior as the MVP.

2. **Kill during SIGTERM window**: If SIGKILL is sent and the process still does not exit (extremely rare — zombie process), the `close` event fires eventually and normal cleanup occurs. The 5s timer is cleared when `close` fires regardless.

3. **Enqueue during kill**: A new job can be enqueued while a kill is in progress. The new job goes to `queued` state. It will start after the kill completes and `_onJobExit` triggers `_drainQueue`.

4. **Pause + running job finishes**: When a running job finishes and the queue is paused, `_drainQueue` exits early without starting the next job. The job remains `queued`. Paused state is preserved in SQLite.

5. **Reorder races**: `PUT /api/queue/reorder` is synchronous and validates the full jobId set before applying. If the running job finishes between the client's read and the reorder write, the validation will catch the now-gone jobId (it will have moved to completed/failed status) and the client must re-fetch.

6. **Empty reorder body**: A `jobIds: []` is valid when there are no queued jobs — returns 200.

---

## Files Changed Summary

### New files

| Path | Description |
|---|---|
| `templates/web-manager/server/queue-manager.ts` | QueueManager class |
| `templates/web-manager/server/queue-manager.test.ts` | Unit tests for QueueManager |
| `templates/web-manager/client/src/components/JobQueueSidebar.tsx` | Queue UI component |
| `templates/web-manager/client/src/hooks/useQueue.ts` | Queue state hook |

### Modified files

| Path | Change description |
|---|---|
| `templates/web-manager/server/types.ts` | Add Job, JobStatus, QueueMessage, modify InitMessage |
| `templates/web-manager/server/index.ts` | New routes, import QueueManager, remove spawner import |
| `templates/web-manager/server/hooks.ts` | No structural change needed (resetPhases API is stable) |
| `templates/web-manager/client/src/hooks/usePipeline.ts` | Add queue field to return value |
| `templates/web-manager/client/src/components/CommandInput.tsx` | Remove 409 handling, add 202 queue confirmation |
| `templates/web-manager/client/src/App.tsx` | Add JobQueueSidebar to left column |

### Deleted files

| Path | Reason |
|---|---|
| `templates/web-manager/server/spawner.ts` | Logic absorbed into queue-manager.ts |
| `templates/web-manager/server/spawner.test.ts` | Replaced by queue-manager.test.ts |
| `templates/web-manager/server/index.test.ts` | Must be rewritten for new route signatures |

---

## Design Decisions and Rationale

### Why a QueueManager class rather than module-level state

The original `spawner.ts` used module-level variables (`activeProcess`, `logBuffer`). This works for single-process state but becomes unmaintainable when state includes a queue array, pause flag, kill timer, and multi-job records simultaneously. A class with private fields encapsulates the invariants (e.g., `_activeJobId !== null` iff `_activeProcess !== null`) and makes unit testing straightforward via constructor injection.

### Why 202 Accepted instead of 200 for POST /api/spawn

The job may not have started yet — it could be queued behind other jobs. HTTP 202 Accepted is the semantically correct status for "request received, work will happen eventually." This also signals to future API clients that they should poll or subscribe for completion rather than assuming the work is done.

### Why tree-kill for process termination

The `claude` process spawns child processes (agent subprocesses, tool runners). Sending SIGTERM only to the top-level PID leaves orphaned children consuming CPU. `tree-kill` sends the signal to the entire process group, ensuring clean teardown. The package is already present in `node_modules`.

### Why keep the global log buffer rather than per-job buffers

Per-job log buffers would enable clean "show me only job X logs" filtering, but they require either (a) storing all logs in memory forever or (b) evicting old job logs. The current 5000-line global circular buffer with `processId` tagging is sufficient: the UI can filter client-side, and old job logs from SQLite (in #57) will be the authoritative source for historical access. Adding per-job buffers now would be premature optimization.

### Why not allow concurrent job execution

The pipeline phases (architect → developer → reviewer → ship) use shared Claude Code hooks that post to a single `/hooks/events` endpoint. There is no job scoping in the hook payload. Running two jobs concurrently would produce interleaved phase state with no way to attribute a phase event to a job. Strict sequential execution preserves the invariant that phase state always describes the currently running job.
