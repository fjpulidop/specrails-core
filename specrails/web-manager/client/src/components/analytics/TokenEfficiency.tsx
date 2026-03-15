import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts'
import { DRACULA } from '../../lib/dracula-colors'
import type { AnalyticsResponse } from '../../types'

interface TokenEfficiencyProps {
  data: AnalyticsResponse['tokenEfficiency']
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
      <p className="text-muted-foreground mb-1 font-mono truncate max-w-48">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {p.value.toLocaleString()}
        </p>
      ))}
    </div>
  )
}

export function TokenEfficiency({ data }: TokenEfficiencyProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Token Efficiency</h3>
        <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
          No token data for this period
        </div>
      </div>
    )
  }

  // Truncate long command names for display
  const chartData = data.map((d) => ({
    ...d,
    name: d.command.length > 20 ? `…${d.command.slice(-18)}` : d.command,
  }))

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h3 className="text-sm font-medium mb-3">Token Efficiency</h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={110}
            tick={{ fontSize: 9, fill: 'var(--color-muted-foreground)', fontFamily: 'monospace' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            formatter={(value: string) => (
              <span className="text-xs">{value}</span>
            )}
          />
          <Bar dataKey="tokensOut" name="Output tokens" fill={DRACULA.purple} stackId="a" radius={[0, 3, 3, 0]} />
          <Bar dataKey="tokensCacheRead" name="Cached tokens" fill={DRACULA.cyan} stackId="a" radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
