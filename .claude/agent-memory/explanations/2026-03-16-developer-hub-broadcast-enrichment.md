---
agent: developer
feature: multi-project-hub
tags: [server, websocket, projectId, broadcast]
date: 2026-03-16
---

## Decision

In `ProjectRegistry._loadProjectContext()`, a `boundBroadcast` closure is created for each project that spreads `projectId` into every WS message before calling the global broadcast. This enriches all messages server-side rather than requiring client-side tracking.

## Why This Approach

The spec says "Single broadcast, client filters by projectId." Enriching at the source is cleaner than having the client maintain a mapping of conversationId/jobId to projectId. The spread (`{ ...msg, projectId: project.id }`) adds the field without modifying any existing message type definitions — it's purely additive.

## Alternatives Considered

- **Client-side tracking**: Map conversation/job IDs to projects. Fragile if IDs collide across projects.
- **Separate WS connections per project**: Cleaner isolation but multiplies client WebSocket connections.

## See Also

- `server/project-registry.ts` — `boundBroadcast` closure
- `server/types.ts` — all WsMessage variants now have optional `projectId?: string`
- `client/src/hooks/usePipeline.ts` — filters messages by `projectId`
