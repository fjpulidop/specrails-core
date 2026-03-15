---
agent: developer
feature: analytics-dashboard
tags: [sql, ordering, histogram]
date: 2026-03-15
---

## Decision

Duration histogram buckets are enforced in fixed order client-side (`['<1m', '1-3m', '3-5m', '5-10m', '>10m']`), not by SQL `ORDER BY`.

## Why This Approach

SQL `GROUP BY bucket` with a CASE expression produces rows in an undefined order (SQLite does not guarantee `GROUP BY` result ordering). The bucket names are string labels that don't sort lexicographically in the desired order (e.g., `>10m` comes before `<1m` alphabetically). The server also enforces the order via a `BUCKET_ORDER` map, but the client re-enforces it as a defense-in-depth measure consistent with the spec requirement.
