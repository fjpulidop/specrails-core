---
change: automated-test-writer-agent
type: proposal
---

# Proposal: Automated Test Writer Agent — Standalone Command & Manager Integration

## VPC Analysis

**V — Value**: The test-writer agent already exists as a pipeline sub-step (Phase 3c of `/specrails:implement`). However, users cannot invoke it outside the full implement pipeline. A developer who refactors an existing file, fixes a bug outside the pipeline, or wants to retroactively add tests to legacy code has no path to the test-writer agent today. Surfacing `/specrails:test` as a standalone command closes this gap and makes test generation a first-class, independently triggerable operation. The manager UI currently shows `/specrails:test` in the "Others" collapsible section once the command file exists — no infrastructure changes are needed for discovery. What is missing is the command file itself, manager-side UX enhancements (a dedicated "Tests" widget, `test` entry in COMMAND_META for proper visual treatment), and comprehensive tests for all new code.

**P — Product**: This change addresses GitHub Issue #6 in the specrails backlog. The product intent is: any developer in any repo that has specrails installed should be able to run `/specrails:test path/to/file.ts` or `/specrails:test` (all changed files) and get a complete, high-quality test suite generated in the style of the project's existing tests — without having to run a full implement pipeline. In the manager dashboard, the "Tests" section provides at-a-glance status for test generation, a quick-launch button, and displays the last run's results.

**C — Constraints**:
- The sr-test-writer agent template already exists and must not be duplicated or materially changed.
- Command discovery in the manager is fully automatic (reads `.claude/commands/specrails/*.md`). The `test.md` command file must have valid YAML frontmatter with `phases` that match the test-writer's execution stages so PipelineProgress renders correctly.
- Per-project isolation is enforced by the existing hub architecture — each project has its own `QueueManager` and SQLite DB. No new isolation mechanism is needed; it must only be maintained (no shared state in new code).
- All tests must use the existing test infrastructure: bash helpers for specrails, Vitest for specrails-manager.
- No new npm dependencies may be added to specrails-manager unless strictly required.
- The `test.md` command template must follow the `{{PLACEHOLDER}}` syntax and be installable by `install.sh` without any script changes (templates are copied wholesale by `cp -r`).

## Summary

This change delivers:
1. A standalone `/specrails:test` command in both `templates/commands/` and `.claude/commands/specrails/`.
2. A `test` entry in `COMMAND_META` in `CommandGrid.tsx` for polished visual treatment.
3. A `TestRunnerWidget` component and a "Tests" dashboard section in `DashboardPage.tsx` showing last run stats and a quick-launch button.
4. A `TestWizard` component for collecting file path arguments before launching.
5. Comprehensive tests: two bash test scripts in `tests/` and one Vitest test file in `server/`.

The total surface change is additive only. No existing contracts are broken.
