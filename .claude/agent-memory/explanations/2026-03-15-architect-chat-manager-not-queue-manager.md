---
agent: architect
feature: chat-panel
tags: [chat, architecture, queue-manager, subprocess]
date: 2026-03-15
---

## Decision

Chat conversations use a standalone `ChatManager` class rather than extending `QueueManager`.

## Why This Approach

`QueueManager` is designed for batch jobs: FIFO sequential execution, pause/resume, queue position tracking, and a global log buffer with `processId` tagging. Chat conversations are interactive and concurrent — up to 3 can be active simultaneously, each with an independent process, and they never queue behind each other. Shoehorning chat into `QueueManager` would require disabling the sequential constraint and adding per-conversation process tracking, which amounts to rebuilding the class from scratch.

A dedicated `ChatManager` with a `Map<conversationId, ChildProcess>` is simpler, contains its own lifecycle, and does not risk introducing regressions in the queue system.

## Alternatives Considered

- Extend `QueueManager` with a `concurrent` flag and per-process map: rejected because the queue model assumptions (single active job, FIFO drain) are deeply embedded and would require defensive conditionals throughout.
- Single unified process manager: rejected for the same reason; the abstractions diverge too much.

## See Also

- `server/queue-manager.ts` — the existing batch job pattern
- `design.md` — ChatManager interface specification
