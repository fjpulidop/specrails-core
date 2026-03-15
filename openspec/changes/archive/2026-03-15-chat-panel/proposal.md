# Proposal: Integrated Conversational Chat Panel

## Problem

Users of the web-manager work in two separate mental contexts: the pipeline dashboard (watching jobs run) and Claude Code in the terminal (asking questions, getting project help). Switching between them breaks flow. There is no way to ask Claude about a job result, explore why a phase failed, or discover which SpecRails command to run next — all without leaving the browser.

## Solution

Add a persistent, collapsible chat panel on the right side of the web-manager. The panel provides a full conversational interface powered by Claude Code CLI (`claude -p`), with conversation continuity via `--resume`. Up to 3 simultaneous conversations are supported as tabs. The panel is mounted in `RootLayout` so it survives page navigation — state is never lost when switching between Dashboard, Analytics, or Settings.

When Claude's response contains a SpecRails command block (detected via `:::command` markers), the panel surfaces a confirmation UI before executing. Executing dispatches to the existing `/api/spawn` endpoint, hooking into the job queue normally.

## Value Proposition

- **No context switch**: users stay in the browser for both pipeline monitoring and AI-assisted decision making.
- **Project awareness**: Claude Code has full repo context. Answers are relevant to the actual codebase.
- **Command proposals**: reduces friction between "Claude suggests running X" and "X is queued" — one click bridges them.
- **Multi-conversation**: parallel conversations for different concerns (architecture question, debugging a failed job, exploring a new feature) without losing any thread.
- **Reuses infrastructure**: the server already has a WebSocket broadcast bus, a SQLite migration system, and a `spawn + readline` pattern. The chat manager is a natural extension of those patterns.

## Scope

This proposal covers the Minimum Viable Chat Panel:
- Backend: `chat-manager.ts` (lifecycle management), db migration 4 (chat tables), 8 REST endpoints, 5 WS message types
- Frontend: `ChatPanel` component tree, `useChat` hook, layout integration in `RootLayout`
- Model selector: user-settable per-conversation model with a sane default
- Auto-title: generate conversation title from first assistant response using a fast call
- Command proposal: `:::command` block detection, confirmation UI, dispatch to `/api/spawn`
