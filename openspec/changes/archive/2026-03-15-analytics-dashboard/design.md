---
id: analytics-dashboard
type: design
status: draft
created: 2026-03-15
---

# Analytics Dashboard — Technical Design

## Architecture Overview

```
Browser (React)                Server (Express + SQLite)
──────────────────────         ──────────────────────────
AnalyticsPage
  ├─ PeriodSelector            GET /api/analytics?period=7d&from=&to=
  ├─ KpiCards                        └─ analyticsQueries(db, opts)
  ├─ CostTimeline (Recharts)              ├─ kpi aggregate
  ├─ StatusBreakdown (Recharts)           ├─ costTimeline[]
  ├─ DurationHistogram (Recharts)         ├─ statusBreakdown[]
  ├─ TokenEfficiency (Recharts)           ├─ durationHistogram[]
  ├─ CommandPerformance (table)           ├─ tokenEfficiency[]
  ├─ DailyThroughput (Recharts)           ├─ commandPerformance[]
  ├─ CostTreemap (Recharts)              ├─ dailyThroughput[]
  └─ BonusMetrics                        ├─ costPerCommand[]
                                         └─ bonusMetrics{}
```

The analytics endpoint does **not** push over WebSocket — it is a standard REST GET, polled once on mount and on every period change. There is no real-time update requirement for analytics.

---

## Backend Design

### New file: `server/analytics.ts`

Single module exporting two things:
1. `AnalyticsResponse` TypeScript interface (re-exported from `types.ts`)
2. `getAnalytics(db, opts)` function — runs all queries, returns `AnalyticsResponse`

#### Period resolution

```ts
interface AnalyticsOpts {
  period: '7d' | '30d' | '90d' | 'all' | 'custom'
  from?: string   // ISO date string, required when period='custom'
  to?: string     // ISO date string, required when period='custom'
}
```

Period maps to:
- `7d` → `started_at >= date('now', '-7 days')`
- `30d` → `started_at >= date('now', '-30 days')`
- `90d` → `started_at >= date('now', '-90 days')`
- `all` → no date filter
- `custom` → `started_at BETWEEN ? AND ?`

For KPI trend comparison, the "previous period" is the equal-length window immediately before the current window. For `all`, there is no comparison period — trend indicators are omitted.

#### Response shape

```ts
interface AnalyticsResponse {
  period: {
    label: string        // "Last 7 days"
    from: string | null  // ISO date
    to: string | null    // ISO date
  }
  kpi: {
    totalCostUsd: number
    totalJobs: number
    successRate: number        // 0–1
    avgDurationMs: number | null
    // Deltas vs previous period (null if period='all')
    costDelta: number | null       // absolute USD change
    jobsDelta: number | null       // absolute count change
    successRateDelta: number | null
    avgDurationDelta: number | null
  }
  costTimeline: Array<{
    date: string         // YYYY-MM-DD
    costUsd: number
  }>
  statusBreakdown: Array<{
    status: string       // 'completed' | 'failed' | 'canceled' | 'running'
    count: number
  }>
  durationHistogram: Array<{
    bucket: string       // '<1m' | '1-3m' | '3-5m' | '5-10m' | '>10m'
    count: number
  }>
  durationPercentiles: {
    p50: number | null   // ms
    p75: number | null
    p95: number | null
  }
  tokenEfficiency: Array<{
    command: string
    tokensOut: number
    tokensCacheRead: number
    totalTokens: number
  }>
  commandPerformance: Array<{
    command: string
    totalRuns: number
    successRate: number
    avgCostUsd: number | null
    avgDurationMs: number | null
    totalCostUsd: number
  }>
  dailyThroughput: Array<{
    date: string         // YYYY-MM-DD
    completed: number
    failed: number
    canceled: number
  }>
  costPerCommand: Array<{
    command: string
    totalCostUsd: number
    jobCount: number
  }>
  bonusMetrics: {
    costPerSuccess: number | null
    apiEfficiencyPct: number | null  // duration_api_ms / duration_ms * 100
    failureCostUsd: number
    modelBreakdown: Array<{
      model: string
      jobCount: number
      totalCostUsd: number
    }>
  }
}
```

#### SQLite query patterns

All queries use `started_at` for period filtering since it is indexed. `finished_at` is only used for duration calculations on the same row.

