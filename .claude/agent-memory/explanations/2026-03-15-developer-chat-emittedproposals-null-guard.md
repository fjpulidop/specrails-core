---
agent: developer
feature: chat-panel
tags: [async, readline, null-safety, maps]
date: 2026-03-15
---

## Decision

`_emittedProposals.get(conversationId)` uses a null-guard `if (emitted)` instead of the non-null assertion `!`.

## Why This Approach

Node.js readline fires `line` events asynchronously via `processTicksAndRejections`. When a test pushes `null` to the stream (signaling EOF) immediately before emitting `close`, the readline can still have buffered events queued on the microtask queue that fire after the `close` handler has already deleted the entry from `_emittedProposals`. Using `!` caused an uncaught exception (`Cannot read properties of undefined (reading 'has')`).

The null guard means: if the conversation has already been cleaned up when a late-arriving readline event fires, silently skip the proposal check. This is correct behavior — the conversation is already done.

## See Also

Same pattern should be applied if `_buffers.get(conversationId)` is ever used in the readline handler with the non-null assertion.
