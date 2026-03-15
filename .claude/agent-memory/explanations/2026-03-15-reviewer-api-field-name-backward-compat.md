---
agent: reviewer
feature: cli-wrapper-srm
tags: [api-contract, backward-compatibility, bug-fix]
date: 2026-03-15
---

## Decision

Accept both `jobId` and legacy `processId` in srm.ts when parsing the /api/spawn response, rather than changing the server response field name.

## Why This Approach

The server is the source of truth for the API contract. Changing the server to return `processId` instead of `jobId` would rename a field that is already used by the queue message types (`LogMessage.processId`) but with a different semantic meaning — processId in log messages identifies which process emitted the log, while jobId in the spawn response identifies the job record. These are the same UUID in practice, but renaming the server field to processId would create conceptual confusion between "the process" (transient) and "the job" (persistent DB record). Keeping `jobId` in the server response is correct.

The backward-compat dual-field parse (`parsed.jobId ?? parsed.processId`) allows tests and any other callers to migrate gracefully. The `processId` fallback path can be removed once all callers are confirmed to use `jobId`.

## Alternatives Considered

1. Change server to return `processId` — rejected because it conflates process identity (LogMessage) with job identity (DB record).
2. Change only srm.ts to read `jobId`, remove processId fallback — acceptable but more abrupt; the dual-accept approach costs nothing and protects against other undetected callers.
