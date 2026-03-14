---
change: backlog-sync-conflict
type: feature
status: proposed
github_issue: 41
vpc_fit: ~
---

# Proposal: Backlog Sync Conflict Detection

## Problem

The `/implement` pipeline fetches issue state once at startup and then operates blindly for however long implementation takes. On a feature that takes 30–60 minutes to implement, an external actor — a colleague, a product manager, an automated bot — can close the issue, reassign it, change its labels, or edit its description while the pipeline is mid-flight. The developer receives no signal of this. They ship an implementation of a feature that was already cancelled, reassigned to someone else, or materially changed in scope.

This is not a hypothetical. Backlogs are shared artefacts. In any active team, issue state changes continuously. The `/product-backlog` command surfaces a ranked view at a point in time, and `/implement` snapshots that state at invocation. Nothing checks whether that snapshot is still valid by the time code is committed.

The cost of shipping a stale implementation is high: wasted developer time, reviewer confusion, potential rework of already-merged code, and product–engineering trust erosion when a closed feature appears in a PR.

## Solution

Add conflict detection to the `/implement` pipeline.

At two points in the pipeline — just before architect agents launch (Phase 3a) and again just before shipping (Phase 4c) — the pipeline re-fetches the current state of every in-scope GitHub Issue and compares it against the state captured at Phase 0. A persisted cache file, `.claude/backlog-cache.json`, stores the snapshots.

If a conflict is detected, the pipeline halts and presents the user with a clear conflict report and a binary choice: abort or continue. The continue path is explicit and intentional — the user may know about the change and want to proceed anyway.

The cache file also serves a secondary use: `/product-backlog` can write to it when it fetches issues, so that `/implement` has a baseline to diff against even if it was not the one to read the issues initially.

## Non-Goals

- No continuous background polling. The issue notes a possible `/loop` integration, but a continuous background process adds complexity, race conditions, and terminal noise that outweigh the benefit for this use case. Point-in-time checks at meaningful pipeline gates are sufficient and predictable.
- No JIRA or other backlog provider support in this change. GitHub Issues only. The cache schema is provider-aware so future providers can extend it.
- No automatic conflict resolution. The user always decides.
- No change to the dry-run or apply paths — conflict checks are skipped when `DRY_RUN=true` (no live backlog operations).
- No new agent. The conflict checks run inline in the orchestrating command.

## Scope

Three files change:

1. `templates/commands/implement.md` — two new inline conflict-check phases (3a.0 and 4c.0), and a cache write in Phase 0.
2. `templates/commands/product-backlog.md` — writes issue snapshots to `.claude/backlog-cache.json` when it fetches issues.
3. A new storage convention: `.claude/backlog-cache.json` stores the last-known state of each issue.

## Success Criteria

- When `/implement` is invoked with issue numbers and `GH_AVAILABLE=true`, the pipeline captures a JSON snapshot of each issue's state (number, title, state, assignees, labels, body SHA) into `.claude/backlog-cache.json` during Phase 0.
- Before Phase 3a launches architect agents, the pipeline re-fetches each issue and diffs against the snapshot. If any conflict field changed, the pipeline pauses and displays a conflict report.
- Before Phase 4c ships, the pipeline performs a second re-fetch and diff. Same halt-and-report behavior.
- The conflict report clearly states: which issue, which field changed, old value, new value.
- The user is offered: `[A]bort` or `[C]ontinue`. Abort exits cleanly. Continue proceeds with a log entry.
- When `GH_AVAILABLE=false` or `DRY_RUN=true`, conflict checks are silently skipped (no error, no halt).
- `/product-backlog` writes to `.claude/backlog-cache.json` after fetching issues, so a baseline exists even if the user viewed the backlog before running `/implement`.
- No unresolved `{{PLACEHOLDER}}` tokens in the installed commands after `/setup` runs.
