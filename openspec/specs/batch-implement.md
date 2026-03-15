# Spec: /sr:batch-implement Command

The `/sr:batch-implement` command is a macro-orchestrator above `/sr:implement`. It accepts a set of feature references, computes a dependency-aware wave execution plan using topological sort, and delegates per-feature implementation to `/sr:implement` one wave at a time. It adds dependency ordering, concurrency caps, and a batch-level progress dashboard on top of the single-feature pipeline.

---

## Flags

### Feature refs (required)

**Type:** one or more GitHub issue numbers (e.g. `#85 #71 #63`)
**Default:** none — at least two refs MUST be provided

The command MUST reject invocations with fewer than 2 feature refs and print:
```
[batch-implement] Error: at least 2 feature refs are required. For a single feature, use /sr:implement directly.
```

### `--deps "<spec>"`

**Type:** quoted string
**Default:** none (no dependencies — all features are treated as independent)

Inline dependency specification. The spec is a comma-separated list of directed edges in the form `<ref> -> <ref>`. Each edge means the left ref MUST complete before the right ref starts.

Example: `"#71 -> #85, #63 -> #85"` means both #71 and #63 must complete before #85 starts.

Refs that appear in `FEATURE_REFS` but in no edge are treated as independent.

Refs in `--deps` that do NOT appear in `FEATURE_REFS` SHOULD produce a warning and MUST be ignored in graph construction — they do not cause the command to stop.

### `--concurrency N`

**Type:** positive integer
**Default:** 3

Maximum number of `/sr:implement` invocations that may run in parallel at any one time, across the features within a wave. The command MUST NOT launch more than `CONCURRENCY` parallel invocations simultaneously.

### `--wave-size N`

**Type:** positive integer
**Default:** unlimited

Maximum number of features permitted in a single wave, regardless of dependency structure. When set, Kahn's algorithm MUST cap each wave at `N` features; overflow features roll into the next wave in alphabetical order.

### `--dry-run` / `--preview`

**Type:** boolean flag
**Default:** false

When present, the flag MUST be forwarded to every `/sr:implement` invocation. No git, PR, or backlog operations will run in any wave. Both flags are equivalent aliases.

The command MUST print at startup:
```
[dry-run] Preview mode active — /sr:implement will be called with --dry-run for each wave.
```

---

## Dependency Annotation Format

Dependencies are expressed as a comma-separated list of `->` edges in the `--deps` argument:

```
--deps "<ref> -> <ref>, <ref> -> <ref>"
```

- Whitespace around `->` and `,` is ignored.
- Multiple edges to the same target are permitted: `"#71 -> #85, #63 -> #85"`.
- Self-edges (`#85 -> #85`) MUST be treated as a circular dependency and cause the command to stop.
- Edges referencing refs not in `FEATURE_REFS` MUST be warned about and ignored.

---

## Wave Planning Algorithm

The wave planning algorithm is normative. Implementations MUST produce identical wave assignments for identical inputs.

### Step 1: Build dependency graph

Construct a directed graph `DEP_GRAPH` from `--deps` edges. Each node is a feature ref. Each edge `A -> B` means A is a prerequisite of B.

### Step 2: Cycle detection

Before computing waves, the implementation MUST perform a depth-first cycle detection pass over `DEP_GRAPH`. If any cycle is found, the command MUST stop and print the cycle members. The command MUST NOT proceed to wave computation.

### Step 3: Kahn's algorithm

```
in_degree[ref] = number of incoming edges for each ref
ready = all refs with in_degree == 0, sorted alphabetically

while ready is non-empty:
    wave = ready[0:WAVE_SIZE]   (all of ready if WAVE_SIZE is unset)
    overflow = ready[WAVE_SIZE:] (empty if WAVE_SIZE is unset)
    emit wave
    for each ref in wave:
        decrement in_degree for each neighbor of ref
        if in_degree[neighbor] == 0: add neighbor to overflow
    sort overflow alphabetically
    ready = overflow
```

Refs with no dependencies are always placed in wave 1 (or an early wave if `--wave-size` caps it). Alphabetical sort is used as the stable tiebreaker at every step.

### Step 4: User confirmation

Before executing any wave, the implementation MUST print the full execution plan (all waves, features per wave, dependency edges) and MUST wait for user confirmation. The user MAY respond:

- `yes` — proceed
- `no` — abort; print `[batch-implement] Aborted by user.`
- `edit-deps` — accept a corrected `--deps` spec and re-run wave planning from Step 1

---

## Failure Isolation Rules

These rules are normative and MUST be followed exactly.

1. A failed feature MUST NOT block features that are not its transitive dependents.
2. A failed feature MUST block all of its transitive dependents (direct and indirect).
3. Features in parallel branches of the dependency graph MUST continue executing regardless of a failure in another branch.
4. After each wave, the implementation MUST compute `BLOCKED` = all transitive descendants of every failed feature in that wave, and MUST remove those refs from all future wave lists.
5. A blocked feature MUST be recorded with `status: "blocked"` and a reason string identifying which upstream feature caused the block.
6. Blocking MUST be applied after the wave completes, not mid-wave. Features already running in a wave MUST be allowed to complete.
7. A blocked feature MUST NOT be re-queued automatically. The user MUST re-run it manually after fixing the upstream failure.

---

## Progress Dashboard

The dashboard MUST be printed before each wave starts and after each wave completes.

