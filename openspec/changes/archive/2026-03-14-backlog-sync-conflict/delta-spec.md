---
change: backlog-sync-conflict
type: delta-spec
---

# Delta Spec: Backlog Sync Conflict Detection

This document describes the normative changes to existing specs that this feature introduces.

---

## Spec: `/implement` Command (`openspec/specs/implement.md`)

### Addition: Phase 0 — Issue snapshot capture

Add the following sub-section after the existing Phase 0 flag detection and issue-fetch logic, within the block that handles `BACKLOG_VIEW_CMD`:

**New behavior (normative):**

> **If `GH_AVAILABLE=true` AND input mode is issue numbers:**
>
> After fetching each issue's metadata, capture a snapshot of each issue into `.claude/backlog-cache.json`. The snapshot MUST include: `number`, `title`, `state`, `assignees` (sorted), `labels` (sorted), `body_sha` (SHA-256 of body string), `updated_at` (from GitHub API), `captured_at` (local ISO 8601 timestamp).
>
> Set `SNAPSHOTS_CAPTURED=true`.
>
> If `GH_AVAILABLE=false` or input is not issue numbers: set `SNAPSHOTS_CAPTURED=false`. Skip snapshot capture silently.

### Addition: Phase 3a.0 — Pre-architect conflict check

Insert a new sub-phase `3a.0` immediately before Phase 3a (architect launch). This sub-phase MUST run after Phase 0 and before any architect agent is launched.

**New behavior (normative):**

> **Phase 3a.0: Pre-architect conflict check**
>
> Guard: if `SNAPSHOTS_CAPTURED=false` OR `DRY_RUN=true`: print `[conflict-check] Skipped.` and continue to Phase 3a.
>
> For each issue ref in scope:
> 1. Re-fetch current state: `gh issue view {number} --json number,title,state,assignees,labels,body,updatedAt`
> 2. Diff against `.claude/backlog-cache.json` snapshot using the algorithm defined in `design.md`.
> 3. Collect all conflicts.
>
> If no conflicts: print `[conflict-check] All issues clean. Proceeding to Phase 3a.` and continue.
>
> If conflicts exist: print the conflict report (format defined in `design.md`). Await user input `[A]bort` or `[C]ontinue`. On abort: exit cleanly. On continue: log overrides and proceed.

### Addition: Phase 4c.0 — Pre-ship conflict check

Insert a new sub-phase `4c.0` immediately before Phase 4c (shipping). This sub-phase MUST run after Phase 4b (reviewer) completes and before any git operation.

**New behavior (normative):**

> **Phase 4c.0: Pre-ship conflict check**
>
> Guard: same as Phase 3a.0. If `SNAPSHOTS_CAPTURED=false` OR `DRY_RUN=true`: print `[conflict-check] Skipped.` and continue to Phase 4c.
>
> Repeat the same re-fetch, diff, and halt-or-continue flow as Phase 3a.0.
>
> Note: a conflict seen at Phase 3a.0 where the user chose Continue MUST still be reported at Phase 4c.0 if it persists. The Phase 4c.0 check is independent.

### Addition: Variable Reference table

Add the following rows to the Variable Reference table in `openspec/specs/implement.md`:

| Variable | Type | Set when | Description |
|----------|------|----------|-------------|
| `SNAPSHOTS_CAPTURED` | boolean | Phase 0, issue-ref input mode | `true` if issue snapshots were written to `.claude/backlog-cache.json` |
| `CONFLICT_OVERRIDES` | list | Phase 3a.0 or 4c.0, user chose Continue | List of `{phase, issue, field, severity}` objects for the Phase 4e report |

### Addition: Phase 4e report — Conflict Overrides section

When `CONFLICT_OVERRIDES` is non-empty, the Phase 4e final report MUST include an additional section:

```
## Conflict Overrides

The following backlog conflicts were detected but overridden by the user:

| Phase | Issue | Field | Severity | Was | Now |
|-------|-------|-------|----------|-----|-----|
| 3a.0  | #42   | state | CRITICAL | open | closed |
```

If `CONFLICT_OVERRIDES` is empty or `SNAPSHOTS_CAPTURED=false`: omit this section entirely.

### Addition: Edge Cases section

Add to the existing Edge Cases section:

- **Cache missing at conflict-check time**: Re-fetch and build a fresh snapshot; skip diff (treat as clean); log `[conflict-check] Warning: no baseline snapshot found. Skipping diff.`
- **Issue deleted between snapshot and check**: `gh issue view` returns non-zero. Treat as CRITICAL conflict: "Issue #N no longer exists on GitHub."
- **All issues clean at both check points**: No user interaction required; pipeline runs entirely non-interactively.

---

## Spec: `/product-backlog` Command (no formal spec yet — behavioral spec addition)

No existing spec file covers `/product-backlog`. This delta creates the behavioral requirement.

**New behavior (normative):**

After the product-analyst agent displays the backlog, the command MUST write issue snapshots to `.claude/backlog-cache.json` for every issue fetched, using the same snapshot schema as `/implement` Phase 0.

Rules:
- If `.claude/backlog-cache.json` already exists: merge new snapshots in by issue number. Do not delete entries for issues not in the current fetch.
- `written_by` field MUST be `"product-backlog"`.
- If write fails: print a warning and continue. The cache write MUST NOT block the command.
- If `GH_AVAILABLE=false`: skip silently.

---

## Storage Convention Addition

`.claude/backlog-cache.json` is a new conventional file location established by this change. Its schema is defined in `design.md`. The file:

- Is written by `/implement` (Phase 0) and `/product-backlog` (post-display).
- Is read by `/implement` (Phases 3a.0 and 4c.0).
- MUST NOT be committed to version control (add to `.gitignore`).
- Is not required to exist — all readers handle missing-file gracefully.
