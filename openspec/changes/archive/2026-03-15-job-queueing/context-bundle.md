---
change: job-queueing
type: context-bundle
---

# Context Bundle: Job Queueing & Parallel Execution Management

## What You Are Building

You are replacing the web-manager's single-process hard-reject model with a job queue. Today, submitting a command while one is running returns 409 and the command is lost. After this change, submitted commands are queued sequentially — one runs at a time, the next auto-starts when the current finishes. You are also adding a kill button for running jobs.

The core change is replacing `spawner.ts` (a module with a single `activeProcess` variable) with a `QueueManager` class that owns the full job lifecycle. The client gains a `JobQueueSidebar` component that shows all jobs with their statuses.

---

## Files to Change

| Path | Change type | Notes |
|---|---|---|
| `server/types.ts` | Modify | Add Job, JobStatus, QueueMessage; extend InitMessage |
| `server/queue-manager.ts` | Create (NEW) | QueueManager class — the core of this change |
| `server/index.ts` | Modify | Import QueueManager; add 4 new routes; update spawn route; update init msg |
| `server/hooks.ts` | No change | resetPhases() API is stable; QueueManager calls it directly |
| `server/spawner.ts` | Delete | Logic moves to queue-manager.ts |
| `server/spawner.test.ts` | Delete | Replaced by queue-manager.test.ts |
| `server/queue-manager.test.ts` | Create (NEW) | Unit tests for QueueManager |
| `server/index.test.ts` | Rewrite | New route signatures |
| `client/src/components/JobQueueSidebar.tsx` | Create (NEW) | Queue list UI |
| `client/src/hooks/useQueue.ts` | Create (NEW) | API call helpers |
| `client/src/hooks/usePipeline.ts` | Modify | Add queueState to return value |
| `client/src/components/CommandInput.tsx` | Modify | Remove 409 handling; add 202 confirmation; rename button |
| `client/src/App.tsx` | Modify | Add JobQueueSidebar to left column |
| `package.json` | Modify | Add tree-kill, @types/tree-kill |

### Do NOT modify

| Path | Reason |
|---|---|
| `server/hooks.ts` | No change needed — resetPhases() signature is stable |
| `client/src/components/PipelineSidebar.tsx` | No change — still shows phases for current job |
| `client/src/hooks/useWebSocket.ts` | No change — WebSocket infrastructure is unchanged |
| `client/src/components/LogStream.tsx` | No change — log display is unchanged |
| `client/src/components/AgentActivity.tsx` | No change |

---

## Current State

### server/spawner.ts — the module being replaced

Key facts to understand before deleting it:
- Module-level `activeProcess: ChildProcess | null` — tracks the one active process
- `spawnClaude(command, broadcast, onResetPhases)` — spawns, calls onResetPhases(), streams stdout/stderr as `log` WsMessages
- `isSpawnActive()` — boolean check used by `GET /api/state`
- `getLogBuffer()` — returns copy of circular buffer (max 5000 lines, drops 1000 when full)
- Throws `SpawnBusyError` when called while active (this is the behavior being replaced)

The log buffer behavior (5000 max, 1000 drop) MUST be preserved exactly in `queue-manager.ts`. The `processId` field on `LogMessage` currently equals a UUID generated per spawn — after this change it equals the `jobId`.

### server/index.ts — the route file being updated

Current `POST /api/spawn` route (lines 81–105): catches `ClaudeNotFoundError` → 400, `SpawnBusyError` → 409. After the change: remove `SpawnBusyError` handling, change `res.json()` to `res.status(202).json()`, change response body.

Current `GET /api/state` (lines 107–113): returns `busy: isSpawnActive()`. After: `busy: queueManager.getActiveJobId() !== null`.

Current WS `init` message (lines 65–71): no `queue` field. Must add.

### server/types.ts — current shape

```typescript
// Currently exported:
PhaseName, PhaseState, LogMessage, PhaseMessage, InitMessage, WsMessage, SpawnHandle,
ClaudeNotFoundError, SpawnBusyError
```

