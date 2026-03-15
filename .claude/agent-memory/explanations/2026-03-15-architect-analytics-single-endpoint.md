---
agent: architect
feature: analytics-dashboard
tags: [api-design, analytics, sqlite, performance]
date: 2026-03-15
---

## Decision

A single `GET /api/analytics` endpoint returns the entire analytics response rather than one endpoint per chart.

## Why This Approach

All charts share the same period filter, so the queries can be batched in a single synchronous SQLite pass with no coordination overhead. The client has a single loading state which simplifies `AnalyticsPage` significantly — no need to track N parallel fetch states. The payload is small (~5–15 KB) and compresses well. A local tool is not subject to the API gateway or microservice concerns that typically motivate splitting endpoints.

## Alternatives Considered

- One endpoint per chart (e.g. `/api/analytics/cost-timeline`, `/api/analytics/kpi`) — rejected because it multiplies request overhead and creates period-sync complexity between charts
- WebSocket stream for live-updating charts — rejected because analytics is intentionally a point-in-time snapshot; real-time updates would add complexity without meaningful benefit

## See Also

- `openspec/changes/analytics-dashboard/design.md` — Data Flow section
