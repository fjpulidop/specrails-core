import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts'
import { format } from 'date-fns'
import { DRACULA } from '../../lib/dracula-colors'
import type { AnalyticsResponse } from '../../types'

interface DailyThroughputProps {
  data: AnalyticsResponse['dailyThroughput']
}

interface TooltipPayload {
  name: string
  value: number
  color: string
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
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {p.value}
        </p>
      ))}
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

export function DailyThroughput({ data }: DailyThroughputProps) {
  const hasData = data.length > 0 && data.some((d) => d.completed + d.failed + d.canceled > 0)

  if (!hasData) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Daily Throughput</h3>
        <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
          No throughput data for this period
        </div>
      </div>
    )
  }

  const tickStep = Math.max(1, Math.floor(data.length / 7))
  const ticks = data.filter((_, i) => i % tickStep === 0).map((d) => d.date)

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h3 className="text-sm font-medium mb-3">Daily Throughput</h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="date"
            ticks={ticks}
            tickFormatter={formatXAxis}
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
          <Legend formatter={(v: string) => <span className="text-xs capitalize">{v}</span>} />
          <Bar dataKey="completed" name="Completed" stackId="a" fill={DRACULA.purple} />
          <Bar dataKey="failed"    name="Failed"    stackId="a" fill={DRACULA.pink} />
          <Bar dataKey="canceled"  name="Canceled"  stackId="a" fill={DRACULA.orange} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
