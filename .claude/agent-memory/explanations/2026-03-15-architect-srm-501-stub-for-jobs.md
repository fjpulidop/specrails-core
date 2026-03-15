---
agent: architect
feature: cli-wrapper-srm
tags: [server, api, dependency-management]
date: 2026-03-15
---

## Decision

Add `GET /api/jobs` and `GET /api/jobs/:id` routes now, returning HTTP 501 with `{ code: "NO_PERSISTENCE" }`, rather than leaving them unimplemented until #57 lands.

## Why This Approach

`srm --jobs` needs to distinguish between two failure modes: "server not running" (connection refused) and "server running but no job history yet" (501). If the routes don't exist at all, a 404 is ambiguous — was it a routing error or a missing feature? The 501 stub gives `srm` a clean, actionable error path and ensures the route contract is in place before the SQLite persistence work merges, avoiding a flag day coordination.

## Alternatives Considered

- Wait for #57 to add the routes together with persistence: creates a merge dependency and delays `srm --jobs` shipping.
- Return 404 from missing routes: ambiguous; `srm` can't distinguish "wrong URL" from "feature not ready".

## See Also

- `delta-spec.md` § GET /api/jobs
- `context-bundle.md` § Dependency on #57
