---
change: batch-implementation-orchestrator
type: design
---

# Design: Batch Implementation Orchestrator

## Architecture Overview

The batch orchestrator is a new command (`/batch-implement`) that sits above the existing `/implement` pipeline. It does not reach into `/implement`'s internals — it drives the pipeline from the outside, the same way a user would, but with coordination logic layered on top.

The key architectural constraint: **do not duplicate pipeline logic**. The existing `/implement` command already handles multi-feature parallel execution (Phases 3a–4e). The batch orchestrator's job is to:

1. Partition features into **waves** based on declared dependencies
2. Execute each wave using the existing `/implement` multi-feature path
3. Track progress and surface it during execution, not just at the end
4. Aggregate results into a batch-level report

This means the batch orchestrator is a **thin coordination layer**, not a new pipeline. It is implemented as a single Markdown command file — the same format as `/implement`.

---

## Input Parsing

### Input format

```
/batch-implement <feature-list> [flags]
```

Feature list formats (same three modes as `/implement`):
- Issue numbers: `#12, #15, #18, #22, #31, #42`
- Area names: `Analytics, UI, Backend` (delegates to `/implement` Phase 1–2 for each area)
- Mixed: `#12, #15, Analytics` — normalize to issue numbers before wave planning

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--deps "<spec>"` | string | (none) | Dependency annotations. Format: `"#B depends-on #A, #C depends-on #A"` — comma-separated pairs |
| `--concurrency N` | integer | 4 | Max parallel developer agents within a wave |
| `--dry-run` | boolean | false | Pass through to `/implement` for every wave. No git/PR/backlog ops. |
| `--preview` | boolean | false | Alias for `--dry-run` |
| `--wave-size N` | integer | (unlimited) | Force max features per wave regardless of dependencies. Useful for manual chunking. |

### Dependency annotation format

```
--deps "#15 depends-on #12, #18 depends-on #12, #31 depends-on #18"
```

- Each pair is `<dependant> depends-on <prerequisite>`
- Multiple pairs are comma-separated
- Issue references use `#N` for GitHub, `PROJ-N` for JIRA
- Circular dependency detection: if a cycle is found, print an error listing the cycle and stop

---

## Wave Planning Algorithm

After parsing the feature list and dependency annotations, the orchestrator builds an execution plan.

### Step 1: Build dependency graph

Nodes = features. Directed edges = `(prerequisite → dependant)` (prerequisite must complete before dependant can start).

### Step 2: Topological sort (Kahn's algorithm)

1. Compute in-degree for each node.
2. Initialize queue with all nodes having in-degree = 0 (no prerequisites).
3. Assign wave numbers: all nodes in the initial queue = Wave 1. After processing Wave 1, nodes whose prerequisites are all in Wave 1 move to Wave 2. Repeat.

The result is a list of waves, each containing features that can run in parallel relative to each other.

### Step 3: Apply concurrency cap

For each wave, if the number of features exceeds `--concurrency N`, split the wave into sub-batches of size N. Sub-batches execute sequentially within the wave, but features within a sub-batch run in parallel.

This prevents overwhelming the environment with too many simultaneous worktrees.

### Step 4: Print execution plan

Before any execution begins, print the full plan:

```
## Batch Execution Plan

Batch: 6 features across 2 waves, concurrency cap: 4

Wave 1 (2 features — run in parallel):
  - #12: Add authentication middleware
  - #22: Add database connection pool

Wave 2 (4 features — max 4 concurrent):
  - #15: Add user profile API  [depends-on #12]
  - #18: Add session management  [depends-on #12]
  - #31: Add analytics dashboard  [depends-on #22]
  - #42: Add rate limiting  [depends-on #22]

Proceed? (y/n)
```

Wait for user confirmation before executing.

---

## Execution Model

### Per-wave execution

For each wave (in order):

1. Collect the feature list for this wave (respecting the concurrency cap sub-batching).
2. Invoke the `/implement` pipeline with those features.
   - The orchestrator passes the feature list as arguments, so `/implement`'s existing multi-feature path handles parallel architect, developer, test-writer, merge, and reviewer phases.
   - Flags (`--dry-run`, `--concurrency`) are forwarded appropriately.
3. Wait for the wave to complete.
4. Update the live progress dashboard.
5. Check for failed features. If any feature failed:
   - Mark all features that directly or transitively depend on the failed feature as `BLOCKED`.
   - Remove blocked features from subsequent waves.
   - Print a warning: `Feature #N failed. Blocking dependents: #M, #P.`
6. If all remaining features in subsequent waves are blocked (because all are dependents of a failed feature), stop early with a clear report.
7. Otherwise, proceed to the next wave.

### Live progress dashboard

After each wave (and after each agent phase within a wave if the environment supports incremental output), print the full batch status table:

```
## Batch Progress

| # | Feature | Wave | Architect | Developer | Tests | Reviewer | Security | CI | Status |
|---|---------|------|-----------|-----------|-------|----------|----------|----|--------|
| #12 | Auth middleware | 1 | done | done | done | done | clean | pass | shipped |
| #22 | DB pool | 1 | done | done | done | done | clean | pass | shipped |
| #15 | User profile API | 2 | running | queued | — | — | — | — | in-progress |
| #18 | Session mgmt | 2 | running | queued | — | — | — | — | in-progress |
| #31 | Analytics dashboard | 2 | queued | queued | — | — | — | — | queued |
| #42 | Rate limiting | 2 | queued | queued | — | — | — | — | queued |

Wave 1: complete. Wave 2: in progress (2/4 active).
```

Status values: `queued`, `in-progress`, `shipped`, `failed`, `blocked`

---

## Failure Isolation Logic