### Required columns

| Column | Description |
|--------|-------------|
| `#` | Sequential index (1-based) across all features |
| `Feature` | Issue ref (e.g. `#85`) |
| `Title` | Issue title fetched in Phase 0 Step 3; empty if unavailable |
| `Wave` | Wave number this feature is assigned to |
| `Status` | One of: `pending`, `running`, `done`, `failed`, `blocked` |
| `Notes` | Free text; MUST include upstream failure ref for `blocked` features |

### Status lifecycle

```
pending -> running -> done
                   -> failed
pending -> blocked  (if upstream fails before this feature starts)
```

A feature MUST NOT transition from `done` or `failed` to any other status.

---

## Batch Report Required Sections

The final batch report MUST contain all of the following sections, in this order:

1. **Run metadata** — timestamp, dry-run flag value
2. **Summary table** — total features, succeeded, failed, blocked
3. **Per-Feature Results** — one row per feature with all dashboard columns
4. **Merge Conflicts** — aggregated from all `/sr:implement` outputs; MUST be present even if empty (print "No merge conflicts detected.")
5. **Next Steps** — conditional on outcome:
   - All succeeded: prompt to review PRs and monitor CI
   - Any failed: per-feature re-run commands
   - Any blocked: re-run commands noting dependency context

---

## Behavior Matrix

| Flag combination | Min refs | Wave planning | User confirmation | `/sr:implement` flags forwarded | Git/PR/Backlog |
|-----------------|----------|---------------|-------------------|------------------------------|----------------|
| (none) | 2 | Yes | Yes | none | Per `/sr:implement` config |
| `--dry-run` | 2 | Yes | Yes | `--dry-run` | No |
| `--preview` | 2 | Yes | Yes | `--preview` | No |
| `--concurrency N` | 2 | Yes | Yes | none | Per `/sr:implement` config |
| `--wave-size N` | 2 | Yes (capped) | Yes | none | Per `/sr:implement` config |
| `--deps "<spec>"` | 2 | Yes (with edges) | Yes | none | Per `/sr:implement` config |
| Any + `--dry-run` | 2 | Yes | Yes | `--dry-run` | No |

---

## Variable Reference

Variables set during Phase 0 and used throughout execution:

| Variable | Type | Set when | Description |
|----------|------|----------|-------------|
| `FEATURE_REFS` | list | Phase 0 Step 1 | Ordered list of all feature refs from `$ARGUMENTS` |
| `FEATURE_TITLES` | map | Phase 0 Step 3 | `{ref: title}` for dashboard display |
| `DRY_RUN` | boolean | Phase 0 Step 2 | True when `--dry-run` or `--preview` present |
| `CONCURRENCY` | integer | Phase 0 Step 2 | Max parallel `/sr:implement` invocations; default 3 |
| `WAVE_SIZE` | integer\|null | Phase 0 Step 2 | Max features per wave; null if unset |
| `DEPS_SPEC` | string\|null | Phase 0 Step 2 | Raw `--deps` value; null if not provided |
| `DEP_GRAPH` | graph | Phase 1 Step 1 | Directed graph of dependency edges |
| `WAVES` | list\<list\> | Phase 1 Step 3 | Ordered list of waves, each a list of refs |
| `TOTAL_WAVES` | integer | Phase 1 Step 3 | `len(WAVES)` |
| `WAVE_RESULTS` | map | Phase 2 | `{ref: {wave, status, error_summary}}` for all features |

---

## Edge Cases

- **No dependencies provided**: all features are independent; the command MUST place all features in a single wave (subject to `--wave-size` cap) and run them in parallel up to `CONCURRENCY`.
- **All features in one wave**: no wave sequencing is required. The command MUST still print the plan and await confirmation.
- **CONCURRENCY=1**: all features run serially. Wave structure is preserved; features within a wave run one at a time.
- **`--wave-size 1`**: each feature gets its own wave. Equivalent to fully sequential execution.
- **GitHub CLI unavailable**: title fetch fails; the command MUST proceed using refs only (no titles in dashboard). MUST NOT stop.
- **`/sr:implement` timeout**: treat as `failed`; apply failure isolation. Log `[wave N] Timeout: <ref>` in the Notes column.
- **All features blocked**: if every remaining feature becomes blocked (all roots failed), the command MUST skip remaining waves and proceed directly to Phase 3 (Batch Report).

---

### Requirement: Command namespace
The `/batch-implement` command SHALL be invoked as `/sr:batch-implement`. The command file SHALL be located at `.claude/commands/sr/batch-implement.md`.

#### Scenario: Command invocation
- **WHEN** user types `/sr:batch-implement #85, #71, #63`
- **THEN** the batch pipeline runs identically to the former `/batch-implement #85, #71, #63`

### Requirement: Implement delegation
All delegated invocations SHALL reference `/sr:implement` instead of `/implement`.

#### Scenario: Per-feature delegation
- **WHEN** batch-implement delegates a feature to the implement pipeline
- **THEN** it invokes `/sr:implement` with the appropriate flags

#### Scenario: Error message for single feature
- **WHEN** user provides fewer than 2 feature refs
- **THEN** error message reads: `For a single feature, use /sr:implement directly.`

#### Scenario: Dry-run message
- **WHEN** `--dry-run` flag is present
- **THEN** startup message reads: `/sr:implement will be called with --dry-run for each wave.`
