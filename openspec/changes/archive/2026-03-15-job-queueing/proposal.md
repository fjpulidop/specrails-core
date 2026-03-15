---
change: job-queueing
type: feature
status: proposed
github_issue: 59
vpc_fit: 75%
---

# Proposal: Job Queueing & Parallel Execution Management

## Problem

The web-manager currently enforces a hard single-process constraint: when a job is running and a user submits a second command, the server returns HTTP 409 and the command is silently discarded. The user must either wait, watch the UI, manually re-submit, or remember the command they wanted to run.

This friction compounds in two common scenarios:

1. **Pipeline sequences**: A developer wants to run `/implement #41` followed by `/implement #42`. The first can take 20+ minutes. Today they must either babysit the dashboard or accept losing the second command entirely.
2. **Interruption without cancellation**: There is no way to kill a misbehaving process from the UI. The only escape is killing the terminal or the server process, which destroys the server state.

The root cause is that the current architecture treats "a process is already running" as a hard failure rather than a queueable condition. The system has no memory of what was requested while busy.

## Solution

Replace the 409-reject model with a queue-backed job manager:

1. **Queue model**: Every submitted command creates a job. Jobs progress through a defined state machine: `queued → running → completed | failed | canceled`. The queue auto-drains — as soon as a running job finishes, the next queued job starts automatically.

2. **Kill support**: A running job can be killed from the UI. The server sends SIGTERM to the child process; if it has not exited within 5 seconds, SIGKILL is sent.

3. **Queue control endpoints**: Operators can pause auto-dequeue (to inspect before proceeding), resume it, and reorder pending jobs via the API.

4. **UI queue sidebar**: The existing PipelineSidebar evolves into a dual-panel: the current pipeline phase view (which now scopes to the active job) plus a queue list showing all jobs with their statuses, positions, and a kill button on the active job.

5. **SQLite persistence** (dependent on #57): Queue state survives server restarts. Jobs that were `queued` at shutdown are restored and resume queuing on startup. This depends on the SQLite persistence layer from issue #57.

## Scope

### In scope

- `QueueManager` class: owns the job lifecycle state machine, process spawning, kill logic
- SQLite-backed job queue (status column; reads from DB on startup to restore queued jobs)
- New REST endpoints: `POST /api/queue/pause`, `POST /api/queue/resume`, `PUT /api/queue/reorder`
- Modified REST endpoint: `POST /api/spawn` adds job to queue (returns `{ jobId, position }`)
- Modified REST endpoint: `DELETE /api/jobs/:id` — cancel queued jobs OR kill running job
- Phase state scoped per-job (phases reset when each new job starts running)
- WebSocket `queue` message type for real-time queue state updates
- Kill with SIGTERM + 5s SIGKILL fallback
- Queue sidebar UI with job list, status indicators, kill button
- Queue position indicators on pending jobs

### Out of scope

- Drag-and-drop reorder in the UI (deferred; reorder is supported via `PUT /api/queue/reorder` API only)
- Concurrent job execution (the queue is strictly sequential — one running job at a time)
- Job priority levels beyond queue position
- Cross-session queue sharing (queue is per-server-instance)

### Dependency: SQLite (#57)

The queue state is stored in the SQLite `jobs` table (status column). This feature depends on #57 being implemented first. Without SQLite, startup restore is not possible. However, the `QueueManager` is designed to function in-memory if SQLite is unavailable — queue state is held in-memory as the authoritative source with SQLite as the persistence mirror. This means the feature can be built and tested before #57 ships, with SQLite-restore functionality gated behind the DB availability check.

## Acceptance Criteria

1. `POST /api/spawn` with a command returns `{ jobId, position: 0 }` when the queue is empty and the job starts immediately, or `{ jobId, position: N }` when N jobs are ahead of it.
2. When the active job finishes (exit event), the next queued job starts automatically.
3. `DELETE /api/jobs/:id` on a queued job removes it from the queue without affecting the running job.
4. `DELETE /api/jobs/:id` on a running job sends SIGTERM; if the process has not exited within 5 seconds, SIGKILL is sent. The job status becomes `canceled`.
5. `POST /api/queue/pause` stops auto-dequeue. Queued jobs remain queued when the running job finishes.
6. `POST /api/queue/resume` restarts auto-dequeue. If a job is queued and nothing is running, the first queued job starts immediately.
7. `PUT /api/queue/reorder` with `{ jobIds: ["id-3", "id-1", "id-2"] }` reorders the pending (non-running, non-terminal) jobs.
8. The UI shows a job list with status indicators: running (yellow pulse), queued (gray with position number), completed (green), failed (red), canceled (dim).
9. A "Kill" button appears on the active running job. Clicking it calls `DELETE /api/jobs/:id` for the active job.
10. All existing server tests continue to pass.
11. TypeScript compiles without errors after changes.

## Motivation

VPC fit score: 75%. Alex (Lead Dev, 5/5) rates this the highest pain point — queue-based execution unlocks fire-and-forget multi-ticket workflows without manual babysitting. Sara (Product Founder, 4/5) values the kill button as a trust signal — being able to stop a runaway process is fundamental to user confidence. Kai (OSS Maintainer, 3/5) notes the complexity increase but sees the job-history UI from #57 as a natural platform for this feature.

The key insight is that the 409 response today is not a protection mechanism but an accidental limitation of the imperative single-process model. Sequential pipeline commands are the valid use case — making that native improves the product without changing the execution semantics.
