import { useEffect, useRef } from 'react'
import type { LogLine } from '../hooks/usePipeline'

interface LogStreamProps {
  lines: LogLine[]
  filterText: string
}

export function LogStream({ lines, filterText }: LogStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)

  const filtered = filterText
    ? lines.filter((l) => l.line.toLowerCase().includes(filterText.toLowerCase()))
    : lines

  useEffect(() => {
    const container = containerRef.current
    if (!container || userScrolledRef.current) return
    container.scrollTop = container.scrollHeight
  }, [filtered.length])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
    userScrolledRef.current = !atBottom
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        fontFamily: 'monospace',
        fontSize: 12,
        padding: '8px',
        backgroundColor: '#0f172a',
      }}
    >
      {filtered.map((line, i) => (
        <div key={`${line.processId}-${i}`} style={{ lineHeight: '1.5', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <span style={{ color: '#475569', marginRight: 8 }}>
            {line.timestamp.slice(11, 19)}
          </span>
          <span style={{ color: line.source === 'stderr' ? '#fb923c' : '#e2e8f0' }}>
            {line.line}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
