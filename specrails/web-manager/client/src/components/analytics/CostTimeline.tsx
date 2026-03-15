import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import { format } from 'date-fns'
import { DRACULA } from '../../lib/dracula-colors'
import type { AnalyticsResponse } from '../../types'

interface CostTimelineProps {
  data: AnalyticsResponse['costTimeline']
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
      <p className="font-medium">${payload[0].value.toFixed(4)}</p>
    </div>
  )
}

function formatXAxis(dateStr: string): string {
  try {
    return format(new Date(dateStr), 'MMM d')
  } catch {
    return dateStr
  }
}

export function CostTimeline({ data }: CostTimelineProps) {
  const hasData = data.length > 0 && data.some((d) => d.costUsd > 0)

  if (!hasData) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Cost Over Time</h3>
        <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
          No cost data for this period
        </div>
      </div>
    )
  }

  // Thin out x-axis labels for dense datasets
  const tickStep = Math.max(1, Math.floor(data.length / 7))
  const ticks = data
    .filter((_, i) => i % tickStep === 0)
    .map((d) => d.date)

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h3 className="text-sm font-medium mb-3">Cost Over Time</h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="date"
            ticks={ticks}
            tickFormatter={formatXAxis}
            tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            width={55}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="costUsd"
            stroke={DRACULA.purple}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3, fill: DRACULA.purple }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