The failure isolation model follows the dependency graph strictly:

- **Independent failure** (feature fails, has no dependents): logged as FAILED. Batch continues for all other features unaffected.
- **Upstream failure** (prerequisite fails, has dependents): all direct and transitive dependents are marked BLOCKED. Non-dependents are unaffected.
- **Wave-level failure** (all features in a wave fail): check whether any features in subsequent waves are non-dependent. If yes, continue. If all remaining features are blocked, stop early.
- **Critical security block**: if the security reviewer for any feature emits `SECURITY_STATUS: BLOCKED`, that feature is FAILED and its dependents are BLOCKED. Other features in the same wave are unaffected.

The orchestrator MUST NOT stop the entire batch because one feature failed, unless every remaining feature is blocked by that failure.

---

## Batch-Level Final Report

After all waves complete (or when the batch terminates early due to cascading failures):

```
## Batch Implementation Report

Batch completed: 2026-03-13 14:32 UTC
Duration: 47 minutes

### Summary

| Metric | Value |
|--------|-------|
| Features requested | 6 |
| Features shipped | 5 |
| Features failed | 1 |
| Features blocked | 0 |
| PRs created | 5 |
| Unresolved merge conflicts | 2 files |
| CI status | 4 passing, 1 pending |

### Per-Feature Results

| # | Feature | Status | PR | CI | Notes |
|---|---------|--------|----|----|-------|
| #12 | Auth middleware | shipped | #201 | pass | — |
| #22 | DB pool | shipped | #202 | pass | — |
| #15 | User profile API | shipped | #203 | pass | — |
| #18 | Session mgmt | failed | — | — | Developer agent timed out |
| #31 | Analytics dashboard | shipped | #204 | pending | CI still running |
| #42 | Rate limiting | shipped | #205 | pass | 2 merge conflicts resolved manually |

### Merge Conflicts Requiring Resolution

| File | Features | Conflict Region |
|------|----------|----------------|
| templates/commands/implement.md | #15, #42 | ## Phase 4e |

### Next Steps

- Retry failed features: `/implement #18`
- Resolve merge conflicts in: `templates/commands/implement.md`
- Review pending CI for PR #204
```

---

## Relationship to `/implement`

The batch orchestrator calls into `/implement` as its execution engine for each wave. The contract is:

- Batch orchestrator: feature partitioning, dependency graph, wave scheduling, concurrency cap, failure isolation, batch report
- `/implement`: architect → developer → test-writer → merge → reviewer → security → ship for each wave's feature set

This means:
- The batch orchestrator does NOT re-implement any pipeline phase
- All existing `/implement` flags work as-before for 1–4 features
- The batch orchestrator is additive — removing it leaves `/implement` fully functional

---

## Design Decisions

### Why a separate command rather than a `--batch` flag on `/implement`?

A separate command (`/batch-implement`) keeps the entry points clean and avoids making `/implement`'s already-complex flag parsing even more complex. The batch use case has a distinct mental model (planning-first, wave execution, dependency graph) that is better expressed as its own command. The inspiration from Turborepo and GitHub Actions matrices aligns with a dedicated "higher-level" command.

Additionally, `--batch` on `/implement` would require `/implement` to know about wave planning and dependency graphs — concepts it currently does not need.

### Why Kahn's algorithm for topological sort?

Kahn's algorithm gives wave numbers naturally (all zero-in-degree nodes go in Wave 1, then their successors, etc.) — exactly the batching structure we want. It also makes cycle detection trivial: if the queue empties before all nodes are processed, a cycle exists.

### Why is the concurrency cap at the developer-agent level, not the architect level?

Architect agents are lightweight and fast (they produce Markdown, not code). The bottleneck is developer agents, which are long-running and memory-intensive. Capping concurrency at the developer phase (which `/implement`'s Phase 3b already controls) is the right level. The batch orchestrator passes `--concurrency N` through to `/implement`, which applies it during Phase 3b.

### Why is dependency declaration explicit rather than inferred?

Automatic dependency inference would require static analysis of each feature's context-bundle.md to detect API/type dependencies — which is inherently imprecise for a pre-code project. Explicit declaration is reliable, understandable, and auditable. It follows the same philosophy as `Makefile` targets: the engineer declares what depends on what; the tool respects the declaration.

### Why is the progress dashboard printed after each wave (not in real-time)?

Claude Code background agents are not streaming — they complete and return output. Real-time per-phase updates would require polling agent state, which is fragile. The pragmatic approach: print the dashboard after each wave's agents complete (which is when new information is available). For large waves, this means one dashboard update per wave. This is consistent with how existing pipeline reports work.

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Zero dependencies declared | All features go in Wave 1; standard `/implement` multi-feature path |
| All features depend on one feature and it fails | Entire batch stops after Wave 1; report shows all as BLOCKED |
| Circular dependency declared | Detected at plan time (before execution). Print the cycle, stop. |
| `--wave-size N` splits a dependency group | Not allowed. If Feature A must precede Feature B, they cannot be in the same forced wave if the user's wave-size would group them. Print a warning if wave-size conflicts with declared deps. |
| Feature appears in `--deps` but not in feature list | Print error: "Feature #N referenced in --deps is not in the feature list." Stop. |
| A wave has 1 feature (due to dependency constraints) | That single feature runs through `/implement` in SINGLE_MODE (no worktrees needed) |
| Dry-run mode | All waves run with `--dry-run` passed through. No git/PR/backlog ops. Cache directories are written per-feature as normal. Batch report shows what would have been shipped. |
| Area names in feature list (no issue numbers) | Phase 1–2 of `/implement` runs to explore and select; result is a set of issue-like items. Wave planning proceeds once issues are resolved. |
