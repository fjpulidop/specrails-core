---
change: backlog-sync-conflict
type: context-bundle
---

# Context Bundle: Backlog Sync Conflict Detection

Everything a developer needs to implement this feature. No other file needs to be read first.

---

## What You Are Building

Two inline conflict-check gates inside the `/implement` pipeline, plus a lightweight cache write in `/product-backlog`. The goal is to detect when GitHub Issues are modified externally while an implementation is in progress and give the user a chance to abort before shipping stale work.

There are no new agents, no new commands, no new architecture. This is purely additive modification to two existing command templates.

---

## Files to Change

| File | Change type | Notes |
|------|-------------|-------|
| `templates/commands/implement.md` | **Modify** | Add Phase 0 snapshot, Phase 3a.0, Phase 4c.0, Phase 4e section |
| `templates/commands/product-backlog.md` | **Modify** | Add post-display snapshot write |

**Do NOT modify:**
- `install.sh` — no change needed; template changes are picked up automatically
- `openspec/specs/implement.md` — this is the spec, not the implementation
- Any file in `.claude/commands/` — those are generated, not source

**New file created at runtime (not committed):**
- `.claude/backlog-cache.json` — written by `/implement` Phase 0 and `/product-backlog`; never committed to git

---

## Current State of the Relevant Templates

```
templates/commands/
├── implement.md               # Full pipeline — ADD Phase 3a.0, 4c.0, Phase 0 snapshot, 4e section
├── product-backlog.md         # Backlog viewer — ADD post-display snapshot write
└── update-product-driven-backlog.md  # Unrelated — do not touch
```

---

## Where to Insert Each Change in `implement.md`

Read `templates/commands/implement.md` in full before making any edits. The file is long. Here is the insertion map:

| New block | Insert after... | Insert before... |
|-----------|----------------|-----------------|
| Phase 0 snapshot capture + gitignore advisory | The `BACKLOG_VIEW_CMD` block and issue-fetch loop in Phase 0 | The confirmation table that the user sees before Phase 1 |
| `SNAPSHOTS_CAPTURED` and `CONFLICT_OVERRIDES` variable declarations | The flag-detection variable declarations in Phase 0 | The "If the user passed a text description" block |
| Phase 3a.0 block | End of Phase 0 / confirmation table | The `## Phase 3a: Architect (parallel, in main repo)` heading |
| Phase 4c.0 block | End of Phase 4b-sec (security reviewer output parsing) | The `### Dry-Run Gate` block in Phase 4c |
| Conflict Overrides section in Phase 4e | The standard pipeline table in Phase 4e | The shipping mode notes at the end of Phase 4e |

---

## Where to Insert the Change in `product-backlog.md`

Read `templates/commands/product-backlog.md` in full. It is short. The file ends after step 6 (the "no issues" fallback). Insert the snapshot write as a new final step (step 7) in the Execution section, after the product-analyst agent's output, framed as an orchestrator action (not inside the agent prompt):

```
7. **[Orchestrator]** After the product-analyst completes, write issue snapshots to `.claude/backlog-cache.json`:

   [snapshot write instructions here]
```

---

## The Cache File Schema

`.claude/backlog-cache.json` — full schema:

```json
{
  "schema_version": "1",
  "provider": "github",
  "last_updated": "2026-03-14T10:23:00Z",
  "written_by": "implement",
  "issues": {
    "42": {
      "number": 42,
      "title": "Backlog Sync Conflict Detection",
      "state": "open",
      "assignees": ["alice"],
      "labels": ["area:Commands", "product-driven-backlog"],
      "body_sha": "a3f5...c9d1",
      "updated_at": "2026-03-13T18:00:00Z",
      "captured_at": "2026-03-14T10:23:00Z"
    }
  }
}
```

Key points:
- `issues` is a map keyed by string issue number (not integer).
- `assignees` and `labels` are always sorted alphabetically before storage.
- `body_sha` is SHA-256 of the raw body string: `echo -n "{body}" | sha256sum | cut -d' ' -f1`
- `updated_at` comes from the GitHub API; `captured_at` is the local wall-clock time of the snapshot.

---

## The Diff Algorithm

At each conflict-check phase:

