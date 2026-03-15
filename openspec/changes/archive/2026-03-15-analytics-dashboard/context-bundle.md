---
id: analytics-dashboard
type: context-bundle
status: draft
created: 2026-03-15
---

# Context Bundle — Analytics Dashboard

This document provides exact per-file change specifications. The developer MUST apply each change to `templates/web-manager/` first, then sync to `specrails/web-manager/`.

---

## New files

### `templates/web-manager/server/analytics.ts`

**Purpose:** All analytics SQLite queries and the `getAnalytics` function.

**Full content to create:**

```ts
import type { DbInstance } from './db'
import type { AnalyticsOpts, AnalyticsResponse } from './types'

// ─── Period resolution ────────────────────────────────────────────────────────

interface DateBounds {
  from: string | null
  to: string | null
}

function resolveBounds(opts: AnalyticsOpts): { current: DateBounds; previous: DateBounds | null } {
  const now = new Date()
  const toISO = (d: Date) => d.toISOString().slice(0, 10)

  if (opts.period === 'all') {
    return { current: { from: null, to: null }, previous: null }
  }

  if (opts.period === 'custom') {
    const from = opts.from!
    const to = opts.to!
    const diffMs = new Date(to).getTime() - new Date(from).getTime()
    const prevTo = new Date(new Date(from).getTime() - 1).toISOString().slice(0, 10)
    const prevFrom = toISO(new Date(new Date(from).getTime() - diffMs - 86400000))
    return {
      current: { from, to },
      previous: { from: prevFrom, to: prevTo },
    }
  }

  const days = opts.period === '7d' ? 7 : opts.period === '30d' ? 30 : 90
  const currentFrom = toISO(new Date(now.getTime() - days * 86400000))
  const currentTo = toISO(now)
  const prevTo = toISO(new Date(new Date(currentFrom).getTime() - 86400000))
  const prevFrom = toISO(new Date(new Date(currentFrom).getTime() - days * 86400000))

  return {
    current: { from: currentFrom, to: currentTo },
    previous: { from: prevFrom, to: prevTo },
  }
}

function buildWhere(bounds: DateBounds): { clause: string; params: unknown[] } {
  if (!bounds.from && !bounds.to) return { clause: '', params: [] }
  if (bounds.from && bounds.to) {
    return {
      clause: "WHERE started_at >= ? AND started_at <= ?",
      params: [bounds.from, bounds.to],
    }
  }
  if (bounds.from) return { clause: 'WHERE started_at >= ?', params: [bounds.from] }
  return { clause: 'WHERE started_at <= ?', params: [bounds.to] }
}

// ─── Percentile helpers ───────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.floor(sorted.length * p)
  return sorted[Math.min(idx, sorted.length - 1)]
}

// ─── Date series zero-fill ────────────────────────────────────────────────────

function fillDateSeries(
  data: Array<{ date: string; [key: string]: unknown }>,
  from: string,
  to: string,
  keys: string[]
): Array<Record<string, unknown>> {
  const byDate = new Map(data.map((row) => [row.date, row]))
  const result: Array<Record<string, unknown>> = []
  const start = new Date(from)
  const end = new Date(to)
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10)
    const row = byDate.get(date) ?? { date }
    const filled: Record<string, unknown> = { date }
    for (const key of keys) {
      filled[key] = (row as Record<string, unknown>)[key] ?? 0
    }
    result.push(filled)
  }
  return result
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function getAnalytics(db: DbInstance, opts: AnalyticsOpts): AnalyticsResponse {
  const { current, previous } = resolveBounds(opts)
  const { clause: curWhere, params: curParams } = buildWhere(current)

  const periodLabel = opts.period === '7d' ? 'Last 7 days'
    : opts.period === '30d' ? 'Last 30 days'
    : opts.period === '90d' ? 'Last 90 days'
    : opts.period === 'all' ? 'All time'
    : `${opts.from} to ${opts.to}`

  // ── KPI aggregate ──────────────────────────────────────────────────────────
  const kpiRow = db.prepare(`
    SELECT
      COUNT(*) as totalJobs,
      COALESCE(SUM(total_cost_usd), 0) as totalCostUsd,
      AVG(duration_ms) as avgDurationMs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successCount
    FROM jobs ${curWhere}
  `).get(...curParams) as {
    totalJobs: number
    totalCostUsd: number
    avgDurationMs: number | null
    successCount: number
  }

  const successRate = kpiRow.totalJobs > 0 ? kpiRow.successCount / kpiRow.totalJobs : 0

  let prevKpi: typeof kpiRow | null = null
  let prevSuccessRate = 0
  if (previous) {
    const { clause: prevWhere, params: prevParams } = buildWhere(previous)
    prevKpi = db.prepare(`
      SELECT
        COUNT(*) as totalJobs,
        COALESCE(SUM(total_cost_usd), 0) as totalCostUsd,
        AVG(duration_ms) as avgDurationMs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successCount
      FROM jobs ${prevWhere}
    `).get(...prevParams) as typeof kpiRow
    prevSuccessRate = prevKpi.totalJobs > 0 ? prevKpi.successCount / prevKpi.totalJobs : 0
  }

  // ── Cost timeline ──────────────────────────────────────────────────────────
  const rawTimeline = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', started_at) as date,
      COALESCE(SUM(total_cost_usd), 0) as costUsd
    FROM jobs ${curWhere}
    GROUP BY date
    ORDER BY date ASC
  `).all(...curParams) as Array<{ date: string; costUsd: number }>

  const costTimeline = current.from && current.to
    ? fillDateSeries(rawTimeline, current.from, current.to, ['costUsd']) as Array<{ date: string; costUsd: number }>
    : rawTimeline

  // ── Status breakdown ───────────────────────────────────────────────────────
  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM jobs ${curWhere}
    GROUP BY status
  `).all(...curParams) as Array<{ status: string; count: number }>

  // ── Duration histogram ─────────────────────────────────────────────────────
  const durationWhere = curWhere
    ? `${curWhere} AND duration_ms IS NOT NULL AND status = 'completed'`
    : "WHERE duration_ms IS NOT NULL AND status = 'completed'"

  const rawHistogram = db.prepare(`
    SELECT
      CASE
        WHEN duration_ms < 60000 THEN '<1m'
        WHEN duration_ms < 180000 THEN '1-3m'
        WHEN duration_ms < 300000 THEN '3-5m'
        WHEN duration_ms < 600000 THEN '5-10m'
        ELSE '>10m'
      END as bucket,
      COUNT(*) as count
    FROM jobs ${durationWhere}
    GROUP BY bucket
  `).all(...curParams) as Array<{ bucket: string; count: number }>

  const BUCKET_ORDER = ['<1m', '1-3m', '3-5m', '5-10m', '>10m']
  const bucketMap = new Map(rawHistogram.map((r) => [r.bucket, r.count]))
  const durationHistogram = BUCKET_ORDER.map((bucket) => ({
    bucket,
    count: bucketMap.get(bucket) ?? 0,
  }))

  // Percentiles computed in JS from sorted duration array
  const durRows = db.prepare(`
    SELECT duration_ms FROM jobs ${durationWhere} ORDER BY duration_ms ASC
  `).all(...curParams) as Array<{ duration_ms: number }>
  const sortedDurations = durRows.map((r) => r.duration_ms)

  // ── Token efficiency ───────────────────────────────────────────────────────
  const tokenEfficiency = db.prepare(`
    SELECT
      command,
      COALESCE(SUM(tokens_out), 0) as tokensOut,
      COALESCE(SUM(tokens_cache_read), 0) as tokensCacheRead,
      COALESCE(SUM(tokens_in) + SUM(tokens_out), 0) as totalTokens
    FROM jobs ${curWhere}
    GROUP BY command
    ORDER BY totalTokens DESC
    LIMIT 10
  `).all(...curParams) as Array<{
    command: string
    tokensOut: number
    tokensCacheRead: number
    totalTokens: number
  }>

  // ── Command performance ────────────────────────────────────────────────────
  const commandPerformance = db.prepare(`
    SELECT
      command,
      COUNT(*) as totalRuns,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successCount,
      AVG(CASE WHEN total_cost_usd IS NOT NULL THEN total_cost_usd END) as avgCostUsd,
      AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avgDurationMs,
      COALESCE(SUM(total_cost_usd), 0) as totalCostUsd
    FROM jobs ${curWhere}
    GROUP BY command
    ORDER BY totalCostUsd DESC
  `).all(...curParams) as Array<{
    command: string
    totalRuns: number
    successCount: number
    avgCostUsd: number | null
    avgDurationMs: number | null
    totalCostUsd: number
  }>

  // ── Daily throughput ───────────────────────────────────────────────────────
  const rawThroughput = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', started_at) as date,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'canceled'  THEN 1 ELSE 0 END) as canceled
    FROM jobs ${curWhere}
    GROUP BY date
    ORDER BY date ASC
  `).all(...curParams) as Array<{ date: string; completed: number; failed: number; canceled: number }>

  const dailyThroughput = current.from && current.to
    ? fillDateSeries(rawThroughput, current.from, current.to, ['completed', 'failed', 'canceled']) as typeof rawThroughput
    : rawThroughput

  // ── Cost per command ───────────────────────────────────────────────────────
  const costPerCommand = db.prepare(`
    SELECT
      command,
      COALESCE(SUM(total_cost_usd), 0) as totalCostUsd,
      COUNT(*) as jobCount
    FROM jobs ${curWhere}
    GROUP BY command
    ORDER BY totalCostUsd DESC
  `).all(...curParams) as Array<{ command: string; totalCostUsd: number; jobCount: number }>

  // ── Bonus metrics ──────────────────────────────────────────────────────────
  const successCount = kpiRow.successCount
  const failureCostRow = db.prepare(`
    SELECT COALESCE(SUM(total_cost_usd), 0) as failureCostUsd
    FROM jobs ${curWhere ? `${curWhere} AND` : 'WHERE'} status = 'failed'
  `).get(...curParams) as { failureCostUsd: number }

  // API efficiency: only for jobs that have both duration fields
  const efficiencyRow = db.prepare(`
    SELECT AVG(CAST(duration_api_ms AS REAL) / CAST(duration_ms AS REAL)) as ratio
    FROM jobs ${curWhere ? `${curWhere} AND` : 'WHERE'} duration_ms > 0 AND duration_api_ms IS NOT NULL
  `).get(...curParams) as { ratio: number | null }

  const modelBreakdown = db.prepare(`
    SELECT
      COALESCE(model, 'unknown') as model,
      COUNT(*) as jobCount,
      COALESCE(SUM(total_cost_usd), 0) as totalCostUsd
    FROM jobs ${curWhere}
    GROUP BY model
    ORDER BY totalCostUsd DESC
  `).all(...curParams) as Array<{ model: string; jobCount: number; totalCostUsd: number }>

  return {
    period: {
      label: periodLabel,
      from: current.from,
      to: current.to,
    },
    kpi: {
      totalCostUsd: kpiRow.totalCostUsd,
      totalJobs: kpiRow.totalJobs,
      successRate,
      avgDurationMs: kpiRow.avgDurationMs,
      costDelta: prevKpi !== null ? kpiRow.totalCostUsd - prevKpi.totalCostUsd : null,
      jobsDelta: prevKpi !== null ? kpiRow.totalJobs - prevKpi.totalJobs : null,
      successRateDelta: prevKpi !== null ? successRate - prevSuccessRate : null,
      avgDurationDelta:
        prevKpi !== null && kpiRow.avgDurationMs !== null && prevKpi.avgDurationMs !== null
          ? kpiRow.avgDurationMs - prevKpi.avgDurationMs
          : null,
    },
    costTimeline,
    statusBreakdown,
    durationHistogram,
    durationPercentiles: {
      p50: percentile(sortedDurations, 0.5),
      p75: percentile(sortedDurations, 0.75),
      p95: percentile(sortedDurations, 0.95),
    },
    tokenEfficiency,
    commandPerformance: commandPerformance.map((r) => ({
      ...r,
      successRate: r.totalRuns > 0 ? r.successCount / r.totalRuns : 0,
    })),
    dailyThroughput,
    costPerCommand,
    bonusMetrics: {
      costPerSuccess: successCount > 0 ? kpiRow.totalCostUsd / successCount : null,
      apiEfficiencyPct: efficiencyRow.ratio !== null ? efficiencyRow.ratio * 100 : null,
      failureCostUsd: failureCostRow.failureCostUsd,
      modelBreakdown,
    },
  }
}
```

---

### `templates/web-manager/server/analytics.test.ts`

**Purpose:** Unit tests for `getAnalytics`.

**Key test structure:**
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { initDb } from './db'
import { getAnalytics } from './analytics'

describe('getAnalytics', () => {
  it('empty DB returns zero aggregates', ...)
  it('single completed job populates KPI', ...)
  it('fills zero-cost date gaps in costTimeline', ...)
  it('computes correct deltas between periods', ...)
  it('treats NULL cost as 0 in aggregations', ...)
})
```

