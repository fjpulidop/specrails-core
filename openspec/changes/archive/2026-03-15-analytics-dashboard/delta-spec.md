---
id: analytics-dashboard
type: delta-spec
status: draft
created: 2026-03-15
---

# Delta Spec — Analytics Dashboard

This document defines the changes to existing specs and the new spec that must be added to `openspec/specs/`.

---

## New spec: `openspec/specs/web-manager-analytics/spec.md`

### Requirement: Analytics page accessible via navigation

A dedicated Analytics page SHALL be accessible at `/analytics` via the navbar.

#### Scenario: Navigate to analytics
- **WHEN** user clicks the "Analytics" navbar item
- **THEN** the browser SHALL navigate to `/analytics` and the Analytics page SHALL render with the period selector and all chart sections

#### Scenario: Analytics page loads default period
- **WHEN** the Analytics page mounts
- **THEN** it SHALL automatically fetch `GET /api/analytics?period=7d` and render all charts with the returned data

### Requirement: Period selector controls all chart data

The Analytics page SHALL expose a period selector that scopes all charts simultaneously.

#### Scenario: Preset period selected
- **WHEN** user selects one of the preset periods (7d, 30d, 90d, All)
- **THEN** the page SHALL fetch `GET /api/analytics?period=<value>` and update all charts

#### Scenario: Custom date range entered
- **WHEN** user selects "Custom" and provides both a start and end date
- **THEN** the page SHALL fetch `GET /api/analytics?period=custom&from=<ISO>&to=<ISO>` and update all charts

#### Scenario: Custom range incomplete
- **WHEN** user selects "Custom" but has not provided both dates
- **THEN** no fetch SHALL be triggered until both dates are set

### Requirement: KPI summary cards show aggregate metrics with trends

The Analytics page SHALL display four KPI cards at the top: Total Cost, Total Jobs, Success Rate, Avg Duration.

#### Scenario: Trend indicators present
- **WHEN** the selected period is not "All"
- **THEN** each KPI card SHALL display a trend arrow (up/down/neutral) and delta value compared to the previous equal-length period

#### Scenario: No trend for "All" period
- **WHEN** the selected period is "All"
- **THEN** KPI cards SHALL display the absolute values without trend indicators

### Requirement: Cost Over Time chart

The Analytics page SHALL display a line chart showing daily total cost in USD.

#### Scenario: Data available
- **WHEN** the period contains days with completed jobs
- **THEN** the chart SHALL show one data point per day with the summed `total_cost_usd` for that day

#### Scenario: Days with no jobs
- **WHEN** a day within the period has no jobs
- **THEN** that day SHALL appear with a value of 0 (no gaps in the line)

### Requirement: Jobs by Status donut chart

The Analytics page SHALL display a donut chart breaking down job counts by status.

#### Scenario: Multiple statuses present
- **WHEN** jobs exist with different statuses
- **THEN** the donut SHALL have one segment per status (completed=green, failed=red, canceled=orange, running=cyan) with counts in the tooltip

### Requirement: Duration Distribution histogram

The Analytics page SHALL display a histogram of completed job durations using fixed buckets.

#### Scenario: Buckets and percentile markers
- **WHEN** duration data is available
- **THEN** the histogram SHALL show five buckets (<1m, 1-3m, 3-5m, 5-10m, >10m) with bar heights representing counts, and SHALL display p50/p75/p95 values as text annotations beneath the chart

#### Scenario: No duration data
- **WHEN** no completed jobs have a `duration_ms` value
- **THEN** the histogram SHALL display an empty state: "No duration data available"

### Requirement: Token Efficiency horizontal bar chart

The Analytics page SHALL display a horizontal bar chart showing output tokens vs. cache-read tokens per command.

#### Scenario: Commands with token data
- **WHEN** jobs have token data
- **THEN** the chart SHALL show one row per command (top 10 by total tokens) with two bars: tokens_out (purple) and tokens_cache_read (cyan)

### Requirement: Command Performance table

The Analytics page SHALL display a sortable table of per-command statistics.

#### Scenario: Table columns
- **WHEN** the table renders
- **THEN** it SHALL show columns: Command, Total Runs, Success Rate, Avg Cost, Avg Duration, Total Cost — sortable by clicking column headers

### Requirement: Daily Throughput stacked bar chart

The Analytics page SHALL display a stacked bar chart showing completed, failed, and canceled job counts per day.

### Requirement: Cost per Command treemap

The Analytics page SHALL display a treemap where each tile represents one command, sized by total cost, colored by command identity.

### Requirement: Bonus Metrics section

The Analytics page SHALL display supplementary metrics: Cost per Success, API Efficiency %, Failure Cost, and Model Breakdown.

#### Scenario: Model breakdown
- **WHEN** jobs have been run with multiple models
- **THEN** the model breakdown SHALL show one row per model with job count and total cost

### Requirement: Analytics API endpoint

The server SHALL expose `GET /api/analytics` returning aggregated job metrics.

#### Scenario: Valid period parameter
- **WHEN** client calls `GET /api/analytics?period=7d`
- **THEN** the server SHALL return HTTP 200 with a JSON body matching the `AnalyticsResponse` schema

#### Scenario: Invalid period parameter
- **WHEN** client calls `GET /api/analytics?period=invalid`
- **THEN** the server SHALL return HTTP 400 with `{ error: "Invalid period. Must be one of: 7d, 30d, 90d, all, custom" }`

#### Scenario: Custom period missing dates
- **WHEN** client calls `GET /api/analytics?period=custom` without `from` and `to`
- **THEN** the server SHALL return HTTP 400 with `{ error: "from and to are required for custom period" }`

#### Scenario: Empty dataset
- **WHEN** no jobs exist in the database for the requested period
- **THEN** the server SHALL return HTTP 200 with zero-valued aggregates (not an error)

#### Scenario: NULL cost values
- **WHEN** some jobs have `total_cost_usd = NULL` (job was canceled before completion)
- **THEN** the server SHALL treat NULL cost values as 0 in all aggregations

---

## Modified spec: `openspec/specs/web-manager-dashboard/spec.md`

### Addition: Navbar has three navigation items

The navbar SHALL contain three primary navigation links: Home (→ `/`), Analytics (→ `/analytics`), and Settings (→ `/settings`), ordered left-to-right.

Append the following scenario to the existing dashboard spec:

#### Scenario: Analytics link in navbar
- **WHEN** the navbar renders
- **THEN** it SHALL display an "Analytics" link that navigates to `/analytics` and applies the active highlight style when on the analytics route
