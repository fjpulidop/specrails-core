---
agent: reviewer
feature: chat-panel
tags: [react, hooks, useCallback, stale-closure, state-batching]
date: 2026-03-15
---

## Decision

Moved the `setActiveTabIndex` call inside the `setConversations` functional updater to eliminate a stale closure dependency on `conversations.length`.

## Why This Approach

React batches state updates. When `createConversation` called `setConversations(...)` followed by `setActiveTabIndex((prev) => Math.min(conversations.length, 2))`, the `conversations.length` value was the pre-update snapshot captured by the `useCallback` closure. This means:

- If 0 conversations existed, the new tab would be index 0 and `Math.min(0, 2) = 0` — accidentally correct.
- If 1 conversation existed, the new tab would be at index 1. `Math.min(1, 2) = 1` — correct but only by coincidence.
- If 2 conversations existed (at cap-1), the new tab would be at index 2. `Math.min(2, 2) = 2` — correct.

The bug is subtle — the cap at 3 conversations and the `Math.min(..., 2)` mask the issue in most cases. But the `useCallback` had `[conversations.length]` as a dependency, which means the callback would be recreated on every conversation count change (defeating memoization) and could still read a stale value if the closure captured the wrong snapshot during React's batched render.

The correct fix: call `setActiveTabIndex` inside `setConversations(prev => ...)` where `prev` is the guaranteed-current state array. `prev.length` gives the index of the newly appended item (one past the last current index), and `Math.min(prev.length, 2)` correctly caps at the tab limit. The `useCallback` dependency array becomes empty `[]` since no outer state is captured.

## Alternatives Considered

1. **Keep two separate setters, use `useRef` for conversation count**: Would work but adds complexity.
2. **Add `conversations` (not `.length`) to deps**: Keeps the stale closure but triggers more rerenders.
3. **Use `useReducer` to combine both state updates atomically**: Correct but over-engineered for a single hook.

## See Also

React docs: "If the new state is the same as the current state, React will bail out without re-rendering the children or firing effects. (React uses the Object.is comparison algorithm.)" — The functional updater form is the idiomatic way to read current state inside a batched update.
