import { useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AnalyticsResponse } from '../../types'

interface CommandPerformanceProps {
  data: AnalyticsResponse['commandPerformance']
}

type SortKey = 'command' | 'totalRuns' | 'successRate' | 'avgCostUsd' | 'avgDurationMs' | 'totalCostUsd'
type SortDir = 'asc' | 'desc'

function formatCost(v: number | null): string {
  if (v === null) return '—'
  return `$${v.toFixed(4)}`
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  const secs = Math.round(ms / 1000)
  const mins = Math.floor(secs / 60)
  const s = secs % 60
  if (mins === 0) return `${s}s`
  return `${mins}m ${s}s`
}

function SuccessRateBadge({ rate }: { rate: number }) {
  const pct = (rate * 100).toFixed(0)
  return (
    <span
      className={cn(
        'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium',
        rate >= 0.8 ? 'bg-green-400/10 text-green-400' :
        rate >= 0.5 ? 'bg-orange-400/10 text-orange-400' :
                     'bg-red-400/10 text-red-400'
      )}
    >
      {pct}%
    </span>
  )
}

interface ThProps {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
}

function Th({ label, sortKey, current, dir, onSort }: ThProps) {
  const isActive = current === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground whitespace-nowrap"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-40" />
        )}
      </span>
    </th>
  )
}

export function CommandPerformance({ data }: CommandPerformanceProps) {
  const [sortKey, setSortKey] = useState<SortKey>('totalCostUsd')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sorted = [...data].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity
    const bv = b[sortKey] ?? -Infinity
    const cmp = typeof av === 'string'
      ? (av as string).localeCompare(bv as string)
      : (av as number) - (bv as number)
    return sortDir === 'asc' ? cmp : -cmp
  })

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Command Performance</h3>
        <p className="text-xs text-muted-foreground">No command data for this period</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h3 className="text-sm font-medium mb-3">Command Performance</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/30">
              <Th label="Command"      sortKey="command"      current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Runs"         sortKey="totalRuns"    current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Success Rate" sortKey="successRate"  current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Avg Cost"     sortKey="avgCostUsd"   current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Avg Duration" sortKey="avgDurationMs" current={sortKey} dir={sortDir} onSort={handleSort} />
              <Th label="Total Cost"   sortKey="totalCostUsd" current={sortKey} dir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.command} className="border-b border-border/20 hover:bg-accent/20 transition-colors">
                <td className="px-3 py-2 font-mono text-[10px] text-foreground">{row.command}</td>
                <td className="px-3 py-2 tabular-nums">{row.totalRuns}</td>
                <td className="px-3 py-2"><SuccessRateBadge rate={row.successRate} /></td>
                <td className="px-3 py-2 tabular-nums">{formatCost(row.avgCostUsd)}</td>
                <td className="px-3 py-2 tabular-nums">{formatDuration(row.avgDurationMs)}</td>
                <td className="px-3 py-2 tabular-nums font-medium">{formatCost(row.totalCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