After this change: add `JobStatus`, `Job`, `QueueMessage`; extend `InitMessage` with `queue`; extend `WsMessage` with `QueueMessage`. Keep `SpawnHandle` until spawner.ts is deleted (Task 3), then remove it.

### client/src/hooks/usePipeline.ts — current return value

```typescript
return { phases, projectName, logLines, connectionStatus }
```

After: `return { phases, projectName, logLines, connectionStatus, queueState }`.

The `handleMessage` switch currently handles `init`, `phase`, `log`. Add a branch for `queue`.

### client/src/components/CommandInput.tsx — current error handling

```typescript
const msg = (body as { error?: string }).error ?? (res.status === 409 ? 'A process is already running' : 'Failed to start process')
setErrorMessage(msg)
```

The `409` branch is removed entirely. The `res.ok` check changes to `res.status === 202`.

---

## Exact Changes

### 1. server/types.ts additions

After the existing `WsMessage` union (line 26), add:

```typescript
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface Job {
  id: string
  command: string
  status: JobStatus
  queuePosition: number | null
  startedAt: string | null
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
  queue: {
    jobs: Job[]
    activeJobId: string | null
    paused: boolean
  }
}
```

Modify `WsMessage`:

```typescript
export type WsMessage = LogMessage | PhaseMessage | InitMessage | QueueMessage
```

### 2. server/queue-manager.ts — structure

The file must export:
- `QueueManager` class (default export or named)
- `ClaudeNotFoundError` class
- `JobNotFoundError` class
- `JobAlreadyTerminalError` class

The constructor signature: `constructor(broadcast: (msg: WsMessage) => void, db?: any)`

Import `resetPhases` from `./hooks` inside `_startJob` to avoid circular dependency:
```typescript
import { resetPhases } from './hooks'
```

Import `treeKill` (the `tree-kill` package exports a default function):
```typescript
import treeKill from 'tree-kill'
```

The log buffer lives at module level in `queue-manager.ts` (same pattern as `spawner.ts`):
```typescript
const LOG_BUFFER_MAX = 5000
const LOG_BUFFER_DROP = 1000
const logBuffer: LogMessage[] = []

function appendToBuffer(msg: LogMessage): void {
  logBuffer.push(msg)
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.splice(0, LOG_BUFFER_DROP)
  }
}
```

The `getLogBuffer()` public method returns `[...logBuffer]`.

### 3. server/index.ts — minimal diff description

Remove these imports:
```typescript
import { spawnClaude, isSpawnActive, getLogBuffer } from './spawner'
import { ClaudeNotFoundError, SpawnBusyError } from './types'
```

Add these imports:
```typescript
import { QueueManager, ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError } from './queue-manager'
```

After `const clients = new Set<WebSocket>()` and the `broadcast` function definition, add:
```typescript
const queueManager = new QueueManager(broadcast)
```

The `broadcast` function must be defined BEFORE `new QueueManager(broadcast)` — it already is in the current file.

### 4. client/src/hooks/usePipeline.ts additions

Add to the existing `handleMessage` callback (after the `'log'` branch):

```typescript
} else if (msg.type === 'queue') {
  setQueueState({
    jobs: (msg.jobs as Job[]) ?? [],
    activeJobId: (msg.activeJobId as string | null) ?? null,
    paused: (msg.paused as boolean) ?? false,
  })
}
```

Modify the `'init'` branch to also set queue state:
```typescript
if (msg.type === 'init') {
  setProjectName((msg.projectName as string) ?? '')
  setPhases((msg.phases as PhaseMap) ?? INITIAL_PHASES)
  const buf = (msg.logBuffer as LogLine[]) ?? []
  setLogLines(buf)
  const q = msg.queue as QueueState | undefined
  if (q) setQueueState(q)
}
```

---

## Existing Patterns to Follow

### Error class pattern (from types.ts)

```typescript
export class ClaudeNotFoundError extends Error {
  constructor() {
    super('claude binary not found')
    this.name = 'ClaudeNotFoundError'
  }
}
```

