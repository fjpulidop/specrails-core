---
change: backlog-sync-conflict
type: design
---

# Technical Design: Backlog Sync Conflict Detection

## Overview

The design introduces two inline conflict-check points within the existing `/implement` pipeline and a lightweight JSON cache file that persists issue state snapshots. No new agents, no background processes, no external dependencies.

The approach is conservative by default: a single changed field on any in-scope issue triggers a halt. The user decides whether to proceed. The system never overrides that decision.

---

## Architecture

```
/implement
     |
     v
Phase 0: Parse input
  NEW: Capture issue snapshots -> .claude/backlog-cache.json
     |
     v
Phase 3a.0: Pre-architect conflict check  [NEW]
  - Re-fetch all in-scope issues
  - Diff against Phase 0 snapshot
  - If conflict: halt, report, await [A]bort/[C]ontinue
     |
     v
Phase 3a ... Phase 4b: (unchanged)
     |
     v
Phase 4c.0: Pre-ship conflict check  [NEW]
  - Re-fetch all in-scope issues
  - Diff against Phase 0 snapshot
  - If conflict: halt, report, await [A]bort/[C]ontinue
     |
     v
Phase 4c: Ship (unchanged)

/product-backlog
     |
     v
After fetching issues:
  NEW: Write snapshots -> .claude/backlog-cache.json
```

---

## Cache File: `.claude/backlog-cache.json`

### Location

`.claude/backlog-cache.json` in the target repo root. This file is written by both `/implement` (Phase 0) and `/product-backlog` (after fetching). It is not committed to git — add to `.gitignore` if the target repo does not already exclude `.claude/`.

### Schema

```json
{
  "schema_version": "1",
  "provider": "github",
  "last_updated": "<ISO 8601 timestamp>",
  "written_by": "implement | product-backlog",
  "issues": {
    "42": {
      "number": 42,
      "title": "Feature name",
      "state": "open",
      "assignees": ["username"],
      "labels": ["area:Commands", "product-driven-backlog"],
      "body_sha": "<sha256 of body string>",
      "updated_at": "<ISO 8601 timestamp from GitHub>",
      "captured_at": "<ISO 8601 timestamp of snapshot>"
    }
  }
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | string | Always `"1"` in this version. Increment if schema changes. |
| `provider` | string | `"github"` — enables future extension for JIRA, Linear, etc. |
| `last_updated` | string | ISO 8601 timestamp when the file was last written |
| `written_by` | string | Which command last wrote the file: `"implement"` or `"product-backlog"` |
| `issues` | object | Map of issue number (string) to snapshot object |
| `issues[N].number` | integer | GitHub issue number |
| `issues[N].title` | string | Issue title at snapshot time |
| `issues[N].state` | string | `"open"` or `"closed"` |
| `issues[N].assignees` | array | Sorted list of assignee login names |
| `issues[N].labels` | array | Sorted list of label names |
| `issues[N].body_sha` | string | SHA-256 hex digest of the issue body string. Used to detect body edits without storing the full body. |
| `issues[N].updated_at` | string | `updated_at` field from the GitHub API response |
| `captured_at` | string | Local timestamp when this snapshot was taken |

### Snapshot Construction

When capturing a snapshot, run:

```bash
gh issue view {number} --json number,title,state,assignees,labels,body,updatedAt
```

Compute `body_sha`:
```bash
echo -n "{body}" | sha256sum | cut -d' ' -f1
```

Assignees and labels are sorted alphabetically before storage so that order changes in the API response do not produce false positives.

---

## Diff Algorithm

The diff runs at each conflict-check point. For each issue in scope:

1. Re-fetch current state via `gh issue view {number} --json number,title,state,assignees,labels,body,updatedAt`.
2. Reconstruct a current snapshot object (same shape as the cache entry).
3. Compare the following fields against the cached snapshot:

| Field | Conflict if... |
|-------|---------------|
| `state` | value differs (`"open"` → `"closed"` or vice versa) |
| `title` | string differs |
| `assignees` | sorted array differs |
| `labels` | sorted array differs |
| `body_sha` | SHA differs |

`updated_at` from GitHub is used as a quick short-circuit: if `updated_at` is identical to the cached value, skip field-by-field comparison and mark the issue as clean. This avoids unnecessary SHA computation on unchanged issues.

### Conflict Classification

Each detected difference is classified by severity:

| Conflict type | Severity | Explanation |
|---------------|----------|-------------|
| `state: open -> closed` | CRITICAL | Issue was closed — implementation may be cancelled |
| `state: closed -> open` | WARNING | Issue was reopened — may have new scope |
| `title` changed | WARNING | Scope or framing changed |
| `assignees` changed | WARNING | Ownership transferred |
| `labels` changed | INFO | Priority or area reclassified |
| `body` changed | WARNING | Requirements may have changed |

CRITICAL conflicts always halt. WARNING and INFO conflicts also halt by default (conservative). The user sees severity in the report.

---

## Conflict Report Format

When conflicts are detected, the pipeline prints:

```
## Backlog Conflict Detected

