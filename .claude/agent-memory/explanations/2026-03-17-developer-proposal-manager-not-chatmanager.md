---
agent: developer
feature: feature-proposal-modal
tags: [proposal-manager, architecture, chat-manager, subprocess]
date: 2026-03-17
---

## Decision

Created `ProposalManager` as a fresh class rather than reusing or extending `ChatManager`.

## Why This Approach

`ChatManager` carries `SYSTEM_PROMPT`, `autoTitle`, conversation history persistence, and a `_emittedProposals` map for `:::command` block parsing — none of which apply to proposals. The proposal lifecycle is: one exploration run, zero-or-more refinement turns (all `--resume`), and a terminal issue-creation run. Forcing this into `ChatManager`'s API would require threading unrelated parameters and stripping out features that would cause confusion. A clean class of ~200 lines, sharing only the spawn/stream pattern via direct copy, is easier to understand and test in isolation.

## Alternatives Considered

- Subclass `ChatManager`: rejected because ChatManager has no extension points and its constructor wires up state (`_emittedProposals`, `_abortingConversations`) that ProposalManager has no use for.
- Extract a base class: over-engineering for now; the pattern is stable enough to copy.

## See Also

The spec's design.md "Decision 1" documents the same reasoning.
