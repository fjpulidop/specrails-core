---
change: health-check-dashboard
type: feature
status: shipped
github_issue: 9
vpc_fit: 72%
---

# Proposal: Codebase Health Check Dashboard

## Problem

Software quality degrades incrementally. Test coverage quietly drops by a few percent after a rushed feature. A linter rule gets disabled to unblock a deadline. A dependency accumulates three minor vulnerabilities. No single event is alarming enough to trigger action — but after six weeks, a codebase that was healthy is now fragile, and the lead developer only discovers this when something breaks in production.

specrails installs a powerful workflow for building features, but it currently has no mechanism for periodically stepping back and asking: is the codebase still healthy? The `/implement` pipeline checks quality gates for individual changes, but there is no command that produces a cross-cutting quality report across the entire project, tracks trends over time, or surfaces regressions before they compound.

Lead developers lack a weekly ritual that gives them early warning across all quality dimensions: test health, coverage trajectory, lint discipline, code complexity, dependency security, and performance baseline.

## Solution

Add a `/health-check` slash command to the specrails command template library.

When invoked, the command:

1. Detects the project's available toolchain (test runner, linter, coverage tool, dependency auditor) without requiring configuration — it probes for common tools dynamically.
2. Runs all available checks in a structured sequence.
3. Produces a standardized health report covering: test pass rate, code coverage with trend, linting score, code complexity signals, dependency vulnerabilities, and performance baseline where detectable.
4. Compares the current report against the most recent stored report in `.claude/health-history/` and highlights any regressions.
5. Stores the report as JSON in `.claude/health-history/` for use in future comparisons.

The command works against any codebase — it is not specrails-specific. It uses Claude's built-in reasoning to interpret tool output in a codebase-agnostic way, without requiring a fixed test framework or linter.

## Non-Goals

- This does not add CI integration or automate scheduling. Scheduling is a future concern.
- This does not auto-fix issues. The report is diagnostic, not prescriptive (though it may suggest fixes).
- This does not add a new agent. The command uses Claude's built-in tool-calling to run checks and reason about results.
- This does not modify the `/implement` pipeline quality gates, which are per-change and remain separate.
- This does not require any specrails-specific configuration in the target repo.

## Scope

One new file:

1. `templates/commands/health-check.md` — the command template, installed into target repos via `/setup`.

One existing file changes:

2. `install.sh` — no change required; command templates are copied automatically via `cp -r "$SCRIPT_DIR/templates/"*`. The new command is picked up automatically when `/setup` generates `.claude/commands/` from the templates.

Storage convention established (not a file change — a directory convention):

3. `.claude/health-history/` — in the target repo, health reports are stored here as JSON. The command creates this directory on first run.

## Success Criteria

- `/health-check` runs without requiring any configuration or setup beyond installing specrails.
- The command detects available toolchain components (test runner, linter, coverage) and skips checks whose tools are absent, reporting each as SKIPPED rather than failing.
- A health report is produced with clearly structured sections for each quality dimension.
- On second and subsequent runs, the report includes a regression comparison against the most recent stored report.
- Reports are stored as JSON in `.claude/health-history/<ISO-date>-<sha>.json`.
- The command works identically in any codebase, whether it is a Node.js project, a Python service, a Go binary, or a mixed-stack monorepo.
- No `{{PLACEHOLDER}}` tokens remain unresolved in the installed command after `/setup` runs.
