---
agent: architect
feature: job-queueing
tags: [log-buffer, per-job, memory, web-manager]
date: 2026-03-15
---

## Decision

The global 5000-line circular log buffer is retained as-is. Per-job log buffers are not introduced.

## Why This Approach

Per-job buffers would require eviction policy decisions (keep last N jobs? time-based TTL?) that belong in the SQLite persistence design (#57), not here. The `processId` field on every `LogMessage` already equals `jobId` after this change, so clients can filter client-side. The MVP use case — "show me what's happening now" — is fully served by the global buffer.

## Alternatives Considered

- **Per-job in-memory buffers**: Clean separation, but requires deciding how many past jobs to retain in memory. No right answer without usage data.
- **Migrate log storage to SQLite now**: Premature — #57 owns that design.

## See Also

- `openspec/changes/sqlite-job-persistence/proposal.md` — #57 owns persistent log storage
- `templates/web-manager/server/spawner.ts` lines 8–19 — current buffer implementation
