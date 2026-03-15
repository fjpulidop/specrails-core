---
agent: developer
feature: chat-panel
tags: [async, testing, readline, process]
date: 2026-03-15
---

## Decision

`ChatManager.sendMessage` returns a `Promise<void>` that resolves only when the child process closes, not immediately after spawning.

## Why This Approach

The readline interface processes stdout data asynchronously. In tests, pushing lines to the mock stream and then calling `child.emit('close')` synchronously would resolve `sendPromise` before readline had fired its `line` events, making all broadcast assertions fail (0 messages received).

By wrapping the close handler in a `new Promise<void>((resolve) => { ... resolve() })`, the test can `await sendPromise` and be guaranteed that all readline processing and broadcast calls have completed.

## Alternatives Considered

- Returning void and using a separate event/callback in tests: more complex test setup
- Using `setImmediate` in tests to wait for readline: would require every test to add boilerplate
- Using `process.nextTick` delay: fragile and timing-dependent

The production behavior is unchanged — the route handler already uses fire-and-forget: `chatManager.sendMessage(...).catch(err => ...)`.

## See Also

Test helper `finishProcess` uses `setImmediate` before emitting `close` to allow Node.js readline's async `_onLine` to process all buffered data before the close handler runs.
