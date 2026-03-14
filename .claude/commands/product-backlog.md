---
name: "Product Backlog"
description: "View product-driven backlog from GitHub Issues and propose top 3 for implementation"
category: Workflow
tags: [workflow, backlog, viewer, product-driven]
---

Display the product-driven backlog by reading issues from GitHub Issues. These are feature ideas generated through VPC-based product discovery — evaluated against user personas. Use `/update-product-driven-backlog` to generate new ideas.

**Input:** $ARGUMENTS (optional: comma-separated areas to filter. If empty, show all.)

---

## Phase 0: Environment Pre-flight

Verify GitHub CLI is accessible:

```bash
gh auth status 2>&1
```

If GitHub CLI is unavailable, stop and inform the user.

---

## Execution

Launch a **single** product-analyst agent (`subagent_type: product-analyst`) to read and prioritize the backlog.

The product-analyst receives this prompt:

> You are reading the product-driven backlog from GitHub Issues and producing a prioritized view.

1. **Fetch all open product-driven backlog items:**
   ```bash
   gh issue list --label "product-driven-backlog" --state open --limit 100 --json number,title,labels,body
   ```

2. **Parse each issue** to extract metadata from the body:
   - **Area**: from `area:*` label
   - **Persona Fit**: from the body's Overview table — extract per-persona scores and total
   - **Effort**: from the body's Overview table (High/Medium/Low)
   - **Description**: from the body's "Feature Description" section
   - **User Story**: from the body's "User Story" section

3. **Parse prerequisites for each issue:**
   - Locate the row whose first cell matches `**Prerequisites**` in the issue body's Overview table.
   - If the cell value is `None`, `-`, or empty: set `prereqs = []` for this issue.
   - Otherwise: extract all tokens matching `#\d+` from the cell and set `prereqs = [<numbers>]`.
   - If a prerequisite number does not appear in the fetched issue list, treat it as already satisfied (externally closed). Do not include it in the DAG.

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

6. **Group by area**.

7. **Sort within each area by Total Persona Score (descending)**, then by Effort (Low > Medium > High) as tiebreaker.

8. **Display** as a formatted table per area, then **propose the top 3 items from `WAVE_1`** (features with all prerequisites satisfied) for implementation. If fewer than 3 are in `WAVE_1`, show as many as available and add: "Note: Only {N} feature(s) are available to start immediately — remaining features have unmet prerequisites."

   [If `CYCLE_MEMBERS` is non-empty, render the cycle warning block immediately before the first area table.]

   Render each area table with the following format:
   - Append `[blocked]` to the issue title cell if `in_degree[issue] > 0` and the issue is not in `CYCLE_MEMBERS`.
   - Append `[cycle]` to the issue title cell if the issue is in `CYCLE_MEMBERS`.
   - `Prereqs` cell: list prerequisite issue numbers as `#N, #M`, or `—` if none.

   ```
   ## Product-Driven Backlog

   {N} open issues | Source: VPC-based product discovery
   Personas: "Alex" (Lead Dev), "Sara" (Product Founder), "Kai" (Maintainer)

   ### {Area Name}

   | # | Issue | Alex | Sara | Kai | Total | Effort | Prereqs |
   |---|-------|------|------|-----|-------|--------|---------|
   | 1 | #42 Feature name [blocked] | X/5 | X/5 | X/5 | X/15 | Low | #12, #17 |
   | 2 | #43 Other feature | X/5 | X/5 | X/5 | X/15 | High | — |

   ---

   ## Recommended Next Sprint (Top 3)

   Ranked by VPC persona score / effort ratio:

   | Priority | Issue | Area | Alex | Sara | Kai | Total | Effort | Rationale |
   |----------|-------|------|------|------|-----|-------|--------|-----------|

   ### Selection criteria
   - Cross-persona features (both 4+/5) prioritized over single-persona
   - Low effort preferred over high effort at same score
   - Critical pain relief weighted higher than gain creation

   Run `/implement` to start implementing these items.
   ```

9. **Render Safe Implementation Order section** after the Recommended Next Sprint table:

   ```
   ---

   ## Safe Implementation Order

   Features grouped by wave. All features in a wave can start in parallel.
   Features in wave N must complete before wave N+1 begins.

   | Wave | Issue | Title | Prereqs | Score | Effort |
   |------|-------|-------|---------|-------|--------|
   | 1    | #N    | ...   | —       | X/15 | Low |
   | 2    | #M    | ...   | #N      | X/15 | Medium |

   To implement in this order:
     /batch-implement <issue-refs in wave order> --deps "<A> -> <B>, <C> -> <D>, ..."

   [If no edges exist in the DAG, omit the --deps clause:]
     /batch-implement <issue-refs>

   [If CYCLE_MEMBERS is non-empty, append:]
   Cycle members excluded from ordering: #A, #B
   Fix the Prerequisites fields in these issues to include them.
   ```

   Issue refs in the `/batch-implement` command are listed in wave order (wave 1 first, then wave 2, etc.), sorted by persona score within each wave. The `--deps` string is constructed from all edges in the DAG: `"A -> B"` for each edge, comma-separated. If the backlog has no dependencies at all (DAG has no edges), the section still renders showing all features in wave 1 and the `--deps` clause is omitted.

10. If no issues exist:
    ```
    No product-driven backlog issues found. Run `/update-product-driven-backlog` to generate feature ideas.
    ```

7. **[Orchestrator]** After the product-analyst completes, write issue snapshots to `.claude/backlog-cache.json`.

   **Guard:** If `GH_AVAILABLE=false` (from Phase 0 pre-flight), print `[backlog-cache] Skipped — GH unavailable.` and return. Do not attempt the write.

   **Fetch all open backlog issues in one call:**

   ```bash
   gh issue list --label "product-driven-backlog" --state open --json number,title,state,assignees,labels,body,updatedAt
   ```

   For each issue in the result, build a snapshot object:
   - `number`: integer issue number
   - `title`: issue title string
   - `state`: `"open"` or `"closed"`
   - `assignees`: array of assignee login names, sorted alphabetically
   - `labels`: array of label names, sorted alphabetically
   - `body_sha`: SHA-256 of the raw body string — compute with:
     ```bash
     echo -n "{body}" | sha256sum | cut -d' ' -f1
     ```
     If `sha256sum` is not available, fall back to `openssl dgst -sha256 -r` or `shasum -a 256`.
   - `updated_at`: the `updatedAt` value from the GitHub API response
   - `captured_at`: current local time in ISO 8601 format

   **Merge strategy:** If `.claude/backlog-cache.json` already exists and is valid JSON, read it and merge: new snapshot entries overwrite existing entries by issue number key; entries for issue numbers not in the current fetch are preserved (they may be needed by an in-progress `/implement` run). If the file does not exist or is malformed, create it fresh.

   Write the merged result back to `.claude/backlog-cache.json` with:
   - `schema_version`: `"1"`
   - `provider`: `"github"`
   - `last_updated`: current ISO 8601 timestamp
   - `written_by`: `"product-backlog"`
   - `issues`: the merged map keyed by string issue number

   If the write fails (e.g., `.claude/` directory does not exist): print `[backlog-cache] Warning: could not write cache. Continuing.` Do not abort.
