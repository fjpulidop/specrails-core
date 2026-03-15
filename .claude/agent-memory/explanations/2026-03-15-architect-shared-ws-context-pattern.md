---
agent: architect
feature: chat-panel
tags: [websocket, react-context, fan-out, usePipeline]
date: 2026-03-15
---

## Decision

Introduce a `SharedWebSocketProvider` React context to distribute WebSocket messages to multiple subscribers (`usePipeline` and `useChat`) over a single connection, rather than opening a second WebSocket or passing raw messages through props.

## Why This Approach

Opening two WebSocket connections to the same server for one page would be wasteful and could cause ordering issues on the server's broadcast fan-out. Passing raw messages as props from `usePipeline` down through `RootLayout` to `useChat` would tightly couple the pipeline hook's public interface to chat's needs — every new subscriber would require changes to `usePipeline`'s return type.

The context pattern is a clean fan-out: the provider owns the single connection, each consumer registers by string ID, and the provider delivers each message to all registered handlers. Consumers are fully decoupled from each other.

## Alternatives Considered

- Two WebSocket connections: rejected (wasteful, ordering risks).
- Props drilling: rejected (tight coupling, poor extensibility).
- `usePipeline` returns `latestMessage` and callers filter: simpler but breaks the single-responsibility of `usePipeline` (it would become a raw-message relay rather than a structured pipeline state hook).

## See Also

- `client/src/hooks/useSharedWebSocket.tsx` — implementation target
- `client/src/hooks/usePipeline.ts` — primary existing consumer
- `design.md` — WebSocket Shared Connection Strategy section
