---
agent: architect
feature: analytics-dashboard
tags: [charting, recharts, dependencies, react]
date: 2026-03-15
---

## Decision

Recharts v2 (`^2.12.0`) was chosen as the chart library over Chart.js or D3.

## Why This Approach

Recharts renders SVG via React components — no imperative canvas management, no `useRef` bridge, first-class TypeScript types. Chart.js requires a canvas bridge wrapper for React. D3 requires building chart primitives from scratch and is inappropriate for a feature that needs 7 chart types in a single sprint. Recharts is pinned to v2 because v3 was in release candidate status as of early 2026, with significant API changes that could cause instability.

## Alternatives Considered

- Chart.js + react-chartjs-2 — rejected due to imperative API mismatch with React's declarative model
- D3 — rejected as too low-level for the number of chart types required
- Recharts v3 — rejected due to RC status; pin to `^2.12.0` and revisit when v3 stabilizes

## See Also

- `openspec/changes/analytics-dashboard/design.md` — Key Design Decisions section