---

### `templates/web-manager/client/src/lib/dracula-colors.ts`

```ts
export const DRACULA = {
  purple:  'hsl(265 89% 78%)',
  cyan:    'hsl(191 97% 77%)',
  green:   'hsl(135 94% 65%)',
  pink:    'hsl(326 100% 74%)',
  orange:  'hsl(31 100% 71%)',
  red:     'hsl(0 100% 67%)',
  yellow:  'hsl(65 92% 76%)',
  comment: 'hsl(225 27% 51%)',
}

export const STATUS_COLORS: Record<string, string> = {
  completed: DRACULA.green,
  failed:    DRACULA.red,
  canceled:  DRACULA.orange,
  running:   DRACULA.cyan,
  queued:    DRACULA.comment,
}

export const CHART_PALETTE = [
  DRACULA.purple,
  DRACULA.cyan,
  DRACULA.green,
  DRACULA.pink,
  DRACULA.orange,
]
```

---

### `templates/web-manager/client/src/components/analytics/` (directory)

Create directory. All chart components go here. Each is a standalone `.tsx` file.

---

### `templates/web-manager/client/src/pages/AnalyticsPage.tsx`

See Task 18 for structure. Key data-fetching pattern to use AbortController:

```ts
useEffect(() => {
  const controller = new AbortController()
  setLoading(true)
  setError(null)

  const params = new URLSearchParams({ period })
  if (period === 'custom' && from && to) {
    params.set('from', from)
    params.set('to', to)
  }

  fetch(`/api/analytics?${params}`, { signal: controller.signal })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<AnalyticsResponse>
    })
    .then((data) => {
      setData(data)
      setLoading(false)
    })
    .catch((err) => {
      if (err.name === 'AbortError') return
      setError(err.message)
      setLoading(false)
    })

  return () => controller.abort()
}, [period, from, to])
```

