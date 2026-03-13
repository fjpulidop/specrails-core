---
change: batch-implementation-orchestrator
type: delta-spec
---

# Delta Spec: Batch Implementation Orchestrator

This document describes the normative changes to the spec layer required by this feature. It uses SHALL/MUST/SHOULD language.

---

## New Spec: `openspec/specs/batch-implement.md`

Create this file. It documents the `/batch-implement` command's flags, execution model, and behavior matrix.

---

### Flags

#### `--deps "<spec>"`

Declares feature dependencies. The spec string MUST be a comma-separated list of `"<dependant> depends-on <prerequisite>"` pairs.

- Each dependant and prerequisite MUST be a valid feature reference present in the feature list argument.
- If a feature referenced in `--deps` is not in the feature list, the command MUST stop with an error before executing any phase.
- Circular dependency cycles MUST be detected before execution begins. If a cycle is detected, the command MUST print the cycle and stop.

#### `--concurrency N`

Sets the maximum number of parallel developer agents within a wave. MUST be a positive integer. Default: 4.

The concurrency cap applies at the developer-agent launch phase (equivalent to `/implement` Phase 3b). Architect agents within a wave are not subject to the concurrency cap and SHALL run in parallel for all features in the wave simultaneously.

#### `--wave-size N`

Forces a maximum number of features per wave regardless of dependency structure. When `--wave-size` and `--deps` are both present, the command MUST validate that wave-size partitioning does not separate a prerequisite from any features in an earlier wave. If a conflict is detected, the command MUST print a warning describing the conflict and MUST honor the dependency ordering over the wave-size constraint.

#### `--dry-run` / `--preview`

Passes through to every wave's `/implement` invocation. No git, PR, or backlog operations run for any wave. Aliases; behavior is identical.

---

### Execution Model

#### Wave Planning

The command SHALL derive a wave plan before executing any wave:

1. Build a directed dependency graph from the feature list and `--deps` annotations. Nodes = features; directed edges = prerequisite → dependant.
2. Apply topological sort (Kahn's algorithm) to assign wave numbers. All features with no prerequisites are in Wave 1. Features whose prerequisites are all in Wave K are in Wave K+1.
3. Apply the concurrency cap to each wave: if a wave contains more features than `--concurrency N`, partition it into sequential sub-batches of size N.
4. Print the full execution plan and wait for user confirmation before executing.

The wave plan MUST be deterministic. Ties in topological sort order SHALL be broken alphabetically by feature identifier.

#### Wave Execution

For each wave (in topological order):

1. The command SHALL invoke the `/implement` pipeline with the wave's feature list.
2. The command SHALL wait for the wave to complete before starting the next wave.
3. After each wave completes, the command SHALL print an updated progress dashboard.

The command SHALL NOT execute waves in parallel. Wave sequencing is the mechanism by which dependency ordering is enforced.

#### Failure Isolation

When a feature fails:

1. The command MUST mark all direct and transitive dependants of the failed feature as BLOCKED.
2. The command MUST NOT mark non-dependent features as BLOCKED or FAILED.
3. The command SHALL continue executing non-blocked waves.
4. If all remaining features across all remaining waves are BLOCKED, the command SHALL stop early and emit the batch report.

A feature is FAILED if its `/implement` invocation returns a failure status for any phase. A feature is BLOCKED if any of its declared prerequisites are FAILED.

---

### Progress Dashboard

After each wave completes, the command SHALL print a progress dashboard table. The table MUST contain one row per feature and the following columns:

| Column | Content |
|--------|---------|
| Feature | Issue number and title |
| Wave | Wave number |
| Architect | `done`, `failed`, `queued`, or `—` |
| Developer | `done`, `failed`, `running`, `queued`, or `—` |
| Tests | `done`, `failed`, `skipped`, `queued`, or `—` |
| Reviewer | `done`, `failed`, `queued`, or `—` |
| Security | `clean`, `warnings`, `blocked`, `queued`, or `—` |
| CI | `pass`, `fail`, `pending`, `—` |
| Status | `shipped`, `failed`, `blocked`, `in-progress`, `queued` |

The dashboard MUST be reprinted (not appended) after each wave. It represents the full current state of the batch.

---

### Batch Report

After all waves complete (or when the batch terminates early), the command SHALL emit a batch report containing:

1. **Summary table**: features requested, features shipped, features failed, features blocked, PRs created, unresolved merge conflicts count, CI status summary.
2. **Per-feature results table**: one row per feature with status, PR URL (if created), CI status, and notes.
3. **Merge conflicts requiring resolution**: any files with unresolved conflict markers, showing which features contributed to the conflict.
4. **Next steps**: suggested commands to retry failed features or resolve conflicts.

---

### Behavior Matrix

| Scenario | Wave Planning | Execution | Report |
|----------|--------------|-----------|--------|
| No `--deps` | All features in Wave 1 | Standard `/implement` multi-feature path | Batch report (single wave) |
| `--deps` with no cycles | Multiple waves | Sequential wave execution | Batch report (multi-wave) |
| `--deps` with cycle detected | Stop at plan time | No execution | Error message with cycle |
| `--dry-run` | Normal | All waves use `--dry-run` | Batch dry-run report |
| A feature fails (has no dependents) | Normal | Batch continues | Feature marked FAILED in report |
| A feature fails (has dependents) | Normal | Dependents marked BLOCKED | Failed + blocked features in report |
| All remaining features blocked | Normal | Batch stops early | Report shows reason |

---

## Changes to `openspec/specs/implement.md`

### Add: Recommendation note in introduction

After the existing introductory paragraph, insert:

> **For batches of 5+ features**, consider using `/batch-implement` instead. It adds dependency ordering, concurrency caps, and a batch-level progress dashboard on top of this pipeline.

This is an informational note, not a normative change. No SHALL/MUST language is added to this note.
