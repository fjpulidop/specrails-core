interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
}

export function SearchBox({ value, onChange }: SearchBoxProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px', borderBottom: '1px solid #1e293b' }}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search logs..."
        style={{
          flex: 1,
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 4,
          color: '#e2e8f0',
          padding: '4px 8px',
          fontSize: 13,
        }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          style={{ marginLeft: 6, background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16 }}
        >
          ×
        </button>
      )}
    </div>
  )
}
