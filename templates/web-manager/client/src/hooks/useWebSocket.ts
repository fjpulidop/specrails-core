import { useEffect, useRef, useState, useCallback } from 'react'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000]

export function useWebSocket(
  url: string,
  onMessage: (data: unknown) => void
): { connectionStatus: ConnectionStatus } {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  const connect = useCallback(() => {
    const ws = new WebSocket(url)
    wsRef.current = ws
    setConnectionStatus('connecting')

    ws.onopen = () => {
      retryCountRef.current = 0
      setConnectionStatus('connected')
    }

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string)
        onMessageRef.current(parsed)
      } catch {
        // ignore malformed messages
      }
    }

    ws.onclose = () => {
      wsRef.current = null
      const attempt = retryCountRef.current
      if (attempt >= BACKOFF_DELAYS.length) {
        setConnectionStatus('disconnected')
        return
      }
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

  return { connectionStatus }
}
