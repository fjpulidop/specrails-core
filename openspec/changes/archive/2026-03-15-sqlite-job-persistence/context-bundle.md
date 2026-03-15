---
change: sqlite-job-persistence
type: context-bundle
---

# Context Bundle — SQLite Job Persistence

## What You Are Building

You are adding SQLite persistence to the specrails web-manager. Today the server forgets everything on restart. After this change, every pipeline run is persisted to `data/jobs.sqlite`. The in-memory circular buffer is preserved unchanged as the real-time WebSocket hot cache. You are also upgrading the Claude CLI spawner to use structured `stream-json` output, which gives the server token/cost data per job. Four new REST endpoints expose job history and stats. The React client gains a job history panel and a stats bar.

## Files to Change

| File | Change Type | Notes |
|---|---|---|
| `server/package.json` | Modify | Add `better-sqlite3` + `@types/better-sqlite3` |
| `server/db.ts` | Create | New — all SQLite logic lives here |
| `server/types.ts` | Modify | Add `JobStatus`, `JobRow`, `EventRow`, `StatsRow`, `JobSummary`; extend `InitMessage` |
| `server/spawner.ts` | Modify | Add `db` param; switch to stream-json; write to DB per event |
| `server/hooks.ts` | Modify | Add `db` and `activeJobRef` params; persist phase transitions |
| `server/index.ts` | Modify | Init DB at startup; wire new params; add 4 new endpoints |
| `server/db.test.ts` | Create | New — unit tests for all db.ts exports |
| `server/spawner.test.ts` | Modify | Update call sites; add DB-write tests |
| `server/index.test.ts` | Modify | Update app factory; add new endpoint tests |
| `client/src/hooks/usePipeline.ts` | Modify | Handle `recentJobs` in init; expose from hook |
| `client/src/components/StatsBar.tsx` | Create | New — fetches and renders stats |
| `client/src/components/JobHistory.tsx` | Create | New — polls and renders job list |
| `client/src/App.tsx` | Modify | Add grid row for history/stats; wire new components |
| `.gitignore` | Create/Modify | Add `data/` |

**Do NOT modify:**
- `server/hooks.test.ts` — the hooks unit tests do not test DB persistence; they test in-memory state. Leave them as is.
- `client/src/components/AgentActivity.tsx`, `LogStream.tsx`, `PipelineSidebar.tsx`, `CommandInput.tsx`, `SearchBox.tsx` — no changes needed.
- `client/src/hooks/useWebSocket.ts` — no changes needed.

## Current State

### `server/spawner.ts` — key section to replace

```typescript
// Current spawn call (line 57-61)
const args = ['--dangerously-skip-permissions', ...command.trim().split(/\s+/)]
const child = spawn('claude', args, {
  env: process.env,
  shell: false,
})
```

```typescript
// Current stdout handler (line 77-81)
const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })

stdoutReader.on('line', (line) => emitLine('stdout', line))
stderrReader.on('line', (line) => emitLine('stderr', line))
```

```typescript
// Current close handler (line 83-86)
child.on('close', (code) => {
  emitLine('stdout', `[process exited with code ${code ?? 'unknown'}]`)
  activeProcess = null
})
```

```typescript
// Current function signature (line 38-42)
export function spawnClaude(
  command: string,
  broadcast: (msg: WsMessage) => void,
  onResetPhases: () => void
): SpawnHandle {
```

### `server/hooks.ts` — key section to update

```typescript
// Current createHooksRouter signature (line 40)
export function createHooksRouter(broadcast: (msg: WsMessage) => void): Router {
```

```typescript
// Current hooks route handler — phase persistence to add after line 59
phases[agent] = newState
broadcast({ type: 'phase', phase: agent, state: newState, timestamp: new Date().toISOString() })
// ADD: if (activeJobRef.current) { upsertPhase(db, activeJobRef.current, agent, newState) }
```

### `server/index.ts` — key sections to update

```typescript
// Current imports (lines 7-8)
import { createHooksRouter, getPhaseStates, resetPhases } from './hooks'
import { spawnClaude, isSpawnActive, getLogBuffer } from './spawner'
// ADD: import { initDb, listJobs, getJob, deleteJob, getStats } from './db'
```

