---
change: job-queueing
type: tasks
---

# Tasks: Job Queueing & Parallel Execution Management

Tasks are ordered by dependency. Each task has a layer tag, files involved, acceptance criteria, and explicit dependencies.

Layer tags:
- `[server]` — Node.js server code (TypeScript)
- `[client]` — React frontend code (TypeScript/TSX)
- `[tests]` — Test files

---

## Task 1 — Extend types.ts with queue types [server]

**Description:** Add the new type definitions required by the queue system to `types.ts`. This is a pure type-addition step with no logic changes. All subsequent tasks depend on these types being available.

**Files:**
- Modify: `templates/web-manager/server/types.ts`

**Additions:**

```typescript
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface Job {
  id: string
  command: string
  status: JobStatus
  queuePosition: number | null   // null for running and terminal jobs
  startedAt: string | null       // ISO 8601
  finishedAt: string | null
  exitCode: number | null
}

export interface QueueMessage {
  type: 'queue'
  jobs: Job[]
  activeJobId: string | null
  paused: boolean
  timestamp: string
}
```

Modify `InitMessage` to add the `queue` field:

```typescript
export interface InitMessage {
  type: 'init'
  projectName: string
  phases: Record<PhaseName, PhaseState>
  logBuffer: LogMessage[]
  queue: {                       // NEW
    jobs: Job[]
    activeJobId: string | null
    paused: boolean
  }
}
```

Modify `WsMessage` union to add `QueueMessage`:

```typescript
export type WsMessage = LogMessage | PhaseMessage | InitMessage | QueueMessage
```

Remove (defer to after queue-manager is built):
- `SpawnHandle` interface — keep for now (spawner.ts still references it); it will be removed in Task 3 when spawner.ts is deleted

**Acceptance criteria:**
- All new types are exported with no TypeScript errors
- `WsMessage` union includes `QueueMessage`
- `InitMessage` has the `queue` field
- Existing types are unchanged (no regressions)

**Dependencies:** None (start here in parallel with Task 2)

---

## Task 2 — Implement QueueManager class [server]

**Description:** Create `templates/web-manager/server/queue-manager.ts` implementing the `QueueManager` class. This is the largest single task — it replaces all of `spawner.ts` and adds queue management logic.

**Files:**
- Create: `templates/web-manager/server/queue-manager.ts`

**Implementation requirements:**

### Constructor

```typescript
constructor(broadcast: (msg: WsMessage) => void, db?: Database | null)
```

- `db` is optional (`null` by default); when provided, the queue uses it for persistence
- On construction: set `_queue = []`, `_jobs = new Map()`, `_activeProcess = null`, `_activeJobId = null`, `_paused = false`, `_killTimer = null`
- Call `_restoreFromDb()` if `db` is non-null

### enqueue(command: string): Job

- Validate `claude` is on PATH using `execSync('which claude', { stdio: 'ignore' })`; throw `ClaudeNotFoundError` if not found
- Generate `id = uuidv4()`
- Create job: `{ id, command, status: 'queued', queuePosition: _queue.length + 1, startedAt: null, finishedAt: null, exitCode: null }`
- Add to `_jobs` map and push `id` to `_queue`
- Call `_persistJob(job)` if db available
- Call `_broadcastQueueState()`
- Call `_drainQueue()`
- Return the created job

### cancel(jobId: string): 'canceled' | 'canceling'

- If not in `_jobs`, throw `JobNotFoundError`
- If job status is terminal (`completed | failed | canceled`), throw `JobAlreadyTerminalError`
- If job is `queued`: remove from `_queue`, update status to `canceled`, persist, broadcast, return `'canceled'`
- If job is `running`: call `_kill(jobId)`, return `'canceling'` (final state arrives via process exit)

### pause(): void

Sets `_paused = true`. Persists to SQLite `queue_state` if db available. Broadcasts queue state.

### resume(): void

Sets `_paused = false`. Persists to SQLite. Broadcasts queue state. Calls `_drainQueue()`.

### reorder(jobIds: string[]): void

- Validate that `jobIds` is exactly the set of job IDs currently in `queued` state (set equality, no order assumption)
- Replace `_queue` with `jobIds`
- Update `queuePosition` for each job in `_jobs` map
- Persist updated positions if db available
- Broadcast queue state

### getJobs(): Job[]

Returns `Array.from(_jobs.values())`.

### getActiveJobId(): string | null

Returns `_activeJobId`.

### isPaused(): boolean

Returns `_paused`.

