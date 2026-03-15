import type { AnalyticsResponse } from '../../types'

interface BonusMetricsProps {
  data: AnalyticsResponse['bonusMetrics']
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-3 space-y-1">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-base font-semibold tabular-nums">{value}</p>
    </div>
  )
}

export function BonusMetrics({ data }: BonusMetricsProps) {
  const costPerSuccess = data.costPerSuccess !== null
    ? `$${data.costPerSuccess.toFixed(4)}`
    : '—'

  const apiEfficiency = data.apiEfficiencyPct !== null
    ? `${data.apiEfficiencyPct.toFixed(0)}%`
    : '—'

  const failureCost = `$${data.failureCostUsd.toFixed(4)}`

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4 space-y-4">
      <h3 className="text-sm font-medium">Bonus Metrics</h3>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Cost per Success" value={costPerSuccess} />
        <StatCard label="API Efficiency" value={apiEfficiency} />
        <StatCard label="Failure Cost" value={failureCost} />
      </div>

      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-2">Model Breakdown</h4>
        {data.modelBreakdown.length === 0 ? (
          <p className="text-xs text-muted-foreground">No model data for this period</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Model</th>
                  <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Jobs</th>
                  <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Total Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.modelBreakdown.map((row) => (
                  <tr key={row.model} className="border-b border-border/20">
                    <td className="px-3 py-1.5 font-mono text-[10px]">{row.model}</td>
                    <td className="px-3 py-1.5 tabular-nums">{row.jobCount}</td>
                    <td className="px-3 py-1.5 tabular-nums">${row.totalCostUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