**Duration histogram** — SQLite has no native percentile function. Use `ORDER BY duration_ms` with `LIMIT 1 OFFSET CAST(count * 0.50 AS INTEGER)` pattern for each percentile, or collect all durations and compute in JS. Given typical job counts (<10k), JS-side percentile calculation is acceptable and simpler.

Bucket SQL:
```sql
SELECT
  CASE
    WHEN duration_ms < 60000 THEN '<1m'
    WHEN duration_ms < 180000 THEN '1-3m'
    WHEN duration_ms < 300000 THEN '3-5m'
    WHEN duration_ms < 600000 THEN '5-10m'
    ELSE '>10m'
  END AS bucket,
  COUNT(*) as count
FROM jobs
WHERE <period_filter> AND duration_ms IS NOT NULL AND status = 'completed'
GROUP BY bucket
```

Percentiles are computed in JS from `SELECT duration_ms FROM jobs WHERE ... AND duration_ms IS NOT NULL ORDER BY duration_ms`.

**Token efficiency** — aggregate per command:
```sql
SELECT
  command,
  COALESCE(SUM(tokens_out), 0) as tokensOut,
  COALESCE(SUM(tokens_cache_read), 0) as tokensCacheRead,
  COALESCE(SUM(tokens_in) + SUM(tokens_out), 0) as totalTokens
FROM jobs
WHERE <period_filter>
GROUP BY command
ORDER BY totalTokens DESC
LIMIT 10
```

**NULL handling** — all aggregates use `COALESCE(..., 0)` for sums and return `null` from JS when a derived ratio has a zero denominator.

### Route addition in `server/index.ts`

```ts
import { getAnalytics } from './analytics'

app.get('/api/analytics', (req, res) => {
  const period = (req.query.period as string) || '7d'
  const from = req.query.from as string | undefined
  const to = req.query.to as string | undefined
  const validPeriods = ['7d', '30d', '90d', 'all', 'custom']
  if (!validPeriods.includes(period)) {
    res.status(400).json({ error: 'Invalid period. Must be one of: 7d, 30d, 90d, all, custom' })
    return
  }
  if (period === 'custom' && (!from || !to)) {
    res.status(400).json({ error: 'from and to are required for custom period' })
    return
  }
  try {
    res.json(getAnalytics(db, { period: period as AnalyticsOpts['period'], from, to }))
  } catch (err) {
    console.error('[analytics] error:', err)
    res.status(500).json({ error: 'Failed to compute analytics' })
  }
})
```

---

## Frontend Design

### Routing — `client/src/App.tsx`

Add `/analytics` route:
```tsx
import AnalyticsPage from './pages/AnalyticsPage'
// ...
<Route path="/analytics" element={<AnalyticsPage />} />
```

### Navigation — `client/src/components/Navbar.tsx`

Add two NavLink items between the wordmark and the right-side actions, creating a center nav group:
- **Home** (`/`) — uses `LayoutDashboard` icon from lucide-react
- **Analytics** (`/analytics`) — uses `BarChart3` icon

Settings icon stays on the right side.

The active NavLink state uses `text-primary bg-dracula-current/50` (matches existing settings link pattern).

### Period selector — `client/src/components/analytics/PeriodSelector.tsx`

A row of pill buttons for preset periods, plus a "Custom" option that reveals two `<input type="date">` fields. Controlled from `AnalyticsPage` as a lifted state. On change, triggers a new `GET /api/analytics` fetch.

### AnalyticsPage — `client/src/pages/AnalyticsPage.tsx`

Responsibilities:
- Own `period` state (default: `'7d'`)
- Fetch `GET /api/analytics?period=...` on mount and on period change
- Own `loading`, `error`, `data` state
- Render a 2-col responsive grid on desktop, 1-col on mobile using Tailwind `grid grid-cols-1 md:grid-cols-2 gap-4`

### Chart components — `client/src/components/analytics/`

Each chart is a standalone component accepting typed props from the `AnalyticsResponse` shape. They never fetch data themselves.

