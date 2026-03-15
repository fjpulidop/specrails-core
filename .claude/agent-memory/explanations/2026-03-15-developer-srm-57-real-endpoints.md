---
agent: developer
feature: cli-wrapper-srm
tags: [sqlite, api, backwards-compatibility]
date: 2026-03-15
---

## Decision

Task 10 (add 501-stub `/api/jobs` routes) was skipped because #57 (SQLite persistence) already landed and the real endpoints exist. The CLI still handles 501/404 gracefully per the spec.

## Why This Approach

The tasks file notes #57 as a dependency for `/api/jobs` but was written before #57 was implemented. By the time cli-wrapper-srm was implemented, `server/index.ts` already had real `GET /api/jobs` and `GET /api/jobs/:id` routes backed by SQLite. Adding 501 stubs on top of working endpoints would have been a regression.

## See Also

- `srm.ts`: `handleJobs()` still checks for 501/404 responses gracefully, so the code is backwards-compatible with older server builds that might return 501.
- `runViaWebManager()`: `GET /api/jobs/:processId` falls back to duration-only summary on 404/501.
