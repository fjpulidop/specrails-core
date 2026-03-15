import { ResponsiveContainer, Treemap, Tooltip } from 'recharts'
import { CHART_PALETTE } from '../../lib/dracula-colors'
import type { AnalyticsResponse } from '../../types'

interface CostTreemapProps {
  data: AnalyticsResponse['costPerCommand']
}

interface TreemapNode {
  name: string
  size: number
  jobCount: number
  colorIndex: number
}

interface ContentProps {
  x?: number
  y?: number
  width?: number
  height?: number
  name?: string
  size?: number
}

function CustomContent({ x = 0, y = 0, width = 0, height = 0, name = '', size = 0, colorIndex = 0 }: ContentProps & { colorIndex?: number }) {
  const color = CHART_PALETTE[colorIndex % CHART_PALETTE.length]
  const showLabel = width > 50 && height > 30

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        style={{ fill: color, fillOpacity: 0.8, stroke: 'var(--color-background)', strokeWidth: 2 }}
        rx={4}
      />
      {showLabel && (
        <>
          <text
            x={x + 6}
            y={y + 16}
            fill="var(--color-background)"
            fontSize={10}
            fontFamily="monospace"
            style={{ overflow: 'hidden' }}
          >
            {name.length > Math.floor(width / 6) ? name.slice(0, Math.floor(width / 6) - 1) + '…' : name}
          </text>
          {height > 45 && (
            <text
              x={x + 6}
              y={y + 30}
              fill="hsl(231 15% 18% / 0.7)"
              fontSize={9}
            >
              ${size.toFixed(4)}
            </text>
          )}
        </>
      )}
    </g>
  )
}

interface TooltipPayload {
  payload?: { name: string; size: number; jobCount: number }
}

interface CustomTooltipProps {
  active?: boolean
  payload?: TooltipPayload[]
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  const data = payload[0].payload
  if (!data) return null
  return (
    <div className="bg-popover border border-border/30 rounded-lg p-2 text-xs shadow-lg">
      <p className="font-mono font-medium mb-1">{data.name}</p>
      <p className="text-muted-foreground">Cost: ${data.size.toFixed(4)}</p>
      <p className="text-muted-foreground">Jobs: {data.jobCount}</p>
    </div>
  )
}

export function CostTreemap({ data }: CostTreemapProps) {
  const filtered = data.filter((d) => d.totalCostUsd > 0)

  if (filtered.length === 0) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Cost per Command</h3>
        <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
          No cost data for this period
        </div>
      </div>
    )
  }

  const chartData: TreemapNode[] = filtered.map((d, i) => ({
    name: d.command,
    size: d.totalCostUsd,
    jobCount: d.jobCount,
    colorIndex: i,
  }))

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h3 className="text-sm font-medium mb-3">Cost per Command</h3>
      <ResponsiveContainer width="100%" height={220}>
        <Treemap
          data={chartData}
          dataKey="size"
          content={<CustomContent />}
        >
          <Tooltip content={<CustomTooltip />} />
        </Treemap>
      </ResponsiveContainer>
    </div>
  )
}
