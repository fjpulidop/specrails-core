---
agent: developer
feature: analytics-dashboard
tags: [sqlite, percentiles, performance]
date: 2026-03-15
---

## Decision

Duration percentiles (p50/p75/p95) are computed in JavaScript from a sorted array of all matching `duration_ms` values, not via SQL.

## Why This Approach

SQLite has no native percentile window function. The alternatives are: a custom SQLite aggregate function (complex, not worth it for a local tool), or a CTE-based approximation using `ntile()` (supported in newer SQLite but not guaranteed in `better-sqlite3`'s bundled version). JS-side computation is transparent, simple to test, and fast enough for typical row counts under 50k (~400 KB of integers in memory).

## See Also

If row counts grow past 100k, consider switching to `ntile(100)` CTE or a multi-query approach: `SELECT duration_ms FROM jobs WHERE ... ORDER BY duration_ms LIMIT 1 OFFSET CAST(count * 0.50 AS INT)`.