---

## Modified files

### `templates/web-manager/server/types.ts`

**Add after `StatsRow` interface:**

```ts
export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all' | 'custom'

export interface AnalyticsOpts {
  period: AnalyticsPeriod
  from?: string
  to?: string
}

export interface AnalyticsResponse {
  period: {
    label: string
    from: string | null
    to: string | null
  }
  kpi: {
    totalCostUsd: number
    totalJobs: number
    successRate: number
    avgDurationMs: number | null
    costDelta: number | null
    jobsDelta: number | null
    successRateDelta: number | null
    avgDurationDelta: number | null
  }
  costTimeline: Array<{ date: string; costUsd: number }>
  statusBreakdown: Array<{ status: string; count: number }>
  durationHistogram: Array<{ bucket: string; count: number }>
  durationPercentiles: { p50: number | null; p75: number | null; p95: number | null }
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
  dailyThroughput: Array<{ date: string; completed: number; failed: number; canceled: number }>
  costPerCommand: Array<{ command: string; totalCostUsd: number; jobCount: number }>
  bonusMetrics: {
    costPerSuccess: number | null
    apiEfficiencyPct: number | null
    failureCostUsd: number
    modelBreakdown: Array<{ model: string; jobCount: number; totalCostUsd: number }>
  }
}
```

