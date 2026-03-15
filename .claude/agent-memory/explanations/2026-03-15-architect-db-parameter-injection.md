---
agent: architect
feature: sqlite-job-persistence
tags: [dependency-injection, testing, better-sqlite3, module-singleton]
date: 2026-03-15
---

## Decision

Pass the `Database` instance as a function parameter to `spawnClaude` and `createHooksRouter` rather than opening it as a module-level singleton in `db.ts`.

## Why This Approach

The existing test suite for `spawner.ts` uses `vi.resetModules()` between tests to reset module-level state (the `activeProcess` variable). A module-level `db` singleton would be reset along with it, leaving a dangling SQLite file handle. Injecting `db` as a parameter means tests can pass `initDb(':memory:')` per test without any module mock gymnastics. It also makes the dependency graph explicit and avoids the classic "which module opens the DB first" initialization ordering problem.

## Alternatives Considered

- Module-level singleton in `db.ts` with lazy initialization: works for production but breaks the `vi.resetModules()` test pattern.
- Export a `setDb(db)` setter from spawner/hooks: adds mutable global state; not cleaner than the singleton.
- Context/container pattern (IoC): over-engineered for a three-module server.

## See Also

- `/Users/javi/repos/specrails/openspec/changes/sqlite-job-persistence/design.md` — Section 13 "Design Decisions"
- `/Users/javi/repos/specrails/templates/web-manager/server/spawner.test.ts` — existing `vi.resetModules()` pattern
