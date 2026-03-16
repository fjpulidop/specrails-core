import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000]

interface SharedWebSocketContextValue {
  registerHandler: (id: string, fn: (msg: unknown) => void) => void
  unregisterHandler: (id: string) => void
  connectionStatus: ConnectionStatus
  // Hub-level message types (hub.*) are fanned out to ALL registered handlers.
  // Handlers that only care about project-scoped messages should filter by
  // msg.projectId to ignore cross-project messages.
}

const SharedWebSocketContext = createContext<SharedWebSocketContextValue | null>(null)

export function SharedWebSocketProvider({ url, children }: { url: string; children: ReactNode }) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const handlers = useRef(new Map<string, (msg: unknown) => void>())
  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let disposed = false

    function connect() {
      if (disposed) return
      const ws = new WebSocket(url)
      wsRef.current = ws
      setConnectionStatus('connecting')

      ws.onopen = () => {
        if (disposed) { ws.close(); return }
        retryCountRef.current = 0
        setConnectionStatus('connected')
      }

      ws.onmessage = (event) => {
        if (disposed) return
        let parsed: unknown
        try {
          parsed = JSON.parse(event.data as string)
        } catch {
          return
        }
        // Fan-out to all registered handlers
        for (const handler of handlers.current.values()) {
          handler(parsed)
        }
      }

      ws.onclose = () => {
        if (disposed) return
        wsRef.current = null
        const attempt = retryCountRef.current
        if (attempt >= BACKOFF_DELAYS.length) {
          setConnectionStatus('disconnected')
          return
        }
        setConnectionStatus('connecting')
        const delay = BACKOFF_DELAYS[attempt]
        retryCountRef.current += 1
        retryTimeoutRef.current = setTimeout(connect, delay)
      }
    }

    connect()
    return () => {
      disposed = true
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
      wsRef.current?.close()
    }
  }, [url])

  const registerHandler = useCallback((id: string, fn: (msg: unknown) => void) => {
    handlers.current.set(id, fn)
  }, [])

  const unregisterHandler = useCallback((id: string) => {
    handlers.current.delete(id)
  }, [])

  return (
    <SharedWebSocketContext.Provider value={{ registerHandler, unregisterHandler, connectionStatus }}>
      {children}
    </SharedWebSocketContext.Provider>
  )
}

export function useSharedWebSocket(): SharedWebSocketContextValue {
  const ctx = useContext(SharedWebSocketContext)
  if (!ctx) throw new Error('useSharedWebSocket must be used within SharedWebSocketProvider')
  return ctx
}