| Component | Chart type | Recharts component |
|---|---|---|
| `KpiCards.tsx` | stat cards | none (raw divs) |
| `CostTimeline.tsx` | line chart | `LineChart`, `Line`, `XAxis`, `YAxis`, `Tooltip`, `ResponsiveContainer` |
| `StatusBreakdown.tsx` | donut | `PieChart`, `Pie`, `Cell`, `Tooltip`, `Legend` |
| `DurationHistogram.tsx` | bar chart | `BarChart`, `Bar`, `XAxis`, `YAxis`, `Tooltip` |
| `TokenEfficiency.tsx` | horizontal bars | `BarChart` with `layout="vertical"` |
| `CommandPerformance.tsx` | table | plain HTML table |
| `DailyThroughput.tsx` | stacked bar | `BarChart`, `Bar` (stacked), `XAxis`, `YAxis` |
| `CostTreemap.tsx` | treemap | `Treemap`, `ResponsiveContainer` |
| `BonusMetrics.tsx` | stat cards | plain divs |

### Recharts dependency

Recharts is **not yet in** `client/package.json`. It must be added:
```json
"recharts": "^2.12.0"
```

Recharts v2 is the stable choice — v3 is in RC as of early 2026. Pinning to `^2.12.0` avoids instability.

### Dracula color palette for charts

All chart colors use the CSS variables already defined in `globals.css`. Pass them as hex strings computed from the CSS variable at render time, or use a constants file:

```ts
// client/src/lib/dracula-colors.ts
export const DRACULA = {
  purple: 'hsl(265 89% 78%)',
  cyan:   'hsl(191 97% 77%)',
  green:  'hsl(135 94% 65%)',
  pink:   'hsl(326 100% 74%)',
  orange: 'hsl(31 100% 71%)',
  red:    'hsl(0 100% 67%)',
  yellow: 'hsl(65 92% 76%)',
  comment:'hsl(225 27% 51%)',
}
```

Status colors: completed → `DRACULA.green`, failed → `DRACULA.red`, canceled → `DRACULA.orange`, running → `DRACULA.cyan`.

### Custom Recharts tooltip

Wrap Recharts' default tooltip with a `CustomTooltip` component styled to match the Dracula glass card style (`bg-popover border border-border/30 rounded-lg p-2 text-xs`).

---

## Data Flow

```
User changes period
  → AnalyticsPage.handlePeriodChange(period)
    → setLoading(true)
    → fetch(`/api/analytics?period=${period}`)
      → server: getAnalytics(db, { period })
        → runs 8 SQLite queries
        → returns AnalyticsResponse JSON
    → setData(response)
    → setLoading(false)
  → All chart components re-render with new props
```

---

## Template Sync Strategy

`templates/web-manager/` is the source of truth for new installations. Every file created or modified under `specrails/web-manager/` MUST have a counterpart applied to `templates/web-manager/`. The sync is manual — after implementing in `specrails/web-manager/`, apply the identical change to `templates/web-manager/`.

Files with no template-specific differences (no `{{PLACEHOLDER}}` variables) are copied verbatim.

---

## Key Design Decisions

### Single endpoint vs. multiple endpoints

One `GET /api/analytics` endpoint returns the entire response rather than a separate endpoint per chart. Rationale: all charts share the same period filter; batching the queries in a single synchronous SQLite pass is faster than N parallel requests; the client has a single loading state; the response compresses well. The downside is the payload is larger (~5–15 KB for typical datasets), but this is negligible for a local tool.

### Recharts over Chart.js or D3

Recharts is React-native (renders SVG via React components), requires no imperative `useRef` canvas management, has first-class TypeScript types, and is the most widely used React charting library. Chart.js requires a canvas bridge. D3 requires building chart components from scratch. Recharts is the correct choice given the existing React/TypeScript stack.

### Client-side percentile computation

SQLite lacks native window functions for percentile calculation in the bundled `better-sqlite3` version. Rather than implementing a custom SQLite aggregate function, collecting duration values as a sorted array in JS and slicing at the desired quantile index is simpler, transparent to test, and fast enough for expected row counts (<50k). If row counts grow beyond 100k, revisit with a server-side approach.

### No WebSocket streaming for analytics

Analytics is a point-in-time snapshot. Adding a WebSocket subscription for chart data would add complexity with minimal benefit since charts are not expected to auto-refresh while the user is viewing them. A simple fetch-on-mount and fetch-on-period-change pattern is sufficient.
