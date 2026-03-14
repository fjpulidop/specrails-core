---
change: smart-feature-ordering
type: context-bundle
---

# Context Bundle: Smart Feature Ordering & Dependency Detection

## What You Are Building

You are extending `/product-backlog` to read the `Prerequisites` field already present in every GitHub Issue body, build a dependency graph, and render three new outputs: a `Prereqs` column in backlog tables, filtered Top 3 recommendations, and a Safe Implementation Order section. This is a pure change to one template file — `templates/commands/product-backlog.md`.

---

## Files to Change

| Path | Change Type | Notes |
|------|-------------|-------|
| `templates/commands/product-backlog.md` | Modified | Only file that changes |
| `.claude/commands/product-backlog.md` | Re-generated | Run `/setup` after editing the template |

**Do NOT modify:**
- `templates/commands/update-product-driven-backlog.md` — prerequisite data is already written correctly
- `install.sh` — no new config or placeholder is introduced
- `openspec/config.yaml` — no schema changes
- Any agent template in `templates/agents/`

---

## Current State of `templates/commands/product-backlog.md`

The file is a single-agent command. It launches one `product-analyst` subagent and gives it numbered instructions. The agent currently:

1. Fetches all open issues via `{{BACKLOG_FETCH_CMD}}`
2. Parses: Area, Persona Fit, Effort, Description, User Story
3. Groups by area
4. Sorts by Total Persona Score desc, then Effort
5. Displays a table per area + Top 3 recommendations
6. Handles the empty backlog case

The current table format has these columns: `#`, `Issue`, `{{PERSONA_SCORE_HEADERS}}`, `Total`, `Effort`.

The current Top 3 block reads:
> **propose the top 3 items** for implementation

There is no mention of prerequisites, dependency graphs, or ordering analysis anywhere in the file.

---

## What the Issue Body Looks Like (existing format)

Every issue created by `/update-product-driven-backlog` contains this Overview table:

```markdown
## Overview

| Field | Value |
|-------|-------|
| **Area** | Product |
| **Persona Fit** | ... |
| **Effort** | High — justification |
| **Inspiration** | ... |
| **Prerequisites** | #12, #17 |
```

Or for features with no prerequisites:

```markdown
| **Prerequisites** | None |
```

The `Prerequisites` row is always present. This data is ready to parse — no issue body changes are needed.

---

## Exact Changes to `templates/commands/product-backlog.md`

### Location anchor

All changes are inside the product-analyst prompt block, which begins with:

```
The product-analyst receives this prompt:
```

and ends before the `6. If no issues exist:` block.

### Step 1: Insert Step 3 (prerequisite parsing) after current Step 2

After the current Step 2 block (the bullet list ending with `**User Story**: from the body's "User Story" section`), insert:

```
3. **Parse prerequisites for each issue:**
   - Locate the row whose first cell matches `**Prerequisites**` in the issue body's Overview table.
   - If the cell value is `None`, `-`, or empty: set `prereqs = []` for this issue.
   - Otherwise: extract all tokens matching `#\d+` from the value cell. Set `prereqs = [<numbers>]`.
   - If a prerequisite number does not appear in the fetched issue list, treat it as already satisfied. Do not add it to the dependency graph.
```

### Step 2: Insert Step 4 (DAG construction + cycle detection) after new Step 3

```
4. **Build dependency graph and detect cycles:**
   - Construct a directed graph: for each issue with non-empty `prereqs`, add an edge from each prerequisite issue to the current issue (meaning: prerequisite must complete first).
   - Run DFS cycle detection (maintain `visited` and `rec_stack` sets). Collect all `CYCLE_MEMBERS`.
   - If `CYCLE_MEMBERS` is non-empty, prepare this warning to render before the first backlog table:
     ```
     > **Warning: Circular dependency detected in backlog.**
     > The following issues form a cycle and cannot be safely ordered: #A -> #B -> #A
     > Review these issues and correct the Prerequisites fields.
     ```
   - Compute `in_degree[issue]` for all issues: count of edges pointing into each issue from other open backlog issues.
```

### Step 3: Insert Step 5 (topological sort) after new Step 4

```
5. **Compute safe implementation order using Kahn's topological sort:**
   - Exclude `CYCLE_MEMBERS`.
   - `ready` = all non-cycle issues with `in_degree == 0`, sorted by Total Persona Score descending.
   - Build `WAVES`:
     ```
     while ready:
         WAVES.append(copy of ready)
         next_ready = []
         for issue in ready:
             for dependent D with edge (issue → D):
                 in_degree[D] -= 1
                 if in_degree[D] == 0: next_ready.append(D)
         sort next_ready by Total Persona Score descending
         ready = next_ready
     ```
   - `WAVE_1 = WAVES[0]` (features that can start immediately).
