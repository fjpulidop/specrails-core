import { useState, KeyboardEvent } from 'react'

export function CommandInput() {
  const [command, setCommand] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleRun() {
    if (!command.trim() || isLoading) return
    setIsLoading(true)
    setErrorMessage(null)

    try {
      const res = await fetch('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      })

      if (res.ok) {
        setCommand('')
      } else {
        const body = await res.json().catch(() => ({}))
        const msg = (body as { error?: string }).error ?? (res.status === 409 ? 'A process is already running' : 'Failed to start process')
        setErrorMessage(msg)
      }
    } catch {
      setErrorMessage('Failed to connect to server')
    } finally {
      setIsLoading(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleRun()
  }

  return (
    <div style={{ padding: '12px', borderTop: '1px solid #1e293b' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Actions
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter command (e.g., /implement #42)"
          style={{
            flex: 1,
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 4,
            color: '#e2e8f0',
            padding: '6px 8px',
            fontSize: 13,
          }}
        />
        <button
          onClick={handleRun}
          disabled={!command.trim() || isLoading}
          style={{
            background: isLoading || !command.trim() ? '#334155' : '#3b82f6',
            color: '#e2e8f0',
            border: 'none',
            borderRadius: 4,
            padding: '6px 14px',
            fontSize: 13,
            cursor: isLoading || !command.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {isLoading ? 'Running...' : 'Run'}
        </button>
      </div>
      {errorMessage && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{errorMessage}</div>
      )}
    </div>
  )
}
