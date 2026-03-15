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
}

const SharedWebSocketContext = createContext<SharedWebSocketContextValue | null>(null)

export function SharedWebSocketProvider({ url, children }: { url: string; children: ReactNode }) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const handlers = useRef(new Map<string, (msg: unknown) => void>())
  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    const ws = new WebSocket(url)
    wsRef.current = ws
    setConnectionStatus('connecting')

    ws.onopen = () => {
      retryCountRef.current = 0
      setConnectionStatus('connected')
    }

    ws.onmessage = (event) => {
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
  }, [url])

  useEffect(() => {
    connect()
    return () => {
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
      wsRef.current?.close()
    }
  }, [connect])

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