---

### `templates/web-manager/client/src/types.ts`

**Add after `IssueItem` interface:**

```ts
export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all' | 'custom'

export interface AnalyticsResponse {
  period: {
    label: string
    from: string | null
    to: string | null
  }
  kpi: {
    totalCostUsd: number
    totalJobs: number
    successRate: number
    avgDurationMs: number | null
    costDelta: number | null
    jobsDelta: number | null
    successRateDelta: number | null
    avgDurationDelta: number | null
  }
  costTimeline: Array<{ date: string; costUsd: number }>
  statusBreakdown: Array<{ status: string; count: number }>
  durationHistogram: Array<{ bucket: string; count: number }>
  durationPercentiles: { p50: number | null; p75: number | null; p95: number | null }
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
  dailyThroughput: Array<{ date: string; completed: number; failed: number; canceled: number }>
  costPerCommand: Array<{ command: string; totalCostUsd: number; jobCount: number }>
  bonusMetrics: {
    costPerSuccess: number | null
    apiEfficiencyPct: number | null
    failureCostUsd: number
    modelBreakdown: Array<{ model: string; jobCount: number; totalCostUsd: number }>
  }
}
```

Note: The client type intentionally mirrors the server type exactly. The same interface definition is duplicated across the boundary since there is no shared package — this is consistent with the existing pattern for `JobSummary`, `EventRow`, etc.

