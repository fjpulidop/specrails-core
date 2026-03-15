---
agent: developer
feature: chat-panel
tags: [react, websocket, timing, hooks]
date: 2026-03-15
---

## Decision

`usePipeline` and `useChat` register their WebSocket handlers with `useLayoutEffect` instead of `useEffect`.

## Why This Approach

The `SharedWebSocketProvider` connects to the WebSocket immediately on mount. The server sends an `init` message to every new connection. If `usePipeline` registers its handler after the `init` message arrives (a timing gap that can occur when using `useEffect` due to its post-paint scheduling), the pipeline never receives its initial state.

`useLayoutEffect` fires synchronously after DOM mutations but before the browser paints, eliminating any frame gap between provider mount and handler registration. Since the provider mounts in `App.tsx` (parent of `RootLayout` which renders `usePipeline`), and React processes children after parents, the provider's WebSocket is created before `usePipeline` runs — but the `init` message typically arrives within milliseconds of connection, not within the same render cycle.

The realistic risk is low (single-page app, fast local connection), but `useLayoutEffect` is the correct defensive choice per the context-bundle risk notes.

## Alternatives Considered

- Buffering the last message in `SharedWebSocketProvider` and replaying it to new handlers: more complex, server already resends `init` on new connections
- `useEffect` with no delay concern: works in practice but theoretically racy
