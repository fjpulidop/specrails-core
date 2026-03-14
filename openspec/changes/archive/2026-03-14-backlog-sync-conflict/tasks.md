---
change: backlog-sync-conflict
type: tasks
---

# Tasks: Backlog Sync Conflict Detection

Tasks are ordered sequentially. Each task depends on the one before it unless stated otherwise.

---

## T1 — Add Phase 0 snapshot capture to `implement.md` [templates]

**Description:**
In `templates/commands/implement.md`, add a snapshot-capture step at the end of the Phase 0 issue-fetch block. This step runs only when `GH_AVAILABLE=true` and the input mode is issue numbers.

The step must:
1. For each resolved issue ref, run: `gh issue view {number} --json number,title,state,assignees,labels,body,updatedAt`
2. Sort `assignees` and `labels` alphabetically.
3. Compute `body_sha`: `echo -n "{body}" | sha256sum | cut -d' ' -f1`
4. Write the snapshot map into `.claude/backlog-cache.json` using the schema from `design.md`. Overwrite the file fully (not merge — Phase 0 always owns a fresh baseline for this run).
5. Set `SNAPSHOTS_CAPTURED=true`.

When `GH_AVAILABLE=false` or input is not issue numbers: set `SNAPSHOTS_CAPTURED=false`. Print `[conflict-check] Snapshot skipped — GH unavailable or non-issue input.`

Add `SNAPSHOTS_CAPTURED` and `CONFLICT_OVERRIDES` to the pipeline's variable tracking (as inline prose, consistent with how other variables are described in the command).

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- The snapshot step appears after the `BACKLOG_VIEW_CMD` fetch block in Phase 0, before the confirmation table.
- `SNAPSHOTS_CAPTURED=true` is set only when both `GH_AVAILABLE=true` and issue refs were the input mode.
- `.claude/backlog-cache.json` written with `schema_version: "1"`, `provider: "github"`, `written_by: "implement"`, and a `issues` map keyed by string issue number.
- `body_sha` is computed via `sha256sum` (not stored raw body).
- `assignees` and `labels` are sorted before storage.
- `CONFLICT_OVERRIDES` initialized to empty list.
- If write fails (`.claude/` missing), print a warning and set `SNAPSHOTS_CAPTURED=false` — do not abort.

**Dependencies:** none

---

## T2 — Add Phase 3a.0 pre-architect conflict check to `implement.md` [templates]

**Description:**
In `templates/commands/implement.md`, insert a new `Phase 3a.0` block immediately before the existing Phase 3a (architect agent launch). This is the first conflict gate.

The phase must:
1. Check guard: if `SNAPSHOTS_CAPTURED=false` OR `DRY_RUN=true`, print `[conflict-check] Skipped.` and proceed to Phase 3a.
2. For each issue ref, re-fetch: `gh issue view {number} --json number,title,state,assignees,labels,body,updatedAt`
3. Compute a fresh snapshot (same shape as Phase 0).
4. Diff against `.claude/backlog-cache.json` entries using the diff algorithm from `design.md` (check `updated_at` first; if unchanged, mark clean; if changed, compare `state`, `title`, `assignees`, `labels`, `body_sha`).
5. Collect all conflicts with their severity classification.
6. If no conflicts: print `[conflict-check] All issues clean (Phase 3a.0). Proceeding.` and continue.
7. If conflicts: print the conflict report table (format from `design.md`) and await user input.
   - Accept `A`/`a` (abort) or `C`/`c` (continue). Re-prompt on invalid input, up to 3 times. Default to abort on third invalid.
   - On abort: print `[conflict-abort] Pipeline aborted. Re-run /implement after resolving the issues.` and exit.
   - On continue: print `[conflict-override] Continuing. N conflict(s) logged.` Append each conflict to `CONFLICT_OVERRIDES` with `{phase: "3a.0", issue, field, severity, was, now}`.

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 3a.0 block appears between Phase 0 and Phase 3a in the document.
- Guard conditions (`SNAPSHOTS_CAPTURED=false`, `DRY_RUN=true`) are checked at the top of the phase.
- `updated_at` short-circuit is present: if `updated_at` matches, skip field comparison.
- All five conflictable fields are checked: `state`, `title`, `assignees`, `labels`, `body_sha`.
- Severity classification matches `design.md` table exactly.
- Conflict report table format matches `design.md` "Conflict Report Format" section.
- Invalid input re-prompts up to 3 times, then defaults to abort.
- Abort exits without any git state changes.
- Continue appends to `CONFLICT_OVERRIDES`; pipeline proceeds to Phase 3a.