```
for each issue_ref in ISSUE_REFS:
    fresh = gh issue view {number} --json number,title,state,assignees,labels,body,updatedAt
    cached = .claude/backlog-cache.json["issues"][str(number)]

    if cached is missing:
        log warning "no baseline for #{number}, skipping diff"
        continue

    if fresh.updatedAt == cached.updated_at:
        # GitHub API says nothing changed — skip field comparison
        mark issue as clean
        continue

    # Something changed — compare fields
    conflicts = []
    if fresh.state != cached.state:          conflicts += {field: "state", severity: ...}
    if fresh.title != cached.title:          conflicts += {field: "title", severity: "WARNING"}
    if sort(fresh.assignees) != cached.assignees:  conflicts += {field: "assignees", severity: "WARNING"}
    if sort(fresh.labels) != cached.labels:  conflicts += {field: "labels", severity: "INFO"}

    fresh_body_sha = sha256(fresh.body)
    if fresh_body_sha != cached.body_sha:    conflicts += {field: "body", severity: "WARNING"}
```

Severity for `state`:
- `open` → `closed`: CRITICAL
- `closed` → `open`: WARNING

---

## The Conflict Report Format

```
## Backlog Conflict Detected

The following issues changed since Phase 0 snapshot (captured at 2026-03-14T10:23:00Z):

| Issue | Field | Severity | Was | Now |
|-------|-------|----------|-----|-----|
| #42   | state | CRITICAL | open | closed |
| #42   | body  | WARNING  | a3f5...c9d1 | 9b2e...a7f0 |

How would you like to proceed?
  [A] Abort — stop the pipeline and exit cleanly
  [C] Continue — proceed despite the conflicts (logged)

Enter A or C:
```

User input rules:
- Accept `A`, `a`, `C`, `c`.
- Re-prompt on anything else, up to 3 times.
- After 3 invalid inputs: default to abort and print `[conflict-abort] Defaulting to abort after 3 invalid inputs.`

---

## Guard Conditions Summary

Conflict checks are skipped entirely when:
1. `SNAPSHOTS_CAPTURED=false` — input was not issue numbers, or GH was unavailable at Phase 0.
2. `DRY_RUN=true` — no live backlog operations in dry-run mode.

When skipped, print: `[conflict-check] Skipped — SNAPSHOTS_CAPTURED=false (or dry-run mode).`

---

## Variable Summary

New variables introduced by this change:

| Variable | Type | Set in | Description |
|----------|------|--------|-------------|
| `SNAPSHOTS_CAPTURED` | boolean | Phase 0 | True when issue snapshots were successfully written to cache |
| `CONFLICT_OVERRIDES` | list | Phase 3a.0 / 4c.0 | Conflict records where user chose Continue |

---

## Existing Pipeline Variables This Feature Reads

| Variable | Defined in | Usage |
|----------|-----------|-------|
| `GH_AVAILABLE` | Phase -1 | Gates all snapshot and conflict-check logic |
| `DRY_RUN` | Phase 0 | Skips conflict checks when true |
| `SINGLE_MODE` | Phase 0 | Does NOT skip conflict checks; issue-based single mode still runs checks |

---

## Edge Cases to Handle

| Scenario | How to handle |
|----------|--------------|
| `gh issue view` returns non-zero (issue deleted) | Treat as CRITICAL conflict: "Issue #N no longer exists on GitHub." |
| Cache file missing at conflict-check time | Log warning, skip diff for that issue, treat as clean |
| Cache file is malformed JSON | Treat as missing; log warning, skip diff |
| `sha256sum` not available on system | Fall back to `openssl dgst -sha256` or `shasum -a 256`. Document both fallbacks in the phase prose. |
| User has `.claude/` in `.gitignore` already | Gitignore advisory is suppressed (grep matches) |
| Multiple issues, only some conflicted | Report only conflicted issues; clean issues not mentioned |
| Phase 4c.0 sees same conflict user already continued through at Phase 3a.0 | Still report it — checks are independent |

---

## Template Conventions to Follow

- Use inline variable names (e.g., `SNAPSHOTS_CAPTURED`) in prose, not `{{PLACEHOLDER}}` syntax — runtime variables are not template placeholders.
- Only `{{UPPER_SNAKE_CASE}}` tokens that are substituted at `/setup` time should use the placeholder syntax.
- New phases follow the same heading style as existing phases: `## Phase 3a.0: Pre-architect conflict check`.
- Bash code blocks use triple backticks with `bash` annotation.
- Prose is imperative: "Run the following", "Print:", "Set X=".
- The `product-backlog.md` orchestrator step is labeled `[Orchestrator]` in a bold prefix to distinguish it from agent-prompt instructions.
