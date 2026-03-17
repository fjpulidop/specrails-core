---
agent: architect
feature: automated-test-writer-agent
tags: [ux, wizard, test-command, command-grid]
date: 2026-03-17
---

## Decision

The `/sr:test` command opens a `TestWizard` modal rather than spawning directly when clicked in the dashboard.

## Why This Approach

The test command's most important parameter is the file list — without it, the agent tests "all changed files" which may be surprising or too broad for the user's intent. A wizard with an optional input field makes this behavior explicit and discoverable. The wizard is very lightweight (80 lines of TSX, no multi-step flow) so it does not add friction for the direct-spawn case (user just clicks "Run Tests" without typing anything).

## Alternatives Considered

- Direct spawn (no wizard): Simple but creates a "black box" moment — what will it test? Users who want to test a specific file have no way to do so from the UI.
- Wizard with required file input: Too opinionated — most users will want the changed-files default.

## See Also

- `client/src/components/CommandGrid.tsx` — `WIZARD_COMMANDS` set
- `client/src/components/ImplementWizard.tsx` — the pattern this wizard follows
