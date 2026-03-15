declare const __WS_URL__: string

function getWsUrl(): string {
  // In dev mode, Vite injects the backend WS URL directly (bypasses Vite's own WS)
  // In production, derive from the page origin (the server serves both HTTP and WS)
  if (typeof __WS_URL__ !== 'undefined' && __WS_URL__) {
    return __WS_URL__
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}`
}

export const WS_URL = getWsUrl()
