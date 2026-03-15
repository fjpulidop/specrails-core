import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import { DRACULA } from '../../lib/dracula-colors'
import type { AnalyticsResponse } from '../../types'

interface DurationHistogramProps {
  data: AnalyticsResponse['durationHistogram']
  percentiles: AnalyticsResponse['durationPercentiles']
}

const BUCKET_ORDER = ['<1m', '1-3m', '3-5m', '5-10m', '>10m']

function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  const secs = Math.round(ms / 1000)
  const mins = Math.floor(secs / 60)
  const s = secs % 60
  if (mins === 0) return `${s}s`
  return `${mins}m ${s}s`
}

interface TooltipPayload {
  value: number
}

interface CustomTooltipProps {
  active?: boolean
  payload?: TooltipPayload[]
  label?: string
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-popover border border-border/30 rounded-lg p-2 text-xs shadow-lg">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-medium">{payload[0].value} jobs</p>
    </div>
  )
}

export function DurationHistogram({ data, percentiles }: DurationHistogramProps) {
  // Enforce fixed bucket order regardless of SQL return order
  const sorted = BUCKET_ORDER.map((bucket) => {
    const found = data.find((d) => d.bucket === bucket)
    return { bucket, count: found?.count ?? 0 }
  })

  const hasData = sorted.some((d) => d.count > 0)

  if (!hasData) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Duration Distribution</h3>
        <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
          No duration data available
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h3 className="text-sm font-medium mb-3">Duration Distribution</h3>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={sorted} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="bucket"
            tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            width={30}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="count" fill={DRACULA.cyan} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>

      <div className="flex items-center gap-3 mt-2">
        {(['p50', 'p75', 'p95'] as const).map((key) => (
          <div key={key} className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground uppercase">{key}:</span>
            <span className="text-[10px] font-medium tabular-nums">
              {formatMs(percentiles[key])}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