```typescript
// Current WS init message (lines 65-70) — add recentJobs
const initMsg: WsMessage = {
  type: 'init',
  projectName,
  phases: getPhaseStates(),
  logBuffer: getLogBuffer().slice(-500),
  // ADD: recentJobs: listJobs(db, { limit: 10 }).jobs
}
```

```typescript
// Current /api/state response (line 108-113) — add currentJobId
res.json({
  projectName,
  phases: getPhaseStates(),
  busy: isSpawnActive(),
  // ADD: currentJobId: activeJobRef.current,
})
```

### `server/types.ts` — sections to extend

```typescript
// Current InitMessage (lines 19-24)
export interface InitMessage {
  type: 'init'
  projectName: string
  phases: Record<PhaseName, PhaseState>
  logBuffer: LogMessage[]
  // ADD: recentJobs: JobSummary[]
}
```

### `client/src/hooks/usePipeline.ts` — sections to update

```typescript
// Current init handler (lines 36-40) — add recentJobs
if (msg.type === 'init') {
  setProjectName((msg.projectName as string) ?? '')
  setPhases((msg.phases as PhaseMap) ?? INITIAL_PHASES)
  const buf = (msg.logBuffer as LogLine[]) ?? []
  setLogLines(buf)
  // ADD: setRecentJobs((msg.recentJobs as JobSummary[]) ?? [])
}
```

### `client/src/App.tsx` — grid to update

```typescript
// Current grid (line 6-13) — add history row
gridTemplateAreas: '"header header" "sidebar activity"',
gridTemplateColumns: '240px 1fr',
gridTemplateRows: '48px 1fr',
// Change to:
gridTemplateAreas: '"header header" "sidebar activity" "sidebar history"',
gridTemplateRows: '48px 1fr 200px',
```

## Exact Changes Needed

### `server/db.ts` — full new file

Create this file at `templates/web-manager/server/db.ts`. It must export:
- `initDb(dbPath: string): Database` — opens DB, applies migrations, runs orphan sweep
- `createJob(db, job: NewJob): void` — inserts into `jobs` table
- `finishJob(db, jobId, result: JobResult): void` — updates job row on exit
- `appendEvent(db, jobId, seq, event: AppEvent): void` — inserts into `events`
- `upsertPhase(db, jobId, phase, state): void` — INSERT OR REPLACE into `job_phases`
- `listJobs(db, opts: ListJobsOpts): { jobs: JobRow[], total: number }` — paginated SELECT
- `getJob(db, jobId): JobRow | undefined`
- `getJobEvents(db, jobId): EventRow[]`
- `deleteJob(db, jobId): void`
- `getStats(db): StatsRow`

Key implementation notes:
- `initDb` must create the `data/` directory with `fs.mkdirSync(dir, { recursive: true })` before opening the DB (except for `:memory:`).
- Use `db.prepare(...).run(...)` for writes and `db.prepare(...).get(...)` / `.all(...)` for reads — this is the better-sqlite3 synchronous API.
- The orphan sweep: `db.prepare("UPDATE jobs SET status='failed', finished_at=? WHERE status='running'").run(new Date().toISOString())`.
- `listJobs` builds a dynamic WHERE clause from the opts parameters. Use parameterized queries (`?` placeholders) — never string interpolation.
- `getStats`: use `strftime('%Y-%m-%d', started_at)` to filter `jobsToday` and `costToday`.

### `server/spawner.ts` — key replacements

**Replace the function signature:**
```typescript
export function spawnClaude(
  command: string,
  broadcast: (msg: WsMessage) => void,
  onResetPhases: () => void,
  db: Database
): SpawnHandle {
```

**Replace the spawn args line:**
```typescript
const args = [
  '--dangerously-skip-permissions',
  '--output-format', 'stream-json',
  '--verbose',
  '-p',
  ...command.trim().split(/\s+/)
]
```

**Replace the readline handlers with stream-json parsing:**

After `const processId = uuidv4()` and `const startedAt = ...`, add:
```typescript
let eventSeq = 0
let lastResultEvent: Record<string, unknown> | null = null

createJob(db, { id: processId, command, started_at: startedAt })
```

