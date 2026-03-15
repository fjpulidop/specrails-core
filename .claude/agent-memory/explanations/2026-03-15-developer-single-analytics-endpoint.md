---
agent: developer
feature: analytics-dashboard
tags: [api-design, performance, single-endpoint]
date: 2026-03-15
---

## Decision

All analytics data is returned in a single `GET /api/analytics` response rather than per-chart endpoints.

## Why This Approach

All charts share the same period filter, so batching all SQLite queries in one synchronous pass is faster than N parallel HTTP requests. SQLite is embedded and synchronous — the full response for typical datasets is under 15 KB and compresses well. A single loading state on the client is simpler to manage.

## Alternatives Considered

Per-chart endpoints would allow progressive loading of individual charts. Rejected because: the local-tool context has negligible latency; progressive loading adds significant client state complexity; the benefit doesn't justify the overhead for the MVP.
