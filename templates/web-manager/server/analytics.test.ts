import { describe, it, expect, beforeEach } from 'vitest'
import { initDb } from './db'
import type { DbInstance } from './db'
import { getAnalytics } from './analytics'

function insertJob(
  db: DbInstance,
  opts: {
    id: string
    command?: string
    started_at: string
    status?: string
    total_cost_usd?: number | null
    duration_ms?: number | null
    duration_api_ms?: number | null
    model?: string | null
    tokens_in?: number | null
    tokens_out?: number | null
    tokens_cache_read?: number | null
  }
) {
  db.prepare(`
    INSERT INTO jobs (id, command, started_at, status, total_cost_usd, duration_ms, duration_api_ms, model, tokens_in, tokens_out, tokens_cache_read)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.command ?? 'test-command',
    opts.started_at,
    opts.status ?? 'completed',
    opts.total_cost_usd ?? null,
    opts.duration_ms ?? null,
    opts.duration_api_ms ?? null,
    opts.model ?? null,
    opts.tokens_in ?? null,
    opts.tokens_out ?? null,
    opts.tokens_cache_read ?? null,
  )
}

describe('getAnalytics', () => {
  let db: DbInstance

  beforeEach(() => {
    db = initDb(':memory:')
  })

  it('empty DB returns zero aggregates and empty arrays', () => {
    const result = getAnalytics(db, { period: '7d' })

    expect(result.kpi.totalJobs).toBe(0)
    expect(result.kpi.totalCostUsd).toBe(0)
    expect(result.kpi.successRate).toBe(0)
    expect(result.kpi.avgDurationMs).toBeNull()
    expect(result.statusBreakdown).toHaveLength(0)
    expect(result.tokenEfficiency).toHaveLength(0)
    expect(result.commandPerformance).toHaveLength(0)
    expect(result.durationPercentiles.p50).toBeNull()
    expect(result.durationPercentiles.p75).toBeNull()
    expect(result.durationPercentiles.p95).toBeNull()
  })

  it('single completed job populates KPI correctly', () => {
    insertJob(db, {
      id: 'job-1',
      command: 'sr:implement',
      started_at: new Date().toISOString(),
      status: 'completed',
      total_cost_usd: 0.0042,
      duration_ms: 90000,
    })

    const result = getAnalytics(db, { period: 'all' })

    expect(result.kpi.totalJobs).toBe(1)
    expect(result.kpi.totalCostUsd).toBeCloseTo(0.0042)
    expect(result.kpi.successRate).toBe(1)
    expect(result.kpi.avgDurationMs).toBe(90000)
    // 'all' period has no deltas
    expect(result.kpi.costDelta).toBeNull()
    expect(result.kpi.jobsDelta).toBeNull()
  })

  it('fills zero-cost date gaps in costTimeline', () => {
    // Insert jobs on day 1 and day 3 (gap on day 2)
    insertJob(db, {
      id: 'job-day1',
      started_at: '2026-03-01T12:00:00.000Z',
      status: 'completed',
      total_cost_usd: 0.001,
    })
    insertJob(db, {
      id: 'job-day3',
      started_at: '2026-03-03T12:00:00.000Z',
      status: 'completed',
      total_cost_usd: 0.002,
    })

    const result = getAnalytics(db, { period: 'custom', from: '2026-03-01', to: '2026-03-03' })

    expect(result.costTimeline).toHaveLength(3)
    const dates = result.costTimeline.map((r) => r.date)
    expect(dates).toContain('2026-03-01')
    expect(dates).toContain('2026-03-02')
    expect(dates).toContain('2026-03-03')

    const day2 = result.costTimeline.find((r) => r.date === '2026-03-02')
    expect(day2?.costUsd).toBe(0)
  })

  it('computes correct deltas when previous period has higher cost', () => {
    // Previous period: 2026-02-01 to 2026-02-07 with cost 0.010
    insertJob(db, {
      id: 'prev-job',
      started_at: '2026-02-04T12:00:00.000Z',
      status: 'completed',
      total_cost_usd: 0.010,
    })
    // Current period: 2026-02-08 to 2026-02-14 with cost 0.004
    insertJob(db, {
      id: 'curr-job',
      started_at: '2026-02-11T12:00:00.000Z',
      status: 'completed',
      total_cost_usd: 0.004,
    })

    const result = getAnalytics(db, { period: 'custom', from: '2026-02-08', to: '2026-02-14' })

    // costDelta = current - previous = 0.004 - 0.010 = -0.006
    expect(result.kpi.costDelta).not.toBeNull()
    expect(result.kpi.costDelta!).toBeCloseTo(-0.006, 5)
    // jobsDelta = 1 - 1 = 0
    expect(result.kpi.jobsDelta).toBe(0)
  })

  it('treats NULL cost job as 0 in aggregations', () => {
    insertJob(db, {
      id: 'null-cost-job',
      started_at: new Date().toISOString(),
      status: 'canceled',
      total_cost_usd: null,
    })

    const result = getAnalytics(db, { period: 'all' })

    expect(result.kpi.totalJobs).toBe(1)
    expect(result.kpi.totalCostUsd).toBe(0)
    // canceled job does not count toward success rate
    expect(result.kpi.successRate).toBe(0)
  })

  it('duration histogram returns fixed bucket order', () => {
    // Insert jobs spanning multiple buckets
    insertJob(db, { id: 'j1', started_at: new Date().toISOString(), status: 'completed', duration_ms: 30000 })  // <1m
    insertJob(db, { id: 'j2', started_at: new Date().toISOString(), status: 'completed', duration_ms: 120000 }) // 1-3m
    insertJob(db, { id: 'j3', started_at: new Date().toISOString(), status: 'completed', duration_ms: 700000 }) // >10m

    const result = getAnalytics(db, { period: 'all' })

    const buckets = result.durationHistogram.map((r) => r.bucket)
    expect(buckets).toEqual(['<1m', '1-3m', '3-5m', '5-10m', '>10m'])
    expect(result.durationHistogram.find((r) => r.bucket === '<1m')?.count).toBe(1)
    expect(result.durationHistogram.find((r) => r.bucket === '1-3m')?.count).toBe(1)
    expect(result.durationHistogram.find((r) => r.bucket === '3-5m')?.count).toBe(0)
    expect(result.durationHistogram.find((r) => r.bucket === '>10m')?.count).toBe(1)
  })
})
