---
agent: developer
feature: feature-proposal-modal
tags: [useProposal, websocket, race-condition, useRef]
date: 2026-03-17
---

## Decision

Used a `useRef` to track `proposalId` inside the WebSocket handler closure in `useProposal`, rather than relying on the closure to capture the state value.

## Why This Approach

When `startProposal` fires and the server responds with a `proposalId`, the 202 response is received synchronously before React re-renders. If a `proposal_stream` message arrives over WebSocket before the re-render, the closure over the old state (where `proposalId` is `null`) would discard it. By updating `proposalIdRef.current` immediately after the fetch completes — before dispatching to `useReducer` — the WS handler always has the current value regardless of render timing.

## Alternatives Considered

- Use `useEffect` with `proposalId` in the dependency array to re-register the handler: this creates a brief window where no handler is registered, risking dropped messages.
- Stable handler ID + ref: chosen approach — single handler registration, ref provides fresh value.
