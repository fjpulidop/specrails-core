import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AnalyticsResponse } from '../../types'

type KpiData = AnalyticsResponse['kpi']

interface KpiCardsProps {
  kpi: KpiData
}

function formatCost(usd: number) {
  return `$${usd.toFixed(4)}`
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  const totalSecs = Math.round(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins === 0) return `${secs}s`
  return `${mins}m ${secs}s`
}

function formatSuccessRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

interface TrendBadgeProps {
  delta: number | null
  // lowerIsBetter: green when delta < 0
  lowerIsBetter?: boolean
  formatter?: (v: number) => string
}

function TrendBadge({ delta, lowerIsBetter = false, formatter }: TrendBadgeProps) {
  if (delta === null) return null

  const isPositive = delta > 0
  const isGood = lowerIsBetter ? delta < 0 : delta > 0
  const isNeutral = delta === 0

  const formatted = formatter
    ? formatter(Math.abs(delta))
    : delta > 0
    ? `+${delta}`
    : `${delta}`

  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded',
        isNeutral
          ? 'text-muted-foreground bg-muted/40'
          : isGood
          ? 'text-green-400 bg-green-400/10'
          : 'text-red-400 bg-red-400/10'
      )}
    >
      {isNeutral ? (
        <Minus className="w-2.5 h-2.5" />
      ) : isPositive ? (
        <TrendingUp className="w-2.5 h-2.5" />
      ) : (
        <TrendingDown className="w-2.5 h-2.5" />
      )}
      {formatted}
    </span>
  )
}

interface CardProps {
  label: string
  value: string
  badge: React.ReactNode
}

function KpiCard({ label, value, badge }: CardProps) {
  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-end justify-between gap-2">
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {badge}
      </div>
    </div>
  )
}

export function KpiCards({ kpi }: KpiCardsProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard
        label="Total Cost"
        value={formatCost(kpi.totalCostUsd)}
        badge={
          <TrendBadge
            delta={kpi.costDelta}
            lowerIsBetter
            formatter={(v) => `$${v.toFixed(4)}`}
          />
        }
      />
      <KpiCard
        label="Total Jobs"
        value={String(kpi.totalJobs)}
        badge={
          <TrendBadge
            delta={kpi.jobsDelta}
            lowerIsBetter={false}
            formatter={(v) => `+${v}`}
          />
        }
      />
      <KpiCard
        label="Success Rate"
        value={formatSuccessRate(kpi.successRate)}
        badge={
          <TrendBadge
            delta={kpi.successRateDelta}
            lowerIsBetter={false}
            formatter={(v) => `${(v * 100).toFixed(1)}%`}
          />
        }
      />
      <KpiCard
        label="Avg Duration"
        value={formatDuration(kpi.avgDurationMs)}
        badge={
          <TrendBadge
            delta={kpi.avgDurationDelta}
            lowerIsBetter
            formatter={(v) => formatDuration(v)}
          />
        }
      />
    </div>
  )
}
