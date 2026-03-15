---
id: analytics-dashboard
type: proposal
status: draft
created: 2026-03-15
---

# Analytics Dashboard

## Problem

The web-manager runs Claude Code jobs and captures rich telemetry per job: cost, token counts, cache efficiency, duration, model, command, and status. All of this data sits in SQLite but is only accessible through the raw jobs table. Users have no way to reason about:

- How much they are spending over time and on which commands
- Which commands succeed vs. fail and at what rate
- Whether cache usage is reducing costs
- How job durations are distributed and what the worst-case tail looks like
- Which day-of-week or time patterns drive throughput

Without visibility into these patterns, teams cannot make informed decisions about which commands to invest in, when to run jobs, or how to optimize cost.

## Solution

Add a dedicated `/analytics` page to the web-manager that surfaces job telemetry as BI-style visualizations. The page includes:

- A **period selector** (7d default, 30d, 90d, All, custom date range) that scopes all charts
- **KPI summary cards** showing total cost, job count, success rate, and average duration with trend arrows compared to the previous equal-length period
- A **Cost Over Time** line chart (daily aggregation)
- A **Jobs by Status** donut chart
- A **Duration Distribution** histogram with fixed buckets and percentile markers
- A **Token Efficiency** horizontal bar chart comparing output tokens vs. cache read tokens per command
- A **Command Performance** sortable table (success rate, avg cost, avg duration, total runs)
- A **Daily Throughput** stacked bar chart (completed vs. failed per day)
- A **Cost per Command** treemap

Navigation is updated: the existing Dashboard becomes "Home", and a new "Analytics" navbar item is added between Home and Settings.

The backend adds a single `GET /api/analytics?period=7d` endpoint that runs all SQLite aggregations server-side and returns a single JSON response. Recharts is used for chart rendering.

## Value Proposition

- **Cost awareness**: developers see exactly how much each command costs before deciding to run more
- **Reliability signal**: success rate by command surfaces which workflows are stable vs. fragile
- **Cache ROI**: token efficiency charts show whether cache warming is paying off
- **Capacity planning**: daily throughput and duration histograms help teams estimate queue saturation
- **Zero new infrastructure**: all data already exists; this is pure read-path work on existing SQLite data

## Non-goals

- Real-time chart updates (analytics are point-in-time snapshots on page load / period change)
- Per-user attribution (single-user tool)
- CSV/PDF export (future feature)
- Alert thresholds or budget caps (future feature)