The following issues changed since Phase 0 snapshot (captured at <timestamp>):

| Issue | Field | Severity | Was | Now |
|-------|-------|----------|-----|-----|
| #42   | state | CRITICAL | open | closed |
| #42   | body  | WARNING  | <sha-prefix> | <sha-prefix> |
| #71   | assignees | WARNING | [] | ["alice"] |

How would you like to proceed?
  [A] Abort — stop the pipeline and exit cleanly
  [C] Continue — proceed despite the conflicts (logged)

Enter A or C:
```

If the user chooses `[C]`:
- Print: `[conflict-override] Continuing with N conflict(s) logged. Check issue state before merging.`
- Append conflict details to the pipeline's Phase 4e final report under a `## Conflict Overrides` section.

If the user chooses `[A]`:
- Print: `[conflict-abort] Pipeline aborted due to backlog conflicts. Re-run /implement after resolving the issues.`
- Exit cleanly (no git state left behind, no partial commits).

---

## Guard Conditions

Conflict checks are **skipped entirely** when any of the following is true:

| Condition | Reason |
|-----------|--------|
| `GH_AVAILABLE=false` | Cannot re-fetch issues |
| `DRY_RUN=true` | No live backlog operations in dry-run mode |
| Input was a text description (not issue numbers) | No issue to track |
| Input was area names with no resolved issues | No issue to track |

When skipped, print a single line:
```
[conflict-check] Skipped — GH_AVAILABLE=false (or dry-run mode / no issue refs).
```

---

## `/product-backlog` Integration

After the product-analyst agent completes its fetch and display, the `/product-backlog` command writes snapshots for every fetched issue to `.claude/backlog-cache.json`.

This is additive: if the file already exists, merge new snapshots in (overwrite by issue number). Do not delete snapshots for issues not in the current fetch — they may be needed by an in-progress `/implement` run.

The write happens after the display step so the user always sees the backlog before any file I/O side effect. If the write fails (e.g., `.claude/` does not exist), print a warning and continue — the cache is advisory, not blocking.

---

## Interaction with Existing Pipeline Variables

| Variable | Usage |
|----------|-------|
| `GH_AVAILABLE` | Set in Phase -1; gates all conflict-check logic |
| `DRY_RUN` | Set in Phase 0; skips conflict checks |
| `SINGLE_MODE` | Does not affect conflict checks; issue-based single-mode still checks |
| `ISSUE_REFS` | The set of issue numbers in scope; drives snapshot capture and re-fetch |

---

## File Placement and Gitignore

`.claude/backlog-cache.json` should not be committed. The file is ephemeral machine state. The `/implement` command should check whether `.gitignore` contains `.claude/backlog-cache.json` or `.claude/*.json` or `.claude/` and print a one-time suggestion to add it if not found. The suggestion is non-blocking.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Issue deleted on GitHub between snapshot and check | `gh issue view` returns non-zero. Treat as CRITICAL conflict: issue no longer exists. |
| Cache file missing at conflict-check time | Re-fetch and build a fresh snapshot; skip diff (treat as clean); log a warning that no baseline existed. |
| Cache file malformed JSON | Treat as missing; proceed as above. |
| Multiple issues, some clean some conflicted | Report only conflicted issues. Clean issues are not mentioned. |
| User inputs `A` or `C` in lowercase | Accept both cases. Treat anything other than `a`/`A`/`c`/`C` as invalid input and re-prompt (up to 3 times, then default to abort). |
| Conflict check at Phase 4c finds same conflict already seen at Phase 3a.0 and user chose Continue | Still report the conflict at Phase 4c. Do not suppress — the field may have changed again, and the second check is the final gate before shipping. |