---

### `templates/web-manager/server/index.ts`

**Add import at top (with other imports):**
```ts
import { getAnalytics } from './analytics'
import type { AnalyticsOpts } from './types'
```

**Add route after `/api/stats` GET (around line 224):**
```ts
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

### `templates/web-manager/client/src/App.tsx`

**Full replacement content:**
```tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import { RootLayout } from './components/RootLayout'
import DashboardPage from './pages/DashboardPage'
import SettingsPage from './pages/SettingsPage'
import AnalyticsPage from './pages/AnalyticsPage'

export default function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/jobs/:id" element={<DashboardPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
```

---

### `templates/web-manager/client/src/components/Navbar.tsx`

**Modified import line — add `LayoutDashboard` and `BarChart3`:**
```ts
import { Settings, BookOpen, Github, ExternalLink, X, LayoutDashboard, BarChart3 } from 'lucide-react'
```

**Modified JSX — replace the `{/* Right-side actions */}` block structure:**

The outer `<nav>` content changes from a two-part (wordmark + actions) to three-part layout:

```tsx
<nav className="h-11 flex items-center justify-between px-4 border-b border-border/30 bg-background/80 backdrop-blur-sm">
  {/* Wordmark */}
  <NavLink to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
    <span className="font-mono text-sm font-bold">
      <span className="text-dracula-purple">spec</span>
      <span className="text-dracula-pink">rails</span>
    </span>
    <span className="text-muted-foreground text-[11px] font-normal">/ manager</span>
  </NavLink>

  {/* Center nav links */}
  <div className="flex items-center gap-1">
    <NavLink
      to="/"
      end
      className={({ isActive }) =>
        cn(
          'h-7 px-2 flex items-center gap-1.5 rounded-md text-xs transition-colors',
          isActive
            ? 'text-primary bg-dracula-current/50'
            : 'text-muted-foreground hover:text-foreground hover:bg-dracula-current/50'
        )
      }
    >
      <LayoutDashboard className="w-3.5 h-3.5" />
      <span>Home</span>
    </NavLink>
    <NavLink
      to="/analytics"
      className={({ isActive }) =>
        cn(
          'h-7 px-2 flex items-center gap-1.5 rounded-md text-xs transition-colors',
          isActive
            ? 'text-primary bg-dracula-current/50'
            : 'text-muted-foreground hover:text-foreground hover:bg-dracula-current/50'
        )
      }
    >
      <BarChart3 className="w-3.5 h-3.5" />
      <span>Analytics</span>
    </NavLink>
  </div>

  {/* Right-side actions (preserved exactly) */}
  <div className="flex items-center gap-1">
    {/* ... existing Docs, GitHub, Settings ... */}
  </div>
