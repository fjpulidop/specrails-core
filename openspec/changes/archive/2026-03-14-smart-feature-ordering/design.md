---
change: smart-feature-ordering
type: design
---

# Technical Design: Smart Feature Ordering & Dependency Detection

## Overview

All changes are confined to a single file: `templates/commands/product-backlog.md`. The command already launches a `product-analyst` subagent to fetch and render issues. We extend that subagent's instructions to include dependency parsing, DAG construction, topological sorting, and new rendering sections.

No new files. No new config keys. No installer changes.

---

## Data Flow

```
GitHub Issues (open, label: product-driven-backlog)
        |
        v
[product-analyst agent]
        |
        +-- Step 1: Fetch all issues (existing)
        +-- Step 2: Parse metadata (existing — area, persona scores, effort)
        +-- Step 3: Parse Prerequisites field (NEW)
        +-- Step 4: Resolve refs to issue numbers (NEW)
        +-- Step 5: Build dependency DAG (NEW)
        +-- Step 6: Detect cycles (NEW)
        +-- Step 7: Topological sort → waves (NEW)
        +-- Step 8: Render backlog table with Prereqs column (MODIFIED)
        +-- Step 9: Render dependency-aware Top 3 (MODIFIED)
        +-- Step 10: Render Safe Implementation Order section (NEW)
```

---

## Prerequisite Parsing

Each GitHub Issue body contains an Overview table with a `Prerequisites` row:

```
| **Prerequisites** | #12, #17 |
```

or

```
| **Prerequisites** | None |
```

The product-analyst agent parses this row using the following rule:

1. Locate the row whose first cell matches `**Prerequisites**` (case-insensitive, with or without bold markers).
2. Extract the value cell.
3. If the value is `None`, `none`, `-`, or empty: the feature has no prerequisites. Set `prereqs = []`.
4. Otherwise: split on `,` and/or whitespace, extract all tokens matching `#\d+`. Each token is a prerequisite issue number. Set `prereqs = [N, ...]`.

**Ref resolution:** A prerequisite `#N` refers to another issue in the full fetched list. If `#N` is not in the fetched list, it is treated as "already satisfied" (the issue is closed or does not exist as a backlog item). This avoids false blocking on features that genuinely have no backlog predecessor.

---

## Dependency DAG Construction

```
ISSUES = {number: {title, area, scores, effort, prereqs}}

NODES = set of all issue numbers
EDGES = {(A, B) : A must exist before B starts}

for each issue in ISSUES:
    for each prereq P in issue.prereqs:
        if P in NODES:
            EDGES.add((P, issue.number))
        # else: prereq is satisfied externally, ignore
```

`OPEN_NODES` = all issue numbers (all fetched issues are open by definition).

An issue is **blocked** if any node in its transitive prerequisite set is in `OPEN_NODES`. Since all fetched issues are open backlog items, an issue is blocked if it has any prerequisite that is also an open backlog item.

---

## Cycle Detection

Run DFS-based cycle detection before topological sort:

```
visited = {}
rec_stack = {}

function has_cycle(node):
    visited[node] = true
    rec_stack[node] = true
    for neighbor in successors(node):   # nodes that depend on `node`... no, walk EDGES where node is source
        if not visited[neighbor]:
            if has_cycle(neighbor): return true
        elif rec_stack[neighbor]: return true
    rec_stack[node] = false
    return false

CYCLES = []
for node in NODES:
    if not visited[node] and has_cycle(node):
        CYCLES.append(node)
```

If `CYCLES` is non-empty, print a warning block before the backlog table:

```
> **Warning: Circular dependency detected in backlog.**
> The following issues form a cycle and cannot be safely ordered:
> #12 -> #17 -> #12
> Review these issues and fix the Prerequisites fields before relying on ordering.
```

Continue rendering the rest of the output with the cycle members marked as `[cycle]` instead of `[blocked]`.

---

## Topological Sort (Kahn's Algorithm)

Compute `WAVES` — groups of features that can start in parallel, in dependency order:

