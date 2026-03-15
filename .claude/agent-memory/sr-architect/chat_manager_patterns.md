---
name: chat_manager_patterns
description: Design patterns for the chat panel feature — ChatManager class, shared WS context, layout integration, command proposal detection
type: project
---

# Chat Manager Patterns

## ChatManager is separate from QueueManager

Chat conversations (interactive, concurrent, up to 3 simultaneous) use a dedicated `ChatManager` class with `Map<conversationId, ChildProcess>`. QueueManager assumptions (FIFO, single active job, pause/resume) are incompatible with interactive chat. See explanation record `2026-03-15-architect-chat-manager-not-queue-manager.md`.

## Shared WebSocket via React context

Both `usePipeline` and `useChat` subscribe to a single WebSocket via `SharedWebSocketProvider` context. The provider owns the WS connection; consumers register handlers by string ID. This avoids two TCP connections and avoids prop-drilling raw messages.

See explanation record `2026-03-15-architect-shared-ws-context-pattern.md`.

## Layout: flex row sibling, not fixed overlay

`ChatPanel` is a flex-row sibling of `<main>` inside `RootLayout`. This pushes main content left naturally; no z-index management needed. See explanation record `2026-03-15-architect-chat-panel-layout-flex-row.md`.

## Command block pattern

`:::command\n<content>\n:::` is the format for command proposals in assistant responses. Detection runs after each chunk via regex. Emitted proposals per active process are tracked in a `Set<string>` to prevent duplicate WS broadcasts on subsequent chunks.

## Auto-title strategy

After turn 1 completes (detected by checking `session_id === null` before send), spawn a second throwaway `claude -p` with a compact prompt. Fire-and-forget; failure is silent. Results in `chat_title_update` WS broadcast.

## DB: migration 4 for chat tables

`chat_conversations` (with `session_id` for `--resume` continuity) and `chat_messages` with FK ON DELETE CASCADE. Appended to `MIGRATIONS` array as index 3. Additive; no existing tables modified.

## WS field naming convention

WS messages use camelCase (`conversationId`, `fullText`). DB row types use snake_case (`conversation_id`, `session_id`). The `useChat` hook bridges both. This matches the existing pattern in the codebase (e.g., `jobId` in WS vs `job_id` in DB rows).

## Template sync is mandatory

The codebase has two parallel dirs: `specrails/web-manager/` and `templates/web-manager/`. Both must be updated. Template sync (Task 10) is a required step before any PR is considered done.
