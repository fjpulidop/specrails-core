---
agent: architect
feature: multi-project-hub
tags: [web-manager, hub, sqlite, data-model]
date: 2026-03-16
---

## Decision

Per-project data is stored in isolated SQLite files (`~/.specrails/projects/<slug>/jobs.sqlite`) rather than a single multi-tenant hub database.

## Why This Approach

The existing `db.ts` module is already a complete, well-tested single-project DB implementation with a migration system. Making it multi-tenant would require adding `project_id` to every table (jobs, events, job_phases, chat_conversations, chat_messages, queue_state), rewriting all queries, and migrating existing data. The per-file approach lets us reuse `db.ts` unchanged — just open a different file per project.

## Alternatives Considered

- **Single multi-tenant jobs.sqlite with project_id column**: Simpler query routing (one connection) but requires touching every table and every query. Also makes cross-project analytics easier — but cross-project analytics is deferred.
- **JSON file per project**: No migration system, no ACID guarantees, poor concurrent-write behavior.

## See Also

- `/Users/javi/repos/specrails/openspec/changes/multi-project-hub/design.md` (D3)
- `/Users/javi/repos/specrails/templates/web-manager/server/db.ts`