```
in_degree = {node: 0 for node in NODES}
for each edge (A, B) in EDGES:
    in_degree[B] += 1

ready = [node for node in NODES if in_degree[node] == 0]
sort ready by: Total Persona Score descending (highest-value features first within a wave)

WAVES = []
while ready:
    WAVES.append(list(ready))
    next_ready = []
    for node in ready:
        for each edge (node, B):
            in_degree[B] -= 1
            if in_degree[B] == 0:
                next_ready.append(B)
    sort next_ready by Total Persona Score descending
    ready = next_ready
```

Nodes that are part of a detected cycle are excluded from WAVES and reported separately.

---

## Rendering Changes

### Backlog Table (modified)

Add a `Prereqs` column between `Effort` and the end of each row:

```
| # | Issue | {{PERSONA_SCORE_HEADERS}} | Total | Effort | Prereqs |
|---|-------|{{PERSONA_SCORE_SEPARATORS}}|-------|--------|---------|
| 1 | #42 Feature name [blocked] | ... | X/{{MAX_SCORE}} | Low | #12, #17 |
| 2 | #43 Other feature | ... | X/{{MAX_SCORE}} | High | — |
```

- `[blocked]` appended to the issue title cell if the feature has any unmet prerequisite in the backlog.
- `[cycle]` appended instead if the feature is in a detected cycle.
- `—` in `Prereqs` cell if the feature has no prerequisites.

### Recommended Next Sprint — Top 3 (modified)

The selection pool changes: only features with `in_degree == 0` (no unmet prerequisites) are eligible. The rest of the scoring and ranking logic is unchanged.

If fewer than 3 unblocked features exist, show as many as available and explain:

```
Note: Only {N} features are available to start — the remaining features have unmet prerequisites.
```

### Safe Implementation Order (new section)

Append this section after the Top 3 recommendations:

```
---

## Safe Implementation Order

Features grouped by wave. All features in a wave can start in parallel.
Features in wave N must complete before wave N+1 begins.

| Wave | Issue | Title | Prereqs | Score | Effort |
|------|-------|-------|---------|-------|--------|
| 1    | #42   | Feature A | — | 8/10 | Low |
| 1    | #43   | Feature B | — | 7/10 | Medium |
| 2    | #17   | Feature C | #42 | 9/10 | Low |
| 3    | #12   | Feature D | #17 | 6/10 | High |

To implement in this order using batch-implement:
  /batch-implement #42 #43 #17 #12 --deps "#42 -> #17, #17 -> #12"

[If cycles detected:]
Cycle members (cannot be ordered): #N, #M
Fix the Prerequisites fields in these issues before they can be included in a safe order.
```

The `--deps` string in the suggested command is computed from `EDGES` rendered as `"A -> B, C -> D, ..."`.

---

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `templates/commands/product-backlog.md` | Modified | Add Steps 3–10 to the product-analyst instructions; modify table format; add Safe Implementation Order section |
| `.claude/commands/product-backlog.md` | Re-generated | Output of template instantiation — updated by running `/setup` |

No other files change.

---

## Design Decisions

### Why only in `/product-backlog`, not `/update-product-driven-backlog`?

The `Prerequisites` field is already written by the Explore agent during `/update-product-driven-backlog`. Adding dependency analysis there would mix two concerns (discovery and ordering). The backlog viewer is the correct place to analyze and display ordering because it is the read path — it has all issues available simultaneously and can build the full graph.

### Why ASCII table instead of Mermaid?

Claude Code renders Mermaid in some contexts but not reliably in terminal output. An ASCII wave table is universally readable, copy-pasteable, and directly actionable (the `--deps` string at the bottom can be copied directly into `/batch-implement`). Mermaid can be added as an opt-in flag in a follow-up.

### Why treat external prerequisites as satisfied?

If `#12` is listed as a prerequisite but is not in the current open backlog, it is either already closed (done) or exists outside the product-driven backlog (manually created, tracked elsewhere). In both cases, it should not block the dependent feature from being scheduled. This avoids false positives from organic issue management.

### Why sort within a wave by persona score?

Within a single dependency wave, all features are unblocked. Ranking by persona score preserves the existing prioritization logic so high-value features still surface first even in a wave context.