</nav>
```

---

### `templates/web-manager/client/package.json`

**Add to `dependencies`:**
```json
"recharts": "^2.12.0"
```

---

## Dependencies map

```
server/types.ts          ← must exist before analytics.ts and client/types.ts
server/analytics.ts      ← imports DbInstance from db.ts, types from types.ts
server/index.ts          ← imports getAnalytics from analytics.ts
client/types.ts          ← must exist before any analytics component
client/package.json      ← recharts must be installed before any chart component
lib/dracula-colors.ts    ← must exist before chart components
components/analytics/*   ← depend on types.ts and dracula-colors.ts
pages/AnalyticsPage.tsx  ← depends on all chart components
App.tsx                  ← depends on AnalyticsPage.tsx
Navbar.tsx               ← depends on App.tsx route being registered
```

---

## Risks and mitigations

### Risk: Recharts Treemap label overflow

Recharts `Treemap` renders labels as SVG text that can overflow small tiles. Mitigation: use a custom `content` renderer that checks tile width before rendering text, and applies CSS `overflow: hidden` or truncation.

### Risk: SQLite date filtering edge cases

`started_at` is stored as ISO 8601 with millisecond precision (e.g., `2026-03-15T14:23:01.000Z`). Comparing against `YYYY-MM-DD` strings works because ISO 8601 strings are lexicographically sortable. However, timezone is implicitly UTC — if the server runs in a non-UTC timezone, `strftime('%Y-%m-%d', started_at)` will return UTC dates which may not match the user's local date. Accept this limitation for the MVP (document as UTC-only).

### Risk: Large row counts for percentile query

The raw duration query (`SELECT duration_ms ... ORDER BY duration_ms`) loads all matching rows into JS memory. For a database with 10,000 completed jobs this is ~80 KB. For 100,000 it is ~800 KB. Acceptable for a local tool, but if this becomes a concern, switch to a CTe-based approximate percentile using `ntile()` or similar.

### Risk: Recharts v2 vs v3 API surface

Recharts v3 is in release candidate stage. Pin to `^2.12.0` and document this constraint. If v3 stabilizes and ships before implementation, re-evaluate — the API differences are significant enough to warrant a conscious decision rather than an accidental upgrade.

### Risk: Template/instance divergence

Per the reviewer learnings: after making changes in `templates/web-manager/`, the developer must explicitly sync to `specrails/web-manager/`. There is no automated sync. The sync checklist in `tasks.md` must be followed for every task. The architect recommends: do all template changes first, then do a single bulk sync pass to `specrails/web-manager/` to reduce the number of context switches.

### Risk: Field name mismatches between server and client

The `AnalyticsResponse` interface is duplicated in both `server/types.ts` and `client/src/types.ts`. These must be kept in sync manually. The context-bundle includes the exact field names for both copies to prevent divergence. Cross-reference: all field names use camelCase for scalar KPI fields and snake_case for array row objects (consistent with existing `JobSummary` pattern).

### Risk: Zero-fill logic for sparse datasets

The `fillDateSeries` helper fills all dates between `from` and `to` inclusive. For the `'all'` period, `from` and `to` are null, so no zero-fill is applied — the timeline will only have rows for days with actual jobs (no gap filling). This is correct behavior for the `'all'` period since we don't know the implied date range.
