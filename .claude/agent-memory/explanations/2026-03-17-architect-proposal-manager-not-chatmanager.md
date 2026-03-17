---
agent: architect
feature: feature-proposal-modal
tags: [proposal, chatmanager, reuse, separation-of-concerns]
date: 2026-03-17
---

## Decision

`ProposalManager` is a new class rather than a reuse of `ChatManager`.

## Why This Approach

`ChatManager` is built around persistent chat conversations with message history, auto-titling, and a system prompt designed for a general project assistant. Proposals have a fundamentally different lifecycle: one initial command invocation, zero or more `--resume` refinement turns, and a deterministic terminal action (issue creation). Threading the proposal flow through `ChatManager` would require parameterizing its system prompt, bypassing its `autoTitle` logic, and ignoring its conversation DB schema. A clean new class with proposal-specific state transitions is simpler and more maintainable than an overloaded general one.

## Alternatives Considered

- Extend `ChatManager` with a `mode: 'proposal' | 'chat'` flag — rejected because it adds conditional branching throughout the class
- Reuse `ChatManager` as-is with a fixed system prompt — rejected because `ChatManager` writes to `chat_conversations` / `chat_messages` tables, not the `proposals` table

## See Also

- `/Users/javi/repos/specrails-manager/server/chat-manager.ts`
- `/Users/javi/repos/specrails/openspec/changes/feature-proposal-modal/design.md` (section 2.3)
