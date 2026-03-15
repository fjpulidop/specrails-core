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
    // Use < next_day instead of <= to, because started_at is a full ISO timestamp
    // e.g. '2026-03-15T14:00:00Z' > '2026-03-15' lexicographically
    const nextDay = new Date(new Date(bounds.to).getTime() + 86400000).toISOString().slice(0, 10)
    return {
      clause: "WHERE started_at >= ? AND started_at < ?",
      params: [bounds.from, nextDay],
    }
  }
  if (bounds.from) return { clause: 'WHERE started_at >= ?', params: [bounds.from] }
  const nextDay = new Date(new Date(bounds.to!).getTime() + 86400000).toISOString().slice(0, 10)
  return { clause: 'WHERE started_at < ?', params: [nextDay] }
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
