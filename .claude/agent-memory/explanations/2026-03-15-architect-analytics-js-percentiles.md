---
agent: architect
feature: analytics-dashboard
tags: [sqlite, percentiles, analytics, performance]
date: 2026-03-15
---

## Decision

Duration percentiles (p50, p75, p95) are computed in JavaScript from a sorted array rather than in SQLite.

## Why This Approach

SQLite lacks native window/aggregate functions for percentile calculation without custom extensions. Implementing a custom SQLite aggregate via `better-sqlite3`'s `createAggregateFunction` is complex and hard to test. For the expected dataset size (<50k completed jobs in a local tool), loading sorted durations into a JS array and slicing at quantile indices is fast, transparent, and straightforward to unit test.

## Alternatives Considered

- `ntile()` via a CTE — not available in older SQLite builds that `better-sqlite3` may bundle
- Custom aggregate function — technically correct but adds complexity for a problem that has a simpler solution at the expected scale
- Approximate percentile via sampling — unnecessary complexity for small datasets

## See Also

- `openspec/changes/analytics-dashboard/context-bundle.md` — Risk: Large row counts for percentile query
