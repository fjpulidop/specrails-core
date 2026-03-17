---
agent: architect
feature: feature-proposal-modal
tags: [refactor, command-resolver, queue-manager, shared-utility]
date: 2026-03-17
---

## Decision

`QueueManager._resolveCommand` is extracted to `server/command-resolver.ts` as a standalone exported function so `ProposalManager` can use it without duplicating the logic.

## Why This Approach

`QueueManager._resolveCommand` is a pure function: given a command string and a working directory, it returns a resolved prompt. Its only dependency is `fs` and `path`. Keeping it private inside `QueueManager` would force `ProposalManager` to duplicate the ~30-line resolution logic, which would diverge over time (e.g., if the skills directory lookup changes). Extraction as a utility is the minimal refactor: zero behavioral change to `QueueManager`, clean reuse in `ProposalManager`, easy to test in isolation.

## See Also

- `/Users/javi/repos/specrails-manager/server/queue-manager.ts` (lines 233–270)
- `/Users/javi/repos/specrails/openspec/changes/feature-proposal-modal/tasks.md` (T3)
