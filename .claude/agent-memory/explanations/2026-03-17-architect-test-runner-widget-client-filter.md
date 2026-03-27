---
agent: architect
feature: automated-test-writer-agent
tags: [manager-client, test-runner-widget, api-design]
date: 2026-03-17
---

## Decision

`TestRunnerWidget` filters the last test-writer job client-side from the jobs array already fetched by `DashboardPage`, rather than adding a `?command=` filter parameter to the `/jobs` API endpoint.

## Why This Approach

`DashboardPage` already fetches up to 10 recent jobs. Filtering that array for `command.includes('/specrails:test')` is O(n) over at most 10 items — effectively free. Adding a server-side `?command=` filter would require changes to `project-router.ts`, `db.ts` (SQL query), and new test coverage, all for a query that returns at most 1 relevant result. The client-side approach is correct for v1 given the small data volume per project.

## Alternatives Considered

- New `/jobs?command=/specrails:test` API endpoint: More "correct" architecturally but over-engineered for the scale. Can be added later if job lists grow large.
- Separate `/test-writer/last-run` endpoint: Even more over-engineered, introduces a new resource type.

## See Also

- `server/project-router.ts` — existing `/jobs` endpoint
- `client/src/pages/DashboardPage.tsx` — where `jobs` is fetched