Use the same pattern for `JobNotFoundError` and `JobAlreadyTerminalError`.

### State broadcast pattern (from hooks.ts)

```typescript
broadcast({
  type: 'phase',
  phase: agent,
  state: newState,
  timestamp: new Date().toISOString(),
})
```

Use the same pattern for `QueueMessage` broadcasts.

### Process spawn pattern (from spawner.ts)

```typescript
const args = ['--dangerously-skip-permissions', ...command.trim().split(/\s+/)]
const child = spawn('claude', args, {
  env: process.env,
  shell: false,
})
```

Copy this exactly into `_startJob`. The `--dangerously-skip-permissions` flag is always first, always present.

### Readline stream pattern (from spawner.ts)

```typescript
const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })
stdoutReader.on('line', (line) => emitLine('stdout', line))
stderrReader.on('line', (line) => emitLine('stderr', line))
```

Copy this pattern into `_startJob`. The `emitLine` function in the queue-manager context should call `appendToBuffer(msg)` and `_broadcast(msg)`.

### Test isolation pattern (from spawner.test.ts)

The spawner tests use `vi.resetModules()` in `beforeEach` to get a fresh module state. The `QueueManager` is a class so this is not needed — create a fresh instance in each `beforeEach` instead:

```typescript
let qm: QueueManager
let broadcast: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetAllMocks()
  broadcast = vi.fn()
  qm = new QueueManager(broadcast)
})
```

---

## Conventions Checklist

- [ ] TypeScript `strict` mode — no implicit `any` in new files
- [ ] All new error classes extend `Error` with `.name` set
- [ ] `broadcast` is always passed to `QueueManager` at construction time — never stored as a module global
- [ ] `processId` field on `LogMessage` equals `jobId` (not a separate UUID)
- [ ] `--dangerously-skip-permissions` is always the first arg in the spawn args array
- [ ] `shell: false` is always passed to `spawn()`
- [ ] `tree-kill` is used for process termination (not `process.kill` on the child PID)
- [ ] Client-side types are duplicated locally — do NOT import types from server in client code
- [ ] HTTP 202 (not 200) for accepted-but-queued spawn responses
- [ ] `_queue` maintains insertion order (push to end, shift from front)

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Kill timer leaks if server process exits mid-kill | Low | Low | `clearTimeout` in `_onJobExit` handles this |
| Race condition: cancel called on job that just finished | Medium | Low | Check status inside `cancel()` before acting; throw `JobAlreadyTerminalError` if terminal |
| `tree-kill` not finding the PID because process already exited | Low | Low | `tree-kill` is a no-op on non-existent PIDs |
| `reorder()` called while job is finishing (race) | Low | Low | `reorder()` only operates on `queued` jobs; if a queued job transitions to running mid-call, the validation will pass (it no longer appears in queued set) and the job won't be in the reorder result |
| SQLite not available (#57 not shipped) | High (for now) | Low | Queue runs in-memory; all behavior works except startup restore |
| Existing `index.test.ts` tests fail after route signature change | Certain | Medium | Rewrite them in Task 4 before declaring done |

---

## API Reference

### tree-kill usage

```typescript
import treeKill from 'tree-kill'
// treeKill(pid: number, signal: string, callback?: (err?: Error) => void): void
treeKill(child.pid!, 'SIGTERM')
treeKill(child.pid!, 'SIGKILL')
```

Package is already in `node_modules`. Add to `package.json` dependencies:
```json
"tree-kill": "^1.2.2"
```
And to devDependencies:
```json
"@types/tree-kill": "^1.2.3"
```

### better-sqlite3 (for optional DB integration)

The queue-manager does not need to import `better-sqlite3` directly. Accept `db: any` as a constructor parameter and use duck typing for SQL calls. This avoids a hard dependency until #57 ships. The methods needed:
```typescript
db.prepare(sql).run(params)   // for INSERT/UPDATE
db.prepare(sql).all(params)   // for SELECT returning array
```
