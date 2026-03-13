---
change: batch-implementation-orchestrator
type: feature
status: shipped
github_issue: 8
vpc_fit: 80%
---

# Proposal: Batch Implementation Orchestrator

## Problem

The `/implement` command already handles multi-feature parallel execution well — it runs architect agents in parallel, spawns developer agents in isolated worktrees, applies smart merge conflict resolution, and ships with a single reviewer pass. For 2–4 features, this works smoothly.

The friction emerges at scale. When a product lead wants to drive 5, 8, or 10 features in parallel, three gaps become painful:

**1. No progress visibility across a large batch.**
The current pipeline runs as a single conversation turn. With 8+ background agents active simultaneously, the user has no way to know which features are at which phase. The Phase 4e table is shown only at the very end — if an early architect fails, the user finds out after waiting for all 10 developers to finish.

**2. No feature dependency ordering.**
Some features are prerequisite to others. Feature B may depend on data structures or APIs that Feature A introduces. The current pipeline treats all features as fully independent. Running them in parallel with no dependency awareness can produce broken builds when the reviewer sees Feature B using APIs that do not yet exist in `main`.

**3. No queue management for large batches (>5 features).**
Launching 10 developer agents in parallel against 10 worktrees saturates Claude's parallelism budget, strains the machine's RAM, and makes debugging difficult. There is no mechanism to say "implement these 10 features, but run at most 4 in parallel, respecting dependencies."

**4. No batch-level reporting.**
When running `/implement #12, #15, #18, #22, #31, #42` the final report shows 6 rows in a table. There is no higher-level view: which phases succeeded across the batch, what the total wall-clock time was, which features are blocked pending conflict resolution.

These gaps mean product leads with a large backlog must manually chunk their work, run multiple `/implement` commands in sequence, and mentally track progress — defeating the purpose of an orchestrated pipeline.

## Solution

Introduce a `/batch-implement` command that acts as a **macro-orchestrator** on top of the existing `/implement` pipeline logic. It does not duplicate pipeline logic — it adds the coordination layer that `/implement` lacks for large-scale operations:

1. **Dependency graph**: Accept optional `--deps` annotations (e.g., `#15 depends-on #12`) and derive a topologically sorted execution plan.
2. **Wave-based execution**: Group features into waves. Within a wave, features run in parallel via the existing `/implement` multi-feature path. Waves run sequentially, so Wave 2 features can build on Wave 1 output.
3. **Concurrency cap**: Accept `--concurrency N` (default: 4) to limit parallel developer agents per wave. Features beyond the cap are queued and launched as prior features complete.
4. **Live progress dashboard**: Print a live status table that refreshes after each feature completes an agent phase, not just at the end.
5. **Batch-level report**: After all waves complete, emit a consolidated report: per-feature status, total PR count, unresolved conflicts, CI summary.
6. **Failure isolation**: A failed feature in Wave 1 does not block Wave 2 features that do not depend on it. Only direct dependents are held.

## Scope

**In scope:**
- New command: `commands/batch-implement.md` (template) and `.claude/commands/batch-implement.md` (generated)
- New template: `templates/commands/batch-implement.md`
- Dependency graph parsing and topological sort (inline orchestrator logic)
- Wave-based execution model with configurable concurrency cap
- Live progress dashboard printed after each agent phase completes
- Batch-level final report
- Failure isolation: failed features block dependents only, not the full batch
- `openspec/specs/batch-implement.md` — normative spec for the new command
- `openspec/specs/implement.md` — minor addendum: document that batch mode is the recommended entry point for 5+ features

**Out of scope:**
- Changes to the existing `/implement` command internals (batch-implement calls into it, not around it)
- New agent types (all existing agents are reused)
- A graphical dashboard (text-based table only)
- Automatic dependency inference (dependencies must be declared; no static analysis)
- Cross-repo orchestration

## Non-goals

- This command does NOT replace `/implement` for 1–4 features. It is an explicit opt-in for large batches.
- This command does NOT change how individual features are implemented. Each feature still goes through the full architect → developer → test-writer → reviewer → ship pipeline.
- This command does NOT guarantee zero merge conflicts. Dependency ordering reduces conflicts; it does not eliminate them.

## Acceptance Criteria

1. `/batch-implement #12, #15, #18 --deps "#15 depends-on #12"` parses the dependency annotation and executes #12 first (Wave 1), then #15 and #18 in parallel (Wave 2).
2. `--concurrency 3` limits parallel developer agents to 3 at a time within a wave. Features 4+ in the same wave are queued and launched as slots open.
3. After each agent phase completes for any feature, the progress dashboard updates and prints the current state of all features.
4. A feature failure in Wave 1 blocks its direct dependents in Wave 2 but allows non-dependent Wave 2 features to proceed.
5. The final batch report shows: per-feature row (phases completed, PR URL, CI status), batch totals (N features completed, N PRs created, N conflicts requiring resolution).
6. The command is present in both `templates/commands/batch-implement.md` and `.claude/commands/batch-implement.md`.
7. A normative spec exists at `openspec/specs/batch-implement.md`.
8. `/implement` behavior is entirely unchanged. All existing `/implement` tests and use cases continue to work.

## Motivation

VPC fit score: 80%. Alex (Lead Dev) explicitly stated the desire to implement 5+ features without managing multiple `/implement` invocations. The wave model maps directly to how experienced leads think about a feature backlog: "first implement the foundation, then the features that build on it, then the UX polish on top." This is the same mental model as `make -j`, Turborepo, and GitHub Actions matrices — tools Alex already uses. The solution mirrors familiar patterns and layers them on top of the pipeline Alex already trusts.
