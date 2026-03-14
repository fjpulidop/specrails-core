---
change: smart-feature-ordering
type: tasks
---

# Tasks: Smart Feature Ordering & Dependency Detection

All tasks target a single file: `templates/commands/product-backlog.md`. Tasks must be executed in order — each task builds on the previous one within the same file.

---

## Task 1 — Add prerequisite parsing to product-analyst instructions [templates]

**File:** `templates/commands/product-backlog.md`

**Description:**
After the existing Step 2 ("Parse each issue/ticket to extract metadata"), insert a new Step 3 that instructs the product-analyst agent to parse the `Prerequisites` row from each issue's Overview table.

**Changes:**
- Renumber the existing steps 3–6 to steps 4–7 to make room for the new step.
- Insert the following as the new Step 3:

```
3. **Parse prerequisites for each issue:**
   - Locate the row whose first cell matches `**Prerequisites**` in the issue body's Overview table.
   - If the cell value is `None`, `-`, or empty: set `prereqs = []` for this issue.
   - Otherwise: extract all tokens matching `#\d+` from the cell and set `prereqs = [<numbers>]`.
   - If a prerequisite number does not appear in the fetched issue list, treat it as already satisfied (externally closed). Do not include it in the DAG.
```

**Acceptance criteria:**
- The step is present with correct numbering.
- The rule for treating external prerequisites as satisfied is explicitly stated.
- No existing steps are removed or reworded.

**Dependencies:** None.

---

## Task 2 — Add DAG construction and cycle detection step [templates]

**File:** `templates/commands/product-backlog.md`

**Description:**
After Task 1's new Step 3, insert Step 4: build the dependency DAG and run cycle detection.

**Changes:**
Insert as new Step 4 (pushing remaining steps to 5–8):

```
4. **Build dependency graph and detect cycles:**
   - Construct a directed graph where edge `(A → B)` means "issue A must complete before issue B".
   - For each issue with a non-empty `prereqs` list, add an edge from each prerequisite to the issue.
   - Run depth-first cycle detection:
     - Maintain `visited` and `rec_stack` sets.
     - For each unvisited node, run DFS. If a node in `rec_stack` is encountered, a cycle exists.
   - Collect all cycle members into `CYCLE_MEMBERS`.
   - If `CYCLE_MEMBERS` is non-empty, prepare a warning block to render before the backlog table:
     ```
     > **Warning: Circular dependency detected in backlog.**
     > The following issues form a cycle and cannot be safely ordered:
     > #A -> #B -> #A
     > Review these issues and correct the Prerequisites fields.
     ```
   - Compute `in_degree[issue]` for all issues (count of prerequisite edges pointing to each issue from other open backlog issues).
