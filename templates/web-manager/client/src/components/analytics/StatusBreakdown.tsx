import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts'
import { STATUS_COLORS } from '../../lib/dracula-colors'
import type { AnalyticsResponse } from '../../types'

interface StatusBreakdownProps {
  data: AnalyticsResponse['statusBreakdown']
}

interface TooltipPayload {
  name: string
  value: number
}

interface CustomTooltipProps {
  active?: boolean
  payload?: TooltipPayload[]
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  const item = payload[0]
  return (
    <div className="bg-popover border border-border/30 rounded-lg p-2 text-xs shadow-lg">
      <p className="capitalize font-medium">{item.name}</p>
      <p className="text-muted-foreground">{item.value} jobs</p>
    </div>
  )
}

export function StatusBreakdown({ data }: StatusBreakdownProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Jobs by Status</h3>
        <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
          No jobs in this period
        </div>
      </div>
    )
  }

  const total = data.reduce((sum, d) => sum + d.count, 0)

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h3 className="text-sm font-medium mb-3">Jobs by Status</h3>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="status"
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={90}
            paddingAngle={2}
          >
            {data.map((entry) => (
              <Cell
                key={entry.status}
                fill={STATUS_COLORS[entry.status] ?? 'var(--color-muted-foreground)'}
              />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          <Legend
            formatter={(value: string) => {
              const entry = data.find((d) => d.status === value)
              const pct = entry ? ((entry.count / total) * 100).toFixed(0) : '0'
              return (
                <span className="text-xs capitalize">
                  {value} ({entry?.count ?? 0}, {pct}%)
                </span>
              )
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
