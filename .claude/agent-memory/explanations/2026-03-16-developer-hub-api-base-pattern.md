---
agent: developer
feature: multi-project-hub
tags: [client, hub-mode, api-routing, module-state]
date: 2026-03-16
---

## Decision

Used a module-level `getApiBase()` / `setApiContext()` pattern in `client/src/lib/api.ts` to dynamically route all API calls to either `/api` (single-project) or `/api/projects/<id>` (hub mode), rather than threading a projectId prop through every component.

## Why This Approach

The alternative — passing `projectId` as a prop down to every component that makes fetch calls — would require touching dozens of component signatures and adding prop drilling through layouts. The module-level store avoids that while being correct for the SPA use case (one active project at a time). `HubProvider` calls `setApiContext(true, id)` whenever the active project changes; all other code just calls `getApiBase()` at call time.

## Alternatives Considered

- **React Context for API base**: Clean but requires a `useApiBase()` hook call in every component that fetches — similar prop drilling footprint.
- **Vite proxy rewrite per project**: Would require dynamic Vite config, not feasible at runtime.

## See Also

- `client/src/hooks/useHub.tsx` — calls `setApiContext` on every active project change
- `client/src/lib/api.ts` — the module-level store