Replace `stdoutReader.on('line', ...)` with:
```typescript
stdoutReader.on('line', (line) => {
  let parsed: Record<string, unknown> | null = null
  try { parsed = JSON.parse(line) } catch { /* plain text */ }

  if (parsed) {
    const eventType = (parsed.type as string) ?? 'unknown'
    appendEvent(db, processId, eventSeq++, {
      event_type: eventType,
      source: 'stdout',
      payload: line,
    })
    if (eventType === 'result') {
      lastResultEvent = parsed
    }
    const displayText = extractDisplayText(parsed)
    if (displayText !== null) {
      emitLine('stdout', displayText)
    }
  } else {
    appendEvent(db, processId, eventSeq++, {
      event_type: 'log',
      source: 'stdout',
      payload: JSON.stringify({ line }),
    })
    emitLine('stdout', line)
  }
})
```

Add `extractDisplayText(event)` helper function:
```typescript
function extractDisplayText(event: Record<string, unknown>): string | null {
  const type = event.type as string
  if (type === 'assistant') {
    const content = event.message as { content?: Array<{ type: string; text?: string }> } | undefined
    const texts = (content?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
    return texts.join('') || null
  }
  if (type === 'tool_use') {
    const name = (event as Record<string, unknown>).name as string
    const input = JSON.stringify((event as Record<string, unknown>).input ?? {})
    return `[tool: ${name}] ${input.slice(0, 120)}`
  }
  if (type === 'tool_result' || type === 'system_prompt') {
    return null  // do not broadcast
  }
  if (type === 'result') {
    return null  // handled in close handler
  }
  return JSON.stringify(event).slice(0, 200)
}
```

**Replace the close handler:**
```typescript
child.on('close', (code) => {
  let tokenData: Partial<JobResult> = {}
  if (lastResultEvent) {
    const usage = lastResultEvent.usage as Record<string, number> | undefined
    tokenData = {
      tokens_in: usage?.input_tokens,
      tokens_out: usage?.output_tokens,
      tokens_cache_read: usage?.cache_read_input_tokens,
      tokens_cache_create: usage?.cache_creation_input_tokens,
      total_cost_usd: lastResultEvent.total_cost_usd as number | undefined,
      num_turns: lastResultEvent.num_turns as number | undefined,
      model: lastResultEvent.model as string | undefined,
      duration_ms: lastResultEvent.duration_ms as number | undefined,
      duration_api_ms: lastResultEvent.api_duration_ms as number | undefined,
      session_id: lastResultEvent.session_id as string | undefined,
    }
  }
  finishJob(db, processId, {
    exit_code: code ?? -1,
    status: code === 0 ? 'completed' : 'failed',
    ...tokenData,
  })
  const costStr = tokenData.total_cost_usd != null
    ? ` | cost: $${tokenData.total_cost_usd.toFixed(4)}`
    : ''
  emitLine('stdout', `[process exited with code ${code ?? 'unknown'}${costStr}]`)
  activeProcess = null
})
```

### `server/hooks.ts` — signature and persistence addition

**Replace signature:**
```typescript
export function createHooksRouter(
  broadcast: (msg: WsMessage) => void,
  db: Database,
  activeJobRef: { current: string | null }
): Router {
```

**After line `phases[agent] = newState` in the handler body, add:**
```typescript
if (activeJobRef.current) {
  upsertPhase(db, activeJobRef.current, agent, newState)
}
```

### `server/index.ts` — initialization and new endpoints

**After existing imports, add:**
```typescript
import Database from 'better-sqlite3'
import { initDb, listJobs, getJob, deleteJob, getStats } from './db'
```

**After `const app = express()`, add:**
```typescript
const db = initDb(path.join(process.cwd(), 'data', 'jobs.sqlite'))
const activeJobRef: { current: string | null } = { current: null }
```

**In `POST /api/spawn`, replace the spawn call section:**
```typescript
try {
  const handle = spawnClaude(
    command,
    broadcast,
    () => {
      activeJobRef.current = null
      resetPhases(broadcast)
    },
    db
  )
  activeJobRef.current = handle.processId
  res.json({ processId: handle.processId })
} catch ...
```

**Update `createHooksRouter` call:**
```typescript
app.use('/hooks', createHooksRouter(broadcast, db, activeJobRef))
```

**Update WS init message:**
```typescript
const initMsg: WsMessage = {
  type: 'init',
  projectName,
  phases: getPhaseStates(),
  logBuffer: getLogBuffer().slice(-500),
  recentJobs: listJobs(db, { limit: 10 }).jobs,
}
```

