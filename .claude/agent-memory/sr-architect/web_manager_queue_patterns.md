---
name: web_manager_queue_patterns
description: Job queueing design patterns for the web-manager — QueueManager class, HTTP 202, global log buffer, tree-kill, SQLite-optional pattern
type: project
---

# Web Manager Queue Patterns

## QueueManager replaces spawner.ts module globals

When queue state grows beyond one variable (active process), use a class. The `QueueManager` class is injected with `broadcast` at construction time and tested by instantiating a fresh instance per test (no `vi.resetModules()` needed).

## HTTP 202 for spawn

`POST /api/spawn` returns 202 Accepted (not 200) because the job may be queued. Clients check `res.status === 202`. The `processId` field is gone; use `jobId` instead.

## Global log buffer is intentional

The 5000-line global circular buffer is retained even with multiple jobs. `processId` on every `LogMessage` equals `jobId`, so clients can filter. Per-job buffers are deferred to SQLite persistence (#57).

## tree-kill for process termination

Use `tree-kill` (already in node_modules) to send signals to the entire process group, not just the top-level PID. `claude` spawns child processes; killing only the parent leaves orphans.

Kill sequence: SIGTERM → 5s timer → SIGKILL. Timer is cleared in `_onJobExit`.

## SQLite-optional pattern

`QueueManager` accepts `db?: any` in its constructor. When `null`, queue operates in-memory. All DB writes go through a private `_persistJob()` helper that no-ops when `db` is null. This allows the queue to ship before #57 is complete.

## _cancelingJobs private set

Track jobs in the "SIGTERM sent, waiting for exit" state with a private `Set<string>` called `_cancelingJobs`. In `_onJobExit`, if the jobId is in this set, set final status to `canceled` (not `failed`), then remove from set.

## Phase state scoping

`resetPhases(broadcast)` is called from `_startJob` before spawning. No structural change to `hooks.ts`. Phase state always reflects the currently running job's pipeline.
