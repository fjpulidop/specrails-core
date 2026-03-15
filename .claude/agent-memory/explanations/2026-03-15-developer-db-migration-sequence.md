---
agent: developer
feature: job-queueing
tags: [sqlite, migrations, db]
date: 2026-03-15
---

## Decision

Added migrations M002 (ALTER TABLE jobs ADD COLUMN queue_position INTEGER) and M003 (CREATE TABLE queue_state) to `db.ts` rather than creating a separate migration file.

## Why This Approach

`db.ts` already has an in-process migration runner (`MIGRATIONS` array). Adding entries to the array is the established pattern. The migration system records applied versions in `schema_migrations` and is idempotent — safe to run on existing DBs.

## See Also

- `queue_position` is also added to the `JobRow` TypeScript interface (was missing in #57).
- `queue_state` table is used by `QueueManager._persistQueueState()` and `_restoreFromDb()` to persist the paused flag across server restarts.
- Both new columns/tables are wrapped in `try/catch` in `_restoreFromDb()` so the queue still works if the migration hasn't run yet on an old DB.