**Update `/api/state` response:**
```typescript
res.json({
  projectName,
  phases: getPhaseStates(),
  busy: isSpawnActive(),
  currentJobId: activeJobRef.current,
})
```

**Add new endpoints (after the existing routes, before `server.listen`):**
```typescript
app.get('/api/jobs', (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200)
  const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0
  const status = req.query.status as string | undefined
  const from = req.query.from as string | undefined
  const to = req.query.to as string | undefined
  const result = listJobs(db, { limit, offset, status, from, to })
  res.json(result)
})

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(db, req.params.id)
  if (!job) { res.status(404).json({ error: 'Job not found' }); return }
  const events = getJobEvents(db, req.params.id)
  res.json({ job, events })
})

app.delete('/api/jobs/:id', (req, res) => {
  const job = getJob(db, req.params.id)
  if (!job) { res.status(404).json({ error: 'Job not found' }); return }
  deleteJob(db, req.params.id)
  res.json({ ok: true })
})

app.get('/api/stats', (_req, res) => {
  res.json(getStats(db))
})
```

## Existing Patterns to Follow

- **Module-level state**: `activeProcess` in `spawner.ts` and `phases` in `hooks.ts` are module-level `let` variables. The new `activeJobRef` follows the same pattern but as an object so it can be mutated through a reference without re-import issues.
- **Error classes**: `ClaudeNotFoundError` and `SpawnBusyError` in `types.ts` follow `extends Error` with `this.name`. If you add a `DbUnavailableError`, follow the same pattern.
- **Type discriminator**: All WS messages use a `type` discriminator string. The `JobSummary` type is a plain interface, not a discriminated union — do not add a `type` field to it.
- **Test pattern**: `spawner.test.ts` uses `vi.resetModules()` + `vi.doMock()` per test. The DB parameter injection means this pattern still works without change.
- **Client type duplication**: The client has its own local type copies (`LogLine`, `PhaseMap`). Add `JobSummary` as a local interface in `usePipeline.ts` — do not attempt to share from server.

## API Reference: better-sqlite3

```typescript
import Database from 'better-sqlite3'
const db = new Database('/path/to/file.sqlite')  // or ':memory:'

// Writes (synchronous, returns info object)
const stmt = db.prepare('INSERT INTO jobs (id, command, started_at) VALUES (?, ?, ?)')
stmt.run(id, command, started_at)

// Single-row read
const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined

// Multi-row read
const rows = db.prepare('SELECT * FROM jobs ORDER BY started_at DESC').all() as JobRow[]

// Transactions (for multi-statement atomicity)
const insertMany = db.transaction((items: Item[]) => {
  for (const item of items) stmt.run(item)
})
insertMany(items)
```

## Conventions Checklist

- [ ] All DB writes use parameterized queries (no string interpolation into SQL)
- [ ] `initDb(':memory:')` is used in all test files (no file I/O in tests)
- [ ] `db` is passed as a parameter everywhere, never imported as a module singleton
- [ ] `activeJobRef` is `{ current: string | null }` — mutable reference, not a getter function
- [ ] Client types (`JobSummary`) are duplicated locally in client, not imported from server
- [ ] New REST endpoints are added before `server.listen` in `index.ts`
- [ ] `data/` is in `.gitignore` before any server startup that creates the DB file
- [ ] TypeScript: run `npm run typecheck` after each server file change

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `better-sqlite3` native build fails on target machine | Low | It ships prebuilt binaries for all major platforms; `npm install` handles it |
| `--output-format stream-json` not supported in user's Claude version | Medium | Graceful degradation: non-JSON stdout lines fall through as plain text |
| Orphan jobs accumulate from repeated crashes | Low | Startup sweep marks them failed; no user action needed |
| `data/jobs.sqlite` grows unboundedly | Medium | Document manual pruning; `DELETE /api/jobs/:id` is available; TTL is a future feature |
| DB write latency on high-throughput stdout | Low | better-sqlite3 is synchronous and very fast (~100K writes/sec on SSD); readline backpressure is the real limiter |
| `activeJobRef.current` set to null before hooks see the job id | None | `activeJobRef.current` is set to `handle.processId` synchronously in `POST /api/spawn` before any hooks can fire |
