---
change: smart-merge-conflict-resolver
type: feature
status: proposed
github_issue: 3
vpc_fit: 75%
---

# Proposal: Smart Merge Conflict Resolver

## Problem

The `/implement` pipeline supports parallel multi-feature implementation via git worktrees. Each feature gets an isolated worktree where a developer agent works uninterrupted. At Phase 4a, the pipeline merges all worktrees back into the main repo working tree.

The current merge logic in Phase 4a is a stub: it says "copy feature-specific files, merge shared files manually, clean up worktrees." The word "manually" is load-bearing — there is no actual merge strategy specified. When two features touch the same file (e.g., `templates/commands/implement.md`), the pipeline produces undefined behavior: the last feature's copy silently wins, or the orchestrator is left with no guidance on how to combine them.

For a Lead Dev running 5+ features in parallel, this is a serious reliability failure. The benefit of parallel implementation evaporates if Phase 4a requires hours of manual conflict resolution. Worse, silent last-writer-wins overwrites mean the problem is not even surfaced — the pipeline reports success while losing one feature's changes.

The symptoms:
- **Silent overwrites**: shared file modifications from earlier-merged features are replaced by later ones, with no warning.
- **No pre-flight awareness**: the orchestrator learns about shared files only at merge time, after all developer agents have finished.
- **No merge strategy**: the pipeline provides no guidance on how to combine non-conflicting changes in the same file (e.g., two features each appending a different section).
- **No ordered execution option**: there is no mechanism to serialize developer agents on shared files when full parallelism would cause irreconcilable conflicts.

## Solution

Enhance Phase 3a.1 (shared file identification, already exists as a stub) and Phase 4a (merge) with a practical, heuristic-based Smart Merge Conflict Resolver:

**Phase 3a.1 — Shared File Analysis (pre-flight):**
Scan all `tasks.md` files extracted from architect output. For each file referenced in multiple tasks.md files, classify it by merge risk: `low` (append-only sections), `medium` (structural edits to distinct regions), `high` (overlapping edits to the same region). Emit a pre-flight report and, for `high`-risk shared files, propose a serialization strategy: one feature runs first, its output becomes the base for the next.

**Phase 4a — Smart Merge:**
Replace the stub with a concrete, ordered merge algorithm:
1. Process features in merge order (serialized sequence for `high`-risk shared files, any order for exclusive files).
2. For each shared file, apply diffs sequentially using a region-based heuristic: identify non-overlapping change regions from each worktree diff and apply them in order; flag overlapping regions as conflicts requiring orchestrator review.
3. For Markdown files (the dominant file type in specrails), apply section-aware merging: treat `##` headings as merge boundaries and combine sections additively.
4. For non-Markdown files (YAML, JSON, shell scripts), fall back to a unified diff approach with explicit conflict markers if regions overlap.
5. Emit a merge report: files merged cleanly, files with resolved regions, files requiring manual resolution, and the specific conflicting regions.

This is intentionally **not** AST-aware in the first iteration. The project is pre-code (shell + Markdown), so Markdown-section-aware merging covers the dominant case. YAML and JSON files are structured enough that region-based diff suffices. Full AST parsing is deferred to a future iteration when the project acquires compiled language source files.

## Scope

**In scope:**
- Phase 3a.1: full shared file analysis with risk classification (replaces the existing stub)
- Phase 4a: concrete merge algorithm replacing the "manually" stub
- Merge order variable: `MERGE_ORDER` list derived from shared file analysis
- Pre-flight conflict report printed after Phase 3a.1
- Merge result report at end of Phase 4a
- Dry-run compatibility: same logic applies when `DRY_RUN=true`, writing to `CACHE_DIR`
- Updates to `templates/commands/implement.md` and `.claude/commands/implement.md`
- Updates to `openspec/specs/implement.md` to document the new merge behavior

**Out of scope:**
- AST-aware merging for compiled languages (TypeScript, Python, Go, Rust) — deferred
- Automatic three-way merge via `git merge-file` or equivalent — too many edge cases for the current pre-code phase
- New agent: the resolver runs inline in the orchestrator's Phase 4a logic, not as a background agent
- Changes to worktree isolation setup (Phase 3b launch modes are unchanged)
- Changes to the reviewer agent's mandate

## Non-goals

- This feature does NOT guarantee zero conflicts. High-risk shared files with overlapping edits will still surface as conflicts requiring human review — the feature ensures those conflicts are identified clearly, not silently swallowed.
- This feature does NOT modify the developer agent's behavior. Developers still work in isolation per worktree.
- This feature does NOT replace `git merge`. It operates on the working tree level, not on git history.

## Acceptance Criteria

1. Phase 3a.1 produces a structured shared-file report (table format) for every multi-feature run, listing each shared file, which features modify it, and its risk classification (`low`, `medium`, `high`).
2. When a `high`-risk shared file is detected, Phase 3a.1 prints a serialization proposal showing the recommended merge order.
3. Phase 4a processes features in `MERGE_ORDER` sequence, not arbitrary order.
4. For Markdown shared files, Phase 4a uses `##`-heading boundaries as merge regions and combines non-overlapping sections additively.
5. For non-Markdown shared files, Phase 4a applies unified diff regions sequentially, inserting conflict markers (`<<<<<<< feature-A`, `=======`, `>>>>>>> feature-B`) only for truly overlapping regions.
6. Phase 4a emits a merge report distinguishing: cleanly merged, auto-resolved, requires manual resolution.
7. Files requiring manual resolution are listed in the Phase 4e final report with their conflict regions.
8. The dry-run path applies identical merge logic, writing results to `CACHE_DIR`.
9. Single-feature mode (`SINGLE_MODE=true`) is entirely unaffected — no changes to that path.
10. Changes are present in both `templates/commands/implement.md` and `.claude/commands/implement.md`.

## Motivation

VPC fit score: 75%. This directly addresses Alex's (Lead Dev) core pain point: parallel feature development is a key value proposition of the pipeline, and its current merge behavior is undefined. Without reliable merging, users with 3+ features cannot trust the pipeline output and must re-implement the merge themselves — defeating the purpose of the tool.

The fix is scoped conservatively: Markdown-section-aware merging handles 90%+ of specrails' current file corpus. This is the right level of complexity for the pre-code phase.