**Dependencies:** T1

---

## T3 — Add Phase 4c.0 pre-ship conflict check to `implement.md` [templates]

**Description:**
In `templates/commands/implement.md`, insert a new `Phase 4c.0` block immediately before Phase 4c (the shipping phase). This is the final conflict gate — the last check before code reaches git.

The phase is structurally identical to Phase 3a.0. It MUST NOT skip the check just because the user continued through Phase 3a.0. Each check is independent.

The phase must follow the same pattern as T2 (guard check, re-fetch, diff, report, await A/C input) with `phase: "4c.0"` in conflict override entries.

Also add the Dry-Run Gate note: when `DRY_RUN=true`, this phase is skipped (consistent with all Phase 4c behavior).

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 4c.0 block appears between Phase 4b-sec (security reviewer) and the Dry-Run Gate in Phase 4c.
- Same guard, re-fetch, diff, report, and A/C input logic as Phase 3a.0.
- Conflicts from Phase 3a.0 that the user continued through are still reported if they persist.
- `phase: "4c.0"` used in `CONFLICT_OVERRIDES` entries for this check.
- On abort: no git operations have been performed (this check runs before any git op in Phase 4c).

**Dependencies:** T2

---

## T4 — Add Conflict Overrides section to Phase 4e report in `implement.md` [templates]

**Description:**
In `templates/commands/implement.md`, add a `## Conflict Overrides` section to the Phase 4e final report block. This section appears only when `CONFLICT_OVERRIDES` is non-empty.

The section format:
```
## Conflict Overrides

The following backlog conflicts were detected but overridden by the user:

| Phase | Issue | Field | Severity | Was | Now |
|-------|-------|-------|----------|-----|-----|
| 3a.0  | #42   | state | CRITICAL | open | closed |
```

If `CONFLICT_OVERRIDES` is empty or `SNAPSHOTS_CAPTURED=false`: omit the section entirely. Do not print an empty table or a "No conflict overrides" line — simply omit.

Update the standard pipeline table in Phase 4e to note whether conflict checks ran: add a `Conflicts` column with value `clean`, `overridden (N)`, or `skipped`.

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- `## Conflict Overrides` section is present in Phase 4e report prose with conditional logic.
- Section is omitted when `CONFLICT_OVERRIDES` is empty.
- Table columns: Phase, Issue, Field, Severity, Was, Now.
- Standard pipeline table has a `Conflicts` column.
- `Conflicts` column values: `clean` (no conflicts detected), `overridden (N)` (user chose Continue N times), `skipped` (guard condition was met).

**Dependencies:** T3

---

## T5 — Add snapshot write to `product-backlog.md` [templates]

**Description:**
In `templates/commands/product-backlog.md`, add a snapshot-write step after the product-analyst agent's display output completes.

The step runs in the orchestrating command (not inside the agent prompt). It:
1. Checks `GH_AVAILABLE` — if false, skip and print `[backlog-cache] Skipped — GH unavailable.`
2. For each issue the product-analyst fetched, write a snapshot to `.claude/backlog-cache.json` using the same schema from `design.md`.
3. Merge strategy: if the file already exists, read it, merge new entries by issue number (new entries overwrite old by number key), write back. If the file does not exist, create it.
4. Set `written_by: "product-backlog"` and update `last_updated`.
5. If write fails: print `[backlog-cache] Warning: could not write cache. Continuing.` Do not abort.

Note: The product-analyst agent already fetches issues via `BACKLOG_FETCH_CMD`. The command needs the raw issue data (number, title, state, assignees, labels, body, updatedAt) to build snapshots. Add a bash step after the agent completes that re-fetches each issue in the result set for snapshot purposes, OR — preferably — instruct the product-analyst to output a machine-readable issue list at the end of its response that the command can parse.

