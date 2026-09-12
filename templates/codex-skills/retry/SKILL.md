---
name: retry
description: "Run or resume implementation through the installed programmatic agent runtime."
license: MIT
---

# Resume a programmatic implementation

Resolve the exact saved context for the requested run. Do not initialize a replacement, guess the latest change, or discard work.

```sh
node .specrails/runtime/agent-runtime.mjs status --context <absolute-context>
node .specrails/runtime/agent-runtime.mjs resume --context <absolute-context>
```

Use the saved scope and configuration. Pass an answer, approval or recovery flag only for the corresponding pending request with user authorization. The runtime selects the next phase and preserves valid completed work; never invoke roles directly or edit phase receipts. Preserve host ownership of Git, worktrees and backlog. Report the structured result and outstanding delivery actions.
