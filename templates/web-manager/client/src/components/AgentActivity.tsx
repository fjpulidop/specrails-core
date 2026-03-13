import { useState } from 'react'
import { LogStream } from './LogStream'
import { SearchBox } from './SearchBox'
import type { LogLine } from '../hooks/usePipeline'

interface AgentActivityProps {
  logLines: LogLine[]
}

export function AgentActivity({ logLines }: AgentActivityProps) {
  const [filterText, setFilterText] = useState('')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <SearchBox value={filterText} onChange={setFilterText} />
      <LogStream lines={logLines} filterText={filterText} />
    </div>
  )
}
