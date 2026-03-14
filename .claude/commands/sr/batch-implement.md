# Batch Implementation Orchestrator

Macro-orchestrator above `/sr:implement`. Accepts a set of feature references, computes a dependency-aware wave execution plan, invokes `/sr:implement` per wave, and produces a batch-level progress dashboard and final report. All per-feature pipeline work (architect, developer, reviewer, git, CI) is fully delegated to `/sr:implement`.

**MANDATORY: Always follow this pipeline exactly as written. NEVER skip, shortcut, or "optimize away" any phase — even if the batch seems small enough to handle directly. The orchestrator MUST compute waves, confirm with the user, and invoke `/sr:implement` per wave as specified. Do NOT implement any feature yourself in the main conversation. No exceptions.**

**Input:** $ARGUMENTS — one or more feature references with optional flags:

- **Feature refs**: `#85 #71 #63` (GitHub issue numbers) — required, at least two
- **`--deps "<spec>"`**: inline dependency spec, e.g. `"#71 -> #85, #63 -> #85"` (meaning #71 and #63 must complete before #85)
- **`--concurrency N`**: max features running in parallel across waves (default: 3)
- **`--wave-size N`**: max features per wave regardless of concurrency (default: unlimited)
- **`--dry-run` / `--preview`**: passed through to each `/sr:implement` invocation; no git or backlog operations will run

**IMPORTANT:** Before running, ensure Read/Write/Bash/Glob/Grep permissions are set to "allow" — background agents cannot request permissions interactively.

---

## Phase 0: Parse Input

### Step 1: Extract feature refs

Scan `$ARGUMENTS` for issue/ticket references (e.g. `#85`, `#71`). Collect into `FEATURE_REFS` list. If fewer than 2 refs are found, stop and print:

```
[batch-implement] Error: at least 2 feature refs are required. For a single feature, use /sr:implement directly.
```

### Step 2: Extract flags

Scan `$ARGUMENTS` for control flags:

- If `--dry-run` or `--preview` is present: set `DRY_RUN=true`. This flag is forwarded to every `/sr:implement` call.
- If `--deps "<spec>"` is present: capture the quoted string as `DEPS_SPEC`. Strip from arguments.
- If `--concurrency N` is present: set `CONCURRENCY=N` (integer ≥ 1). Default: 3.
- If `--wave-size N` is present: set `WAVE_SIZE=N` (integer ≥ 1). Default: unlimited (no per-wave cap).

**If `DRY_RUN=true`**, print:
```
[dry-run] Preview mode active — /sr:implement will be called with --dry-run for each wave.
```

### Step 3: Fetch issue titles

For each ref in `FEATURE_REFS`, fetch the issue title to use in progress output:

```bash
gh issue view {number} --json number,title
```

Store as `FEATURE_TITLES` map: `{ref: title}`.

---

## Phase 1: Wave Planning

### Step 1: Parse dependency graph

Build a directed graph `DEP_GRAPH` where an edge `A -> B` means "A must complete before B starts".

Parse `DEPS_SPEC` (if provided) by splitting on `,` and parsing each token as `<ref> -> <ref>`.

```
for each token in DEPS_SPEC.split(","):
    left, right = token.split("->")
    DEP_GRAPH.add_edge(left.strip(), right.strip())
```

All refs in `FEATURE_REFS` that appear in no edge are treated as independent (no dependencies).

### Step 2: Detect circular dependencies

Run cycle detection on `DEP_GRAPH`:

```
visited = {}
rec_stack = {}

function has_cycle(node):
    visited[node] = true
    rec_stack[node] = true
    for neighbor in DEP_GRAPH.neighbors(node):
        if not visited[neighbor] and has_cycle(neighbor):
            return true
        elif rec_stack[neighbor]:
            return true
    rec_stack[node] = false
    return false

CYCLES = [node for node in FEATURE_REFS if not visited[node] and has_cycle(node)]
```

If `CYCLES` is non-empty: stop and print:

```
[batch-implement] Error: circular dependency detected.
Cycle involves: <ref-list>
Fix the --deps spec and re-run.
```

### Step 3: Compute waves via Kahn's algorithm

```
in_degree = {ref: 0 for ref in FEATURE_REFS}
for each edge (A -> B) in DEP_GRAPH:
    in_degree[B] += 1

WAVES = []
ready = [ref for ref in FEATURE_REFS if in_degree[ref] == 0]
sort ready alphabetically (stable ordering)

while ready is non-empty:
    wave = ready[:WAVE_SIZE]  # cap at WAVE_SIZE if set; else take all
    remaining = ready[WAVE_SIZE:] if WAVE_SIZE else []
    WAVES.append(wave)
    for ref in wave:
        for neighbor in DEP_GRAPH.neighbors(ref):
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                remaining.append(neighbor)
    sort remaining alphabetically
    ready = remaining
```

Set `TOTAL_WAVES = len(WAVES)`.

### Step 4: Print execution plan and ask for confirmation

Print the wave execution plan:

```
## Batch Execution Plan

Total features : <N>
Total waves    : <TOTAL_WAVES>
Max concurrency: <CONCURRENCY>
Dry-run        : <yes / no>

| Wave | Features | Depends On |
|------|----------|------------|
| 1    | #85, #71 | —          |
| 2    | #63      | #85, #71   |

Dependency graph:
  #71 -> #63
  #85 -> #63

Proceed? (yes / no / edit-deps)
```

Wait for user confirmation.

- **`yes`**: proceed to Phase 2.
- **`no`**: stop. Print `[batch-implement] Aborted by user.`
- **`edit-deps`**: ask the user to provide a corrected `--deps` spec, re-run Phase 1 from Step 1.

---

## Phase 2: Wave Execution Loop

Execute waves sequentially. Within each wave, invoke `/sr:implement` for all features in parallel (up to `CONCURRENCY` at a time).

### Progress Dashboard

Before starting each wave, print the current dashboard state:

```
## Batch Progress

| # | Feature | Title | Wave | Status | Notes |
|---|---------|-------|------|--------|-------|
| 1 | #85     | <title> | 1  | done   |       |
| 2 | #71     | <title> | 1  | done   |       |
| 3 | #63     | <title> | 2  | running|       |
| 4 | #42     | <title> | 2  | blocked| depends on #63 |
| 5 | #17     | <title> | 3  | pending|       |
```

Status values:
- `pending` — not yet started
- `running` — `/sr:implement` invocation is active
- `done` — `/sr:implement` completed successfully
- `failed` — `/sr:implement` exited with an error
- `blocked` — a dependency failed; this feature will not run

### Wave invocation

For each wave `W`:

1. Print: `[wave W/TOTAL_WAVES] Starting — features: <ref-list>`
2. For each feature batch of size ≤ `CONCURRENCY` within the wave:
   - Invoke `/sr:implement` with the feature refs and forwarded flags:
     ```
     /sr:implement <ref1> <ref2> ... [--dry-run]
     ```
   - Run invocations in the batch in parallel (`run_in_background: true`).
   - Wait for all in the batch to complete before starting the next batch.
3. For each completed invocation, record outcome in `WAVE_RESULTS`:
   - `{ref, wave, status: "done" | "failed", error_summary: "..." | null}`

### Failure isolation

After each wave completes:

```
FAILED_THIS_WAVE = [ref for ref in wave if WAVE_RESULTS[ref].status == "failed"]

for each ref in FAILED_THIS_WAVE:
    BLOCKED = all refs in DEP_GRAPH.descendants(ref)
    for each blocked_ref in BLOCKED:
        WAVE_RESULTS[blocked_ref] = {status: "blocked", reason: "depends on failed " + ref}
        remove blocked_ref from all future waves
```

A failed feature blocks ONLY its transitive dependents. Features in other branches of the dependency graph continue unaffected.

Print updated dashboard after each wave.

### Wave completion gate

Before starting wave W+1, confirm all features in wave W have status `done` or `blocked`. Never start a downstream wave while upstream features are still running.

---

## Phase 3: Batch Report

After all waves complete (or all remaining features are blocked), print the final batch report.

```
## Batch Implementation Report

Run completed: <ISO 8601 timestamp>
Dry-run: <yes / no>

### Summary

| Metric | Count |
|--------|-------|
| Total features | N |
| Succeeded | N |
| Failed | N |
| Blocked (dep failure) | N |

### Per-Feature Results

| # | Feature | Title | Wave | Status | Notes |
|---|---------|-------|------|--------|-------|
| 1 | #85     | <title> | 1  | done   |       |
| 2 | #71     | <title> | 1  | failed | see /sr:implement output |
| 3 | #63     | <title> | 2  | blocked| depends on #71 |

### Merge Conflicts

[List any merge conflicts reported by /sr:implement across all waves. If none: "No merge conflicts detected."]

| Feature | File | Conflicting Region |
|---------|------|--------------------|
| #85     | src/utils/parser.ts | function parseQuery |

### Next Steps

[If all features succeeded:]
All features implemented. Review open PRs and monitor CI.

[If any features failed:]
Re-run failed features individually:
  /sr:implement <failed-ref>
  /sr:implement <failed-ref>

[If any features were blocked:]
Once failed features are fixed, re-run blocked features:
  /sr:implement <blocked-ref> [--deps "..."]
```

---

## Error Handling

- If an `/sr:implement` invocation fails: record failure, apply failure isolation, continue remaining waves
- If GitHub CLI is unavailable (detected during issue title fetch): proceed without titles, show refs only
- If `--deps` spec contains unknown refs: warn and continue — unknown refs are ignored in graph construction
- Never block the entire batch on a single feature failure. Always produce a final report.