```

### Step 4: Renumber existing Steps 3–6 to Steps 6–9

The existing steps 3 (Group by area), 4 (Sort), 5 (Display), 6 (empty backlog) become steps 6, 7, 8, 9.

### Step 5: Modify the display table format (now Step 8)

In the table format block, change the header and separator lines to add `Prereqs`:

**Before:**
```
| # | Issue | {{PERSONA_SCORE_HEADERS}} | Total | Effort |
|---|-------|{{PERSONA_SCORE_SEPARATORS}}|-------|--------|
| 1 | #42 Feature name | ... | X/{{MAX_SCORE}} | Low |
```

**After:**
```
| # | Issue | {{PERSONA_SCORE_HEADERS}} | Total | Effort | Prereqs |
|---|-------|{{PERSONA_SCORE_SEPARATORS}}|-------|--------|---------|
| 1 | #42 Feature name [blocked] | ... | X/{{MAX_SCORE}} | Low | #12, #17 |
| 2 | #43 Other feature | ... | X/{{MAX_SCORE}} | High | — |
```

Add above the table: "If `CYCLE_MEMBERS` is non-empty, render the cycle warning block here before this table."

Add to the rendering rules:
- Append `[blocked]` to the Issue cell if `in_degree[issue] > 0` and issue is not in `CYCLE_MEMBERS`.
- Append `[cycle]` to the Issue cell if issue is in `CYCLE_MEMBERS`.
- `Prereqs` cell: list prerequisite issue numbers as `#N, #M`, or `—` if none.

### Step 6: Modify Top 3 selection pool (in the ## Recommended Next Sprint block)

**Before:**
> **propose the top 3 items** for implementation

**After:**
> **propose the top 3 items from `WAVE_1`** (features with all prerequisites satisfied) for implementation. If fewer than 3 are in `WAVE_1`, show as many as available and add: "Note: Only {N} feature(s) are available to start immediately — remaining features have unmet prerequisites."

### Step 7: Add Safe Implementation Order section (new Step 9, after Top 3)

Insert as Step 9 (before the empty backlog step):

```
9. **Render Safe Implementation Order section** after the Recommended Next Sprint table:

   ---

   ## Safe Implementation Order

   Features grouped by wave. All features in a wave can start in parallel.
   Wave N must complete before wave N+1 begins.

   | Wave | Issue | Title | Prereqs | Score | Effort |
   |------|-------|-------|---------|-------|--------|
   | 1    | #N    | Feature A | — | X/{{MAX_SCORE}} | Low |
   | 2    | #M    | Feature B | #N | X/{{MAX_SCORE}} | Medium |

   To implement in this order:
     /batch-implement <refs in wave order> --deps "<A> -> <B>, ..."

   [Omit --deps if the DAG has no edges]

   [If CYCLE_MEMBERS non-empty:]
   Cycle members excluded from ordering: #A, #B
   Fix the Prerequisites fields in these issues to include them.

   Construct the --deps string from all DAG edges: each edge (A → B) becomes "A -> B",
   joined by ", ". Issue refs are listed wave-by-wave, sorted by persona score within each wave.
```

Renumber the empty backlog step to Step 10.

---

## Existing Patterns to Follow

- The product-analyst prompt block uses numbered steps with nested bullet points and fenced code blocks for display format examples. Match this style exactly.
- Table format examples in the prompt use `{{PLACEHOLDER}}` syntax for template variables — do not invent new ones.
- Conditional rendering is expressed as inline `[If X: ...]` notes within the numbered step. See the existing "If no issues exist" pattern for reference.
- New sections use `---` horizontal rule separators between major display blocks, matching the existing `---` before "Recommended Next Sprint".

---

## Conventions Checklist

- [ ] No new `{{PLACEHOLDER}}` variables introduced (check with `grep '{{[A-Z_]*}}' templates/commands/product-backlog.md`)
- [ ] Step numbering is sequential and no gaps
- [ ] All pseudocode is in fenced code blocks with consistent indentation
- [ ] Table column order: Wave, Issue, Title, Prereqs, Score, Effort (for ordering table); #, Issue, Personas, Total, Effort, Prereqs (for area tables)
- [ ] `[blocked]` and `[cycle]` markers are clearly defined
- [ ] `WAVE_1` is defined before it is referenced in the Top 3 step
- [ ] Empty backlog step remains as the final numbered step

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Prerequisites field absent from older issues | Medium | Treat missing row as `prereqs = []` — no blocking |
| Circular deps in real backlog data | Low | Cycle detection with named warning; rendering continues |
| Very large backlogs slow down analysis | Low | All computation is in-memory string parsing; no additional API calls |
| `--deps` string becomes unwieldy for large graphs | Low | This is a display concern; the string is still correct and usable |
| Top 3 shows 0 candidates if all features are blocked | Low | "Only 0 features available" note guides the user to fix prerequisites |

---

## Key Reference: Existing `--deps` Format in `/batch-implement`

The `--deps` flag format is already defined in `templates/commands/batch-implement.md`:

```
--deps "<spec>": inline dependency spec, e.g. "#71 -> #85, #63 -> #85"
(meaning #71 and #63 must complete before #85)
```

The Safe Implementation Order section's suggested command uses this exact format. No changes to `/batch-implement` are needed — this change only produces a suggested invocation string that users can copy.
