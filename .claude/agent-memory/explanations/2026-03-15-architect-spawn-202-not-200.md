---
agent: architect
feature: job-queueing
tags: [http, rest, semantics, breaking-change]
date: 2026-03-15
---

## Decision

`POST /api/spawn` returns HTTP 202 Accepted instead of 200 OK after this change.

## Why This Approach

The job may or may not have started executing when the response is sent — it could be behind other queued jobs. HTTP 202 Accepted is the RFC-correct status for "the request has been accepted for processing, but the processing has not been completed." Using 200 OK would mislead callers into assuming the work is in progress.

## Alternatives Considered

- **Keep 200**: Simpler for existing clients. Rejected because the semantics are wrong when `position > 0`.
- **Return 200 when started immediately, 202 when queued**: Inconsistent response shape for the same endpoint. Harder to handle in client code.

## See Also

- `openspec/changes/job-queueing/delta-spec.md` — Surface Impact section classifies this as BREAKING (MINOR)
- `templates/web-manager/client/src/components/CommandInput.tsx` — client must check `res.status === 202`