Design decision: use a re-fetch approach for simplicity and reliability. After the agent displays its output, the command runs `gh issue list --label "product-driven-backlog" --state open --json number,title,state,assignees,labels,body,updatedAt` to get all issues in one call, then writes snapshots for each. This is one additional API call and avoids parsing agent output.

**Files:**
- Modify: `templates/commands/product-backlog.md`

**Acceptance criteria:**
- Snapshot write step appears after the product-analyst agent completes, before the command returns.
- Uses `gh issue list --label "product-driven-backlog" --state open --json number,title,state,assignees,labels,body,updatedAt` for the batch fetch.
- Merge logic: existing entries preserved for issue numbers not in current fetch; new/updated entries overwrite by number key.
- `written_by: "product-backlog"` set in the file.
- Write failure is non-fatal — warning printed, command continues.
- `GH_AVAILABLE=false` guard skips silently.
- The step is invisible to the user on the happy path (no output unless there's a warning).

**Dependencies:** none (independent of T1–T4)

---

## T6 — Add `.gitignore` advisory for `.claude/backlog-cache.json` [templates]

**Description:**
In `templates/commands/implement.md`, add a one-time gitignore check immediately after the snapshot write in Phase 0 (T1's step). If the snapshot was captured, check whether `.gitignore` covers `backlog-cache.json`:

```bash
grep -q "backlog-cache" .gitignore 2>/dev/null || \
grep -q "\.claude/" .gitignore 2>/dev/null
```

If neither pattern is found, print:
```
[backlog-cache] Suggestion: add '.claude/backlog-cache.json' to .gitignore to avoid committing ephemeral cache state.
```

This is a one-time advisory. It MUST NOT block the pipeline. It MUST NOT re-print on every run if the user has already added the entry.

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- `.gitignore` check appears after the cache write in Phase 0, only when `SNAPSHOTS_CAPTURED=true`.
- Check is non-blocking — passes whether or not `.gitignore` is updated.
- Advisory prints only when neither `backlog-cache` nor `.claude/` is found in `.gitignore`.
- Advisory message matches the format above exactly.

**Dependencies:** T1

---

## T7 — Manual end-to-end verification [core]

**Description:**
Verify the complete conflict detection flow works end-to-end using the specrails repo as a test bed.

**Verification steps:**

1. Identify a real open GitHub Issue in the specrails repo (or use a test issue).
2. Run `/implement #<number>` and confirm Phase 0 writes `.claude/backlog-cache.json`. Inspect the file: validate JSON is well-formed, `schema_version: "1"` is present, `body_sha` is a 64-char hex string, `assignees` and `labels` are sorted arrays.
3. While the pipeline is in Phase 3a (architect running), manually close the issue via `gh issue close <number>`. Wait for architect to complete.
4. Confirm Phase 3a.0 re-fetch detects the close and prints the conflict report with `state: CRITICAL`.
5. Choose `[A]bort` — verify the pipeline exits cleanly with no git state left behind.
6. Reopen the issue. Re-run `/implement #<number>`.
7. At Phase 3a.0, all issues should be clean — confirm `[conflict-check] All issues clean (Phase 3a.0). Proceeding.` is printed.
8. At Phase 4c.0, confirm the second clean check runs and prints cleanly.
9. Run `/product-backlog` and confirm `.claude/backlog-cache.json` is updated with `written_by: "product-backlog"`.
10. Run `/implement` with `--dry-run` — confirm both conflict check phases print `[conflict-check] Skipped.`

**Files:** none (verification only)

**Acceptance criteria:**
- All 10 steps pass without errors.
- `.claude/backlog-cache.json` is valid JSON on inspection (verify with `jq . .claude/backlog-cache.json`).
- Abort path leaves no git branches, commits, or staged changes.
- Dry-run path produces no conflict check output beyond the skip line.
- No unresolved `{{PLACEHOLDER}}` tokens in any output.

**Dependencies:** T1, T2, T3, T4, T5, T6
