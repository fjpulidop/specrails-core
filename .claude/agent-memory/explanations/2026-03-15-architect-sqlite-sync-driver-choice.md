---
agent: architect
feature: sqlite-job-persistence
tags: [better-sqlite3, sqlite, async, spawner, performance]
date: 2026-03-15
---

## Decision

Use `better-sqlite3` (synchronous SQLite driver) rather than an async SQLite wrapper like `sqlite` or `@databases/sqlite`.

## Why This Approach

The spawner's event pipeline is driven by Node.js readline `line` events, which are synchronous callbacks. Inserting an `await` inside a `line` handler would change the event loop behavior and introduce the possibility of two handlers interleaving — an event arriving before the prior write resolves. Synchronous writes eliminate this class of bug entirely. better-sqlite3 is also significantly faster than async wrappers (no Promise overhead, no thread-pool round-trips for the common case), which matters when Claude's `--verbose` mode can emit hundreds of lines per minute.

## Alternatives Considered

- `sqlite` npm package (async wrapper over `sqlite3`): rejected because of async interleaving risk in readline handlers.
- `@databases/sqlite` (async, uses worker thread): same rejection reason; also heavier dependency.
- `drizzle-orm` with better-sqlite3: over-engineered for this use case; plain parameterized SQL is sufficient and easier for contributors to read.

## See Also

- `/Users/javi/repos/specrails/openspec/changes/sqlite-job-persistence/design.md` — Section 13 "Design Decisions"