### getLogBuffer(): LogMessage[]

Returns the global log buffer copy (same as `spawner.ts`'s `getLogBuffer()`). Keep the same 5000-line circular buffer, 1000-drop behavior, as a module-level variable in `queue-manager.ts`.

### _drainQueue() (private)

```
if (_activeJobId !== null) return   // something is running
if (_paused) return                 // paused
if (_queue.length === 0) return     // nothing to start
const nextJobId = _queue.shift()
_startJob(nextJobId)
```

### _startJob(jobId: string) (private)

```
1. Get job from _jobs
2. Update job: status = 'running', startedAt = now, queuePosition = null
3. Recompute queuePosition for remaining queued jobs (1, 2, 3...)
4. Persist
5. Call resetPhases(broadcast) — imported from hooks.ts
6. Build args: ['--dangerously-skip-permissions', ...command.trim().split(/\s+/)]
7. _activeProcess = spawn('claude', args, { env: process.env, shell: false })
8. _activeJobId = jobId
9. Attach readline to stdout and stderr (same as spawner.ts)
10. Emit each line as LogMessage with processId = jobId, append to logBuffer, broadcast
11. On child 'close': call _onJobExit(jobId, code)
12. Broadcast queue state
```

### _onJobExit(jobId: string, code: number | null) (private)

```
1. Clear _killTimer if set
2. Determine status: code === 0 → 'completed', code === null or non-zero → 'failed'
   Special case: if job was previously canceled (cancel() called): status = 'canceled'
3. Update job: status, finishedAt = now, exitCode = code
4. _activeProcess = null, _activeJobId = null
5. Persist
6. Emit exit log line: "[process exited with code X]"
7. Broadcast queue state
8. Call _drainQueue()
```

### _kill(jobId: string) (private)

```
1. Import treeKill from 'tree-kill'
2. treeKill(_activeProcess.pid!, 'SIGTERM')
3. Mark job as 'canceling' internally (a flag, not a JobStatus value — use a private Set _cancelingJobs)
4. _killTimer = setTimeout(() => {
     treeKill(_activeProcess.pid!, 'SIGKILL')
     _killTimer = null
   }, 5000)
```

### _broadcastQueueState() (private)

Broadcasts a `QueueMessage` with current `_jobs`, `_activeJobId`, `_paused`.

### _persistJob(job: Job) (private)

If `_db` is null, return immediately. Otherwise upsert the job row into SQLite.

### _restoreFromDb() (private)

```
1. UPDATE jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'
2. SELECT * FROM jobs WHERE status = 'queued' ORDER BY queue_position ASC
3. For each row: add to _jobs map and push id to _queue
4. SELECT value FROM queue_state WHERE key = 'paused'
5. Set _paused accordingly
```

### Error classes to export

```typescript
export class ClaudeNotFoundError extends Error { ... }  // same as spawner.ts
export class JobNotFoundError extends Error { ... }
export class JobAlreadyTerminalError extends Error { ... }
```

**package.json addition:** Add `tree-kill` to dependencies (it is already in node_modules, just needs to be in package.json):
```json
"tree-kill": "^1.2.2"
```
Add `@types/tree-kill` to devDependencies.

**Acceptance criteria:**
- `enqueue()` adds to queue and triggers `_drainQueue()`
- `cancel()` on queued job removes from queue and broadcasts
- `cancel()` on running job sends SIGTERM and starts 5s timer
- `pause()` / `resume()` toggle queue drain
- `reorder()` reorders the queue and validates ID set
- `_drainQueue()` starts the next job only when conditions are met
- `getLogBuffer()` returns a copy of the circular buffer
- TypeScript compiles without errors
- `ClaudeNotFoundError`, `JobNotFoundError`, `JobAlreadyTerminalError` are exported

**Dependencies:** Task 1 (types must exist)

---

## Task 3 — Rewrite index.ts to use QueueManager [server]

**Description:** Update `templates/web-manager/server/index.ts` to replace `spawner.ts` imports with `QueueManager`, add the four new routes, update `POST /api/spawn`, and update the `init` WebSocket message.

**Files:**
- Modify: `templates/web-manager/server/index.ts`
- Delete: `templates/web-manager/server/spawner.ts` (after this task compiles and tests pass)

**Changes to index.ts:**

1. Remove imports from `./spawner`. Add:
   ```typescript
   import { QueueManager, ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError } from './queue-manager'
   ```

2. Instantiate QueueManager after CLI arg parsing:
   ```typescript
   const queueManager = new QueueManager(broadcast)
   // db integration deferred to #57
   ```

3. Update `POST /api/spawn`:
   ```typescript
   app.post('/api/spawn', (req, res) => {
     const { command } = req.body ?? {}
     if (!command || typeof command !== 'string' || !command.trim()) {
       res.status(400).json({ error: 'command is required' })
       return
     }
     try {
       const job = queueManager.enqueue(command)
       const position = job.queuePosition ?? 0
       res.status(202).json({ jobId: job.id, position })
     } catch (err) {
       if (err instanceof ClaudeNotFoundError) {
         res.status(400).json({ error: err.message })
       } else {
         console.error('[spawn] unexpected error:', err)
         res.status(500).json({ error: 'Internal server error' })
       }
     }
   })
   ```

4. Add `DELETE /api/jobs/:id`:
   ```typescript
   app.delete('/api/jobs/:id', (req, res) => {
     try {
       const result = queueManager.cancel(req.params.id)
       res.json({ ok: true, status: result })
     } catch (err) {
       if (err instanceof JobNotFoundError) {
         res.status(404).json({ error: 'Job not found' })
       } else if (err instanceof JobAlreadyTerminalError) {
         res.status(409).json({ error: 'Job is already in terminal state' })
       } else {
         res.status(500).json({ error: 'Internal server error' })
       }
     }
   })
   ```

5. Add `POST /api/queue/pause`:
   ```typescript
   app.post('/api/queue/pause', (_req, res) => {
     queueManager.pause()
     res.json({ ok: true, paused: true })
   })
   ```

6. Add `POST /api/queue/resume`:
   ```typescript
   app.post('/api/queue/resume', (_req, res) => {
     queueManager.resume()
     res.json({ ok: true, paused: false })
   })
   ```

7. Add `PUT /api/queue/reorder`:
   ```typescript
   app.put('/api/queue/reorder', (req, res) => {
     const { jobIds } = req.body ?? {}
     if (!Array.isArray(jobIds)) {
       res.status(400).json({ error: 'jobIds must be an array' })
       return
     }
     try {
       queueManager.reorder(jobIds)
       res.json({ ok: true, queue: jobIds })
     } catch (err) {
       res.status(400).json({ error: (err as Error).message })
     }
   })
   ```

8. Add `GET /api/queue`:
   ```typescript
   app.get('/api/queue', (_req, res) => {
     res.json({
       jobs: queueManager.getJobs(),
       paused: queueManager.isPaused(),
       activeJobId: queueManager.getActiveJobId(),
     })
   })
   ```

9. Update `GET /api/state`:
   ```typescript
   app.get('/api/state', (_req, res) => {
     res.json({
       projectName,
       phases: getPhaseStates(),
       busy: queueManager.getActiveJobId() !== null,
     })
   })
   ```

10. Update the `wss.on('connection')` init message to include `queue`:
    ```typescript
    const initMsg: WsMessage = {
      type: 'init',
      projectName,
      phases: getPhaseStates(),
      logBuffer: queueManager.getLogBuffer().slice(-500),
      queue: {
        jobs: queueManager.getJobs(),
        activeJobId: queueManager.getActiveJobId(),
        paused: queueManager.isPaused(),
      },
    }
    ```

**Acceptance criteria:**
- `POST /api/spawn` returns HTTP 202 with `{ jobId, position }`
- `DELETE /api/jobs/:id` routes exist and return correct status codes
- `POST /api/queue/pause` and `/resume` work
- `PUT /api/queue/reorder` works
- `GET /api/queue` returns current queue state
- `GET /api/state` still returns `busy` correctly
- `init` WsMessage includes `queue` field
- TypeScript compiles without errors
- `spawner.ts` is deleted after this task is complete

**Dependencies:** Tasks 1, 2

---

## Task 4 — Rewrite server tests for new routes [tests]

**Description:** Delete `spawner.test.ts` and rewrite `index.test.ts` to test the new `QueueManager`-backed routes. Create `queue-manager.test.ts` with unit tests for the queue logic.

**Files:**
- Delete: `templates/web-manager/server/spawner.test.ts`
- Create: `templates/web-manager/server/queue-manager.test.ts`
- Rewrite: `templates/web-manager/server/index.test.ts`

### queue-manager.test.ts

Test the following behaviors (mock `child_process.spawn`, `child_process.execSync`, `uuid`, `tree-kill`):

1. `enqueue()` returns a job with `status: 'queued'` when a process is already running
2. `enqueue()` returns a job with `status: 'running'` when queue is empty (auto-drains)
3. `enqueue()` throws `ClaudeNotFoundError` when claude is not on PATH
4. `cancel()` on a queued job removes it and broadcasts queue state
5. `cancel()` on a running job calls `treeKill` with SIGTERM and returns `'canceling'`
6. `cancel()` on a non-existent ID throws `JobNotFoundError`
7. `cancel()` on a completed job throws `JobAlreadyTerminalError`
8. `pause()` prevents `_drainQueue()` from starting the next job
9. `resume()` calls `_drainQueue()` and starts the next job if one is queued
10. `reorder()` reorders the queue array
11. `reorder()` throws when jobIds do not match queued set
12. Job transitions to `completed` when process exits with code 0
13. Job transitions to `failed` when process exits with non-zero code
14. `getLogBuffer()` returns log lines accumulated during job execution
15. Multiple jobs queued: second job starts when first job's process emits `close`
16. Kill timer fires SIGKILL after 5s if process does not exit (mock `setTimeout`)

### index.test.ts (rewritten)

Test the HTTP routes by instantiating the same test app pattern as before but with mocked `QueueManager`:

1. `POST /api/spawn` returns 202 with `{ jobId, position }` on success
2. `POST /api/spawn` returns 400 when command missing
3. `POST /api/spawn` returns 400 when ClaudeNotFoundError thrown
4. `POST /api/spawn` does NOT return 409 (no busy rejection)
5. `DELETE /api/jobs/:id` returns 200 `{ ok: true, status: 'canceled' }` for queued job
6. `DELETE /api/jobs/:id` returns 200 `{ ok: true, status: 'canceling' }` for running job
7. `DELETE /api/jobs/:id` returns 404 for unknown id
8. `DELETE /api/jobs/:id` returns 409 for terminal job
9. `POST /api/queue/pause` returns `{ ok: true, paused: true }`
10. `POST /api/queue/resume` returns `{ ok: true, paused: false }`
11. `PUT /api/queue/reorder` returns 200 with reordered queue
12. `PUT /api/queue/reorder` returns 400 when jobIds are invalid
13. `GET /api/queue` returns queue state
14. `GET /api/state` returns `busy: true` when `activeJobId` is non-null
15. `POST /hooks/events` still works unchanged

**Acceptance criteria:**
- `npm run test` passes with all new tests
- Old spawner tests are gone (no skipped tests)
- Queue-manager unit tests cover all 16 behaviors listed
- Index integration tests cover all 15 behaviors listed
- TypeScript compiles without errors in test files

**Dependencies:** Tasks 2, 3

---

## Task 5 — Add JobQueueSidebar component [client]

**Description:** Create `templates/web-manager/client/src/components/JobQueueSidebar.tsx`. This component renders the queue list with status indicators, kill button, and pause/resume toggle.

**Files:**
- Create: `templates/web-manager/client/src/components/JobQueueSidebar.tsx`

**Props:**
```typescript
interface JobQueueSidebarProps {
  jobs: Job[]
  activeJobId: string | null
  paused: boolean
  onKill: (jobId: string) => void
  onCancel: (jobId: string) => void
  onPause: () => void
  onResume: () => void
}
```

**Rendering rules:**

1. Header row: "QUEUE" label + "Pause" or "Resume" button (calls `onPause` / `onResume`)
2. Sort jobs for display: `running` first, then `queued` (by `queuePosition`), then terminal (most recent first, max 5 shown)
3. For each job:
   - **running**: yellow pulse dot, truncated command text (max 30 chars + ellipsis), "Kill" button (calls `onKill(job.id)`)
   - **queued**: gray dot, `#N` position badge, truncated command, "×" cancel button (calls `onCancel(job.id)`)
   - **completed**: green checkmark, truncated command, elapsed time (e.g. "2m ago")
   - **failed**: red dot, truncated command, exit code
   - **canceled**: dim gray dash, truncated command

4. Use the same color system as `PipelineSidebar`: pulse animation via CSS keyframes, same dot size (10px circle)

**Client-side Job type:** Define locally (do NOT import from server):
```typescript
type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
interface Job {
  id: string
  command: string
  status: JobStatus
  queuePosition: number | null
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
}
```

**Acceptance criteria:**
- Running job renders with yellow pulse dot and Kill button
- Queued jobs render with position badge and cancel button
- Completed/failed/canceled jobs render with correct indicators
- Pause button shows when not paused; Resume button shows when paused
- Kill and cancel buttons call the correct handlers with the correct job ID
- Truncation of long commands at 30 chars
- TypeScript compiles without errors

**Dependencies:** None (can start in parallel with Task 1)

---

## Task 6 — Add useQueue hook [client]

**Description:** Create `templates/web-manager/client/src/hooks/useQueue.ts`. Thin hook that exposes queue state and the API call helpers.

**Files:**
- Create: `templates/web-manager/client/src/hooks/useQueue.ts`

**Implementation:**

```typescript
import type { Job } from '../components/JobQueueSidebar'  // local type

interface QueueState {
  jobs: Job[]
  activeJobId: string | null
  paused: boolean
}

export function useQueue(queueState: QueueState) {
  async function kill(jobId: string): Promise<void> {
    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' })
  }

  async function cancel(jobId: string): Promise<void> {
    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' })
  }

  async function pause(): Promise<void> {
    await fetch('/api/queue/pause', { method: 'POST' })
  }

  async function resume(): Promise<void> {
    await fetch('/api/queue/resume', { method: 'POST' })
  }

  return {
    jobs: queueState.jobs,
    activeJobId: queueState.activeJobId,
    paused: queueState.paused,
    kill,
    cancel,
    pause,
    resume,
  }
}
```

Note: API calls do not need to update local state — the server will broadcast a `queue` WsMessage which `usePipeline` will handle, triggering a React re-render.

**Acceptance criteria:**
- `kill`, `cancel`, `pause`, `resume` all call the correct endpoints
- TypeScript compiles without errors
- No local state mutations — all state flows through WS

**Dependencies:** Task 5 (Job type)

---

## Task 7 — Update usePipeline hook to handle queue messages [client]

**Description:** Modify `templates/web-manager/client/src/hooks/usePipeline.ts` to handle the `queue` WsMessage type and the new `queue` field in `init` messages.

**Files:**
- Modify: `templates/web-manager/client/src/hooks/usePipeline.ts`

**Changes:**

1. Add `QueueState` and `Job` types (local copies, not imported from server):
   ```typescript
   type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
   interface Job { id: string; command: string; status: JobStatus; queuePosition: number | null; startedAt: string | null; finishedAt: string | null; exitCode: number | null }
   interface QueueState { jobs: Job[]; activeJobId: string | null; paused: boolean }
   ```

2. Add `queueState` to the hook's state:
   ```typescript
   const [queueState, setQueueState] = useState<QueueState>({
     jobs: [],
     activeJobId: null,
     paused: false,
   })
   ```

3. In `handleMessage`:
   - On `type === 'init'`: extract `msg.queue` and call `setQueueState(msg.queue as QueueState)`
   - Add new branch: On `type === 'queue'`: call `setQueueState({ jobs: msg.jobs as Job[], activeJobId: msg.activeJobId as string | null, paused: msg.paused as boolean })`

4. Add `queueState` to the return value:
   ```typescript
   return { phases, projectName, logLines, connectionStatus, queueState }
   ```

**Acceptance criteria:**
- `queueState.jobs` is populated from `init` message
- `queueState` updates when `queue` messages arrive
- `queueState` is exported from the hook
- Existing return values (`phases`, `projectName`, `logLines`, `connectionStatus`) are unchanged
- TypeScript compiles without errors

**Dependencies:** None (can start in parallel with Tasks 1–4 if types are defined locally)

---

## Task 8 — Update CommandInput to handle 202 response [client]

**Description:** Modify `templates/web-manager/client/src/components/CommandInput.tsx` to remove the 409 error handling and add a temporary "Queued" confirmation message on 202 response.

**Files:**
- Modify: `templates/web-manager/client/src/components/CommandInput.tsx`

**Changes:**

1. Add state: `queuedMessage: string | null` (initially `null`)

2. Update the fetch handler in `handleRun`:
   - Change `if (res.ok)` to `if (res.status === 202)`:
     ```typescript
     if (res.status === 202) {
       const body = await res.json()
       const pos = (body as { position: number }).position
       const msg = pos === 0 ? 'Started' : `Queued (position ${pos})`
       setQueuedMessage(msg)
       setCommand('')
       setTimeout(() => setQueuedMessage(null), 2000)
     }
     ```
   - Remove the `res.status === 409` branch entirely
   - Keep the 400 error handling unchanged

3. Update button text from "Run" to "Queue"

4. Render `queuedMessage` below the input as dim green text (instead of or alongside error):
   ```typescript
   {queuedMessage && (
     <div style={{ color: '#22c55e', fontSize: 12, marginTop: 6 }}>{queuedMessage}</div>
   )}
   ```

**Acceptance criteria:**
- 202 response clears input and shows "Started" or "Queued (position N)" for 2 seconds
- 400 (ClaudeNotFoundError) still shows error message
- 409 error branch is removed entirely
- Button label is "Queue"
- TypeScript compiles without errors

**Dependencies:** None

---

## Task 9 — Update App.tsx layout to include JobQueueSidebar [client]

**Description:** Update `templates/web-manager/client/src/App.tsx` to add `JobQueueSidebar` to the left column and wire up `useQueue`.

**Files:**
- Modify: `templates/web-manager/client/src/App.tsx`

**Changes:**

1. Import `JobQueueSidebar` and `useQueue`:
   ```typescript
   import { JobQueueSidebar } from './components/JobQueueSidebar'
   import { useQueue } from './hooks/useQueue'
   ```

2. Destructure `queueState` from `usePipeline()`:
   ```typescript
   const { phases, projectName, logLines, connectionStatus, queueState } = usePipeline()
   ```

3. Call `useQueue(queueState)`:
   ```typescript
   const { jobs, activeJobId, paused, kill, cancel, pause, resume } = useQueue(queueState)
   ```

4. Update the left column layout from 2-zone (PipelineSidebar + CommandInput) to 3-zone:
   ```
   flex-direction: column, height: 100%
   ├── PipelineSidebar (phases) — flex: 0, min-height: auto
   ├── JobQueueSidebar (jobs, kill, cancel, pause, resume) — flex: 1, overflow-y: auto
   └── CommandInput — flex: 0
   ```

5. Pass props to `JobQueueSidebar`:
   ```typescript
   <JobQueueSidebar
     jobs={jobs}
     activeJobId={activeJobId}
     paused={paused}
     onKill={kill}
     onCancel={cancel}
     onPause={pause}
     onResume={resume}
   />
   ```

**Acceptance criteria:**
- Left column shows PipelineSidebar (top) + JobQueueSidebar (middle, scrollable) + CommandInput (bottom)
- `JobQueueSidebar` receives correct props and renders the queue list
- `PipelineSidebar` still receives the phase state and renders correctly
- TypeScript compiles without errors

**Dependencies:** Tasks 5, 6, 7

---

## Task 10 — End-to-end verification [tests]

**Description:** Manual verification that the full system works together after all tasks are complete.

**Files:** Read-only verification

**Steps:**

1. `npm run test` from `templates/web-manager/` — all tests pass
2. `npm run typecheck` from `templates/web-manager/` — no TypeScript errors
3. `npm run dev` — both server (port 4200) and client (port 5173) start
4. Open `http://localhost:5173` — left column shows PipelineSidebar, JobQueueSidebar (empty), and CommandInput with "Queue" button
5. Type `/implement #42` and click "Queue" — "Started" confirmation appears, then fades. Job appears as running in JobQueueSidebar.
6. While job is running, type `/implement #43` and click "Queue" — "Queued (position 1)" confirmation appears. Job appears in queue list with #1 badge.
7. Click the "Kill" button on the running job — job transitions to canceled in the UI. Previously queued job starts automatically.
8. Click "Pause" — queue pauses. Run a job, let it complete — next queued job does NOT start automatically.
9. Click "Resume" — next queued job starts immediately.
10. Run two jobs in queue, then `PUT /api/queue/reorder` via curl with reversed order — UI reorders.

**Acceptance criteria:**
- All 10 steps produce the expected result
- No TypeScript errors
- No unhandled promise rejections in browser console
- `npm run test` passes

**Dependencies:** Tasks 1–9

---

## Execution Order

```
Task 1 (types)
  └── Task 2 (QueueManager)
        └── Task 3 (index.ts)
              └── Task 4 (tests) ← also depends on QueueManager

Task 5 (JobQueueSidebar) — independent, can start in parallel
  └── Task 6 (useQueue)

Task 7 (usePipeline update) — independent

Task 8 (CommandInput update) — independent

Task 9 (App.tsx) ← depends on Tasks 5, 6, 7

Task 10 (verification) ← depends on all
```

### Minimum critical path

Server: Task 1 → Task 2 → Task 3 → Task 4

Client: Task 5 → Task 6; Task 7; Task 8 (all parallel) → Task 9

Integration: Task 4 + Task 9 → Task 10