```

**Acceptance criteria:**
- DAG construction rule is unambiguous (edge direction is clear: prereq → dependent).
- Cycle detection produces `CYCLE_MEMBERS`.
- `in_degree` computation is described.
- Warning block format is specified verbatim.

**Dependencies:** Task 1.

---

## Task 3 — Add topological sort (wave computation) step [templates]

**File:** `templates/commands/product-backlog.md`

**Description:**
Insert Step 5: compute `WAVES` using Kahn's algorithm. This is used by both the Top 3 filter and the Safe Implementation Order section.

**Changes:**
Insert as new Step 5:

```
5. **Compute safe implementation order (Kahn's topological sort):**
   - Exclude `CYCLE_MEMBERS` from this computation.
   - Initialize `ready` = all non-cycle issues where `in_degree == 0`.
   - Sort `ready` by Total Persona Score descending.
   - Build `WAVES = []`:
     ```
     while ready is non-empty:
         WAVES.append(copy of ready)
         next_ready = []
         for each issue in ready:
             for each dependent D of issue (edges issue → D):
                 in_degree[D] -= 1
                 if in_degree[D] == 0: next_ready.append(D)
         sort next_ready by Total Persona Score descending
         ready = next_ready
     ```
   - Store `WAVE_1 = WAVES[0]` (the set of immediately startable features).
```

**Acceptance criteria:**
- Kahn's algorithm pseudocode is present and correct (processes zero-in-degree nodes iteratively).
- Within-wave sort by persona score is specified.
- `CYCLE_MEMBERS` are excluded.
- `WAVE_1` is named for use in downstream steps.

**Dependencies:** Task 2.

---

## Task 4 — Modify backlog table rendering to include Prereqs column [templates]

**File:** `templates/commands/product-backlog.md`

**Description:**
Modify the existing Step 3 (now renumbered to Step 6 after Tasks 1–3) — the "Display as formatted table" step — to add the `Prereqs` column and the `[blocked]`/`[cycle]` markers.

**Changes:**
- In the table header line, add `Prereqs |` as the rightmost column.
- In the table separator line, add `---------|`.
- In the row format, add a cell showing prerequisite refs or `—`.
- Append `[blocked]` to the issue title cell if `in_degree[issue] > 0` (and issue not in `CYCLE_MEMBERS`).
- Append `[cycle]` to the issue title cell if issue is in `CYCLE_MEMBERS`.

The modified table example:

```
| # | Issue | {{PERSONA_SCORE_HEADERS}} | Total | Effort | Prereqs |
|---|-------|{{PERSONA_SCORE_SEPARATORS}}|-------|--------|---------|
| 1 | #42 Feature name [blocked] | ... | X/{{MAX_SCORE}} | Low | #12, #17 |
| 2 | #43 Other feature | ... | X/{{MAX_SCORE}} | High | — |
```

Also add: render the cycle warning block (from Task 2) immediately before the first area table if `CYCLE_MEMBERS` is non-empty.

**Acceptance criteria:**
- `Prereqs` column is present in both the header and separator rows.
- `[blocked]` marker rule is stated (in_degree > 0, not a cycle member).
- `[cycle]` marker rule is stated.
- Cycle warning block appears before the table, not after.
- The `—` placeholder is used when prereqs is empty.

**Dependencies:** Tasks 1–3 (step renumbering must be settled first).

---

## Task 5 — Modify Top 3 recommendations to filter by wave eligibility [templates]

**File:** `templates/commands/product-backlog.md`

**Description:**
Modify the existing "Recommended Next Sprint (Top 3)" section to restrict candidates to `WAVE_1` features only.

**Changes:**
- Change the selection pool description from "top 3 items" to "top 3 items from `WAVE_1` (features with all prerequisites satisfied)".
- Add the note that follows if fewer than 3 candidates exist:
  ```
  Note: Only {N} feature(s) are available to start immediately — remaining features have unmet prerequisites.
  ```
- The scoring, ranking table format, and selection criteria bullet points are unchanged.

**Acceptance criteria:**
- Selection pool is explicitly `WAVE_1`.
- The "fewer than 3" note is present with the correct message.
- No other changes to the Top 3 section.

**Dependencies:** Task 3 (WAVE_1 must be defined before this step references it).

---

## Task 6 — Add Safe Implementation Order section [templates]

**File:** `templates/commands/product-backlog.md`

**Description:**
Append a new "Safe Implementation Order" section after the "Recommended Next Sprint" section.

**Changes:**
Append the following to the product-analyst prompt instructions:

```
7. **Render Safe Implementation Order section:**

   After the Recommended Next Sprint table, render:

   ---

   ## Safe Implementation Order

   Features grouped by wave. All features in a wave can start in parallel.
   Features in wave N must complete before wave N+1 begins.

   | Wave | Issue | Title | Prereqs | Score | Effort |
   |------|-------|-------|---------|-------|--------|
   | 1    | #N    | ...   | —       | X/{{MAX_SCORE}} | Low |
   | 2    | #M    | ...   | #N      | X/{{MAX_SCORE}} | Medium |

   To implement in this order:
     /batch-implement <issue-refs in wave order> --deps "<A> -> <B>, <C> -> <D>, ..."

   [If no edges exist in the DAG, omit the --deps clause:]
     /batch-implement <issue-refs>

   [If CYCLE_MEMBERS is non-empty, append:]
   Cycle members excluded from ordering: #A, #B
   Fix the Prerequisites fields in these issues to include them.
```

The `--deps` string is constructed from all edges in the DAG: `"A -> B"` for each edge, comma-separated.
Issue refs in the `/batch-implement` command are listed in wave order (wave 1 first, then wave 2, etc.), sorted by persona score within each wave.

If the backlog has no dependencies at all (DAG has no edges), the section still renders showing all features in wave 1 and omits the `--deps` clause.

**Acceptance criteria:**
- Section header is `## Safe Implementation Order`.
- Wave table columns are: Wave, Issue, Title, Prereqs, Score, Effort.
- The suggested `/batch-implement` command is present.
- `--deps` clause is omitted when no edges exist.
- Cycle member note is conditional on `CYCLE_MEMBERS` being non-empty.
- Section renders even when all features have no dependencies (all in wave 1).

**Dependencies:** Tasks 3–5.

---

## Task 7 — Verify no broken placeholders and re-generate .claude output [core]

**File:** `.claude/commands/product-backlog.md` (re-generated)

**Description:**
After all template edits are complete, verify the template renders cleanly and regenerate the `.claude/` output.

**Steps:**
1. Run: `grep -r '{{[A-Z_]*}}' templates/commands/product-backlog.md` to confirm all placeholders are existing ones (no new ones were introduced by this change).
2. Run `/setup` in update mode to regenerate `.claude/commands/product-backlog.md` from the updated template.
3. Visually inspect `.claude/commands/product-backlog.md` to confirm the new sections are present and no `{{PLACEHOLDER}}` text is visible.

**Acceptance criteria:**
- No new `{{PLACEHOLDER}}` variables appear in the template (this change introduces none).
- `.claude/commands/product-backlog.md` contains the Prereqs column, the modified Top 3 section, and the Safe Implementation Order section.
- All existing placeholder usages (`{{BACKLOG_PREFLIGHT}}`, `{{BACKLOG_FETCH_CMD}}`, `{{PERSONA_SCORE_HEADERS}}`, etc.) are unmodified.

**Dependencies:** Tasks 1–6.
