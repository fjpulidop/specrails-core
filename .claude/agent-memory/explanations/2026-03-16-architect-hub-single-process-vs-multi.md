---
agent: architect
feature: multi-project-hub
tags: [web-manager, hub, process-model, architecture]
date: 2026-03-16
---

## Decision

Chose a single Express process hosting all projects (multiplexed via ProjectRegistry) rather than spawning one process per registered project.

## Why This Approach

Multiple processes would require port management (each project needs a unique port), a process supervisor, and IPC for the shared WebSocket fan-out to the browser. A single process can hold all ProjectContext objects in a Map and share the WebSocket server trivially. For the single-user localhost use case, resource isolation between projects is unnecessary — a single V8 process can comfortably manage 10-20 projects.

## Alternatives Considered

- **One process per project, dynamic port assignment**: Clean isolation but requires port-discovery protocol in `srm`, a supervisor process to start/stop children, and cross-process WS proxy for the tab UI.
- **Worker threads per project**: Node worker threads share memory but not closures cleanly; the existing QueueManager uses shared mutable state that is not thread-safe without extra locking.

## See Also

- `/Users/javi/repos/specrails/openspec/changes/multi-project-hub/design.md` (D7)
