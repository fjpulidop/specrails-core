---
change: smart-merge-conflict-resolver
type: design
---

# Design: Smart Merge Conflict Resolver

## Architecture Overview

This feature is entirely contained within the orchestrator's inline logic — no new agents, no new files outside of `implement.md` edits. The two affected phases are:

- **Phase 3a.1**: shared file detection and risk classification (currently a one-line stub)
- **Phase 4a**: merge algorithm (currently a vague instruction to "merge shared files manually")

Both changes live in the same file (`templates/commands/implement.md`), mirrored to `.claude/commands/implement.md`. The spec (`openspec/specs/implement.md`) gains a new "Merge Behavior" section.

---

## Phase 3a.1 Redesign: Shared File Analysis

### Current state

```markdown
### 3a.1 Identify shared file conflicts

Before launching developers, scan all tasks.md files to identify **shared files** that multiple features will modify.
```

This is a stub. It says what to scan but not how, what output to produce, or what to do with the result.

### New design

Phase 3a.1 executes immediately after all architect agents complete, before any developer agent launches.

#### Step 1: Extract file references from tasks.md

For each `openspec/changes/<name>/tasks.md`, extract all file paths listed under "Files:" or "**Files:**" entries. These are the files each feature intends to modify or create.

Normalization rules:
- Strip leading `./` from paths
- Treat `Create:` and `Modify:` entries identically — a creation conflict is still a conflict
- Ignore paths that don't exist in the repo (they're net-new files; two features creating the same net-new path IS a conflict)

#### Step 2: Build the shared-file registry

Group file paths across all features. Any path appearing in two or more features' task lists is a **shared file**.

Data structure (in-memory for the orchestrator):
```
shared_files = {
  "path/to/file": {
    features: ["feature-a", "feature-b"],
    risk: "low" | "medium" | "high"
  }
}
```

#### Step 3: Risk classification heuristic

Classify each shared file by risk:

| Risk | Criteria | Examples |
|------|----------|---------|
| `low` | Only one feature modifies the file's content; the other only creates it (net-new additions don't collide) | Feature A adds a new section at EOF; Feature B does not touch that file at all in its actual diff |
| `low` | Both features append to distinct, named sections that don't overlap | Two features each add a new `##` section with different headings |
| `medium` | Both features modify the same file but in structurally distinct regions (different `##` sections, different top-level YAML keys) | Feature A adds to `Phase 3b`, Feature B adds to `Phase 4` |
| `high` | Both features modify the same region of the file (same `##` section, same YAML block, same function body) | Both modify the Phase 4e report table header |

**Classification algorithm for Markdown files:**
1. For each feature, identify which `##` sections they modify (by reading context-bundle.md "Exact Changes" section).
2. If the section sets are disjoint: `medium` risk.
3. If the section sets overlap: `high` risk.
4. If one feature only appends a new `##` section not present in any other feature's changes: downgrade to `low` risk.

**Classification for non-Markdown files:**
- YAML/JSON with distinct top-level keys: `medium`
- YAML/JSON with overlapping keys: `high`
- Shell scripts: always `high` (line-level edits are hard to region-classify without execution context)

#### Step 4: Derive MERGE_ORDER

For features with `high`-risk shared files, serialized merge order reduces the risk of conflicts by making one feature's output the base for the next:

1. Build a dependency graph: if Feature A and Feature B share a `high`-risk file, one must come before the other in merge order.
2. Use topological sort. If there are no ordering constraints between two features (they share no `high`-risk files), their relative order is arbitrary.
3. Set `MERGE_ORDER` = the sorted feature list.

Note: `MERGE_ORDER` is the sequence in which Phase 4a processes features, not the sequence in which developer agents run. Developer agents still run in parallel.

#### Step 5: Print pre-flight report

```
## Shared File Analysis

| File | Features | Risk |
|------|----------|------|
| templates/commands/implement.md | feature-a, feature-b | high |
| .claude/commands/implement.md | feature-a, feature-b | high |
| openspec/specs/implement.md | feature-b, feature-c | medium |

Merge order: feature-a → feature-b → feature-c

High-risk files detected. These files will be merged sequentially in the order above.
Developers will still run in parallel — merge order applies at Phase 4a only.
```

If no shared files exist, print: `No shared files detected. All features modify independent files.`

---

## Phase 4a Redesign: Smart Merge Algorithm

### Current state

```markdown
### 4a. Merge worktree changes to main repo

- If `SINGLE_MODE`: skip (no worktrees were used).
- If `DRY_RUN=true`: merge worktree outputs to `CACHE_DIR` instead of the main repo.
- Otherwise: merge to main repo working tree as normal (copy feature-specific files, merge shared files manually, clean up worktrees).
```

"Manually" is undefined. This design replaces it with a concrete, ordered algorithm.

### New design

Phase 4a processes features in `MERGE_ORDER` sequence.

#### For each feature in MERGE_ORDER:

**Step 1: Identify this feature's changed files**

Read the feature's worktree diff against main:
```bash
git -C <worktree-path> diff main --name-only
```

Split the file list into:
- `exclusive_files`: files only this feature modifies
- `shared_files_for_this_feature`: files also modified by another feature

**Step 2: Merge exclusive files**

For exclusive files: direct copy from worktree to target (main repo working tree, or `CACHE_DIR` in dry-run mode).

```bash
cp <worktree-path>/<file> <target>/<file>
```

No conflict possible. Log: `Copied (exclusive): <file>`

**Step 3: Merge shared files**

For each shared file, apply the appropriate merge strategy based on file type and risk.

##### Strategy A: Markdown section-aware merge

Applies when: file extension is `.md`

Algorithm:
1. Read the **base** version: current content of `<target>/<file>` (which may already have a previous feature's changes applied if this is not the first feature in MERGE_ORDER).
2. Read the **incoming** version: `<worktree-path>/<file>`.
3. Parse both into sections using `##` heading boundaries. A section is: the heading line + all content until the next `##` heading or EOF.
4. Build a section map: `{heading_text: content}` for both base and incoming.
5. Merge:
   - Sections present only in base: keep as-is.
   - Sections present only in incoming: append after the last base section (or in position order if the incoming file has a clear structure to follow).
   - Sections present in both:
     - If content is identical: keep base version (no-op).
     - If content differs: this is a **conflict region**. Insert conflict markers:
       ```
       <<<<<<< <feature-name>
       <incoming section content>
       =======
       <base section content>
       >>>>>>> base
       ```
     - Log: `CONFLICT: <file> — section "<heading>" requires manual resolution.`

6. Write the merged result to `<target>/<file>`.
7. Log outcome: `Merged (section-aware): <file>` or `Merged with conflicts: <file> (N sections need resolution)`

##### Strategy B: Unified diff sequential apply

Applies when: file extension is `.yaml`, `.yml`, `.json`, `.sh`, `.bash`, or any non-Markdown type

Algorithm:
1. Generate a diff of the incoming changes against the original `main` version:
   ```bash
   git -C <worktree-path> diff main -- <file>
   ```
2. Attempt to apply the diff to the current target file (which may already have changes from a prior feature):
   ```bash
   patch --forward --fuzz=3 <target>/<file> < <diff>
   ```
3. If `patch` succeeds: log `Merged (diff-apply): <file>`
4. If `patch` fails (hunk rejection): fall back to conflict markers. Write the conflicting hunks as:
   ```
   <<<<<<< <feature-name>
   <incoming hunk>
   =======
   <current base content at that location>
   >>>>>>> base
   ```
   Log: `CONFLICT: <file> — N hunks rejected, manual resolution required.`

Note: `patch` is POSIX standard and available in all target environments. This avoids any dependency on language-specific tooling.

#### Step 4: Record merge outcomes

Maintain a `MERGE_REPORT` accumulator:
```
merge_report = {
  cleanly_merged: ["file-a", "file-b"],
  auto_resolved: ["file-c"],   # section-aware merge with no conflicts
  requires_resolution: [
    {file: "file-d", feature: "feature-b", sections: ["## Phase 4a"]},
  ]
}
```

#### Step 5: Emit merge report

After all features are processed:

```
## Phase 4a Merge Report

### Cleanly Merged (exclusive files)
- templates/commands/implement.md ... (exclusive to feature-a)
- src/utils/parser.ts ... (exclusive to feature-b)

### Auto-Resolved (section-aware merge, no conflicts)
- openspec/specs/implement.md (features: feature-a, feature-b — distinct sections)

### Requires Manual Resolution
- templates/agents/developer.md (features: feature-a, feature-b — conflicting section: "## Identity")
  Search for `<<<<<<< feature-a` to find conflict markers.

Pipeline will continue. Fix the conflicts above before the reviewer runs CI.
```

If `requires_resolution` is non-empty: the reviewer agent prompt must include the list of conflicting files so the reviewer can attempt auto-resolution or flag them clearly.

#### Step 6: Clean up worktrees

After all merges are complete, remove worktree directories:
```bash
git worktree remove <worktree-path> --force
```

---

## Dry-Run Compatibility

When `DRY_RUN=true`:
- Target directory is `CACHE_DIR` instead of the main repo working tree.
- All copy, merge, and patch operations write to `CACHE_DIR/<real-path>`.
- The merge report is appended to `.cache-manifest.json` under a `merge_report` key.
- Worktrees are NOT cleaned up in dry-run mode (they may be needed for inspection).

---

## Variable Reference

New variables introduced by this feature:

| Variable | Type | Set when | Description |
|----------|------|----------|-------------|
| `SHARED_FILES` | map | After Phase 3a.1 | Registry of shared files with feature lists and risk classification |
| `MERGE_ORDER` | list | After Phase 3a.1 | Ordered sequence of feature names for Phase 4a processing |
| `MERGE_REPORT` | map | During Phase 4a | Accumulates merge outcomes (clean, auto-resolved, conflicts) |

---

## Design Decisions

### Why no new agent?

The merge logic is a sequential, deterministic algorithm operating on files already present in the repo. It does not require the creativity or broad reasoning of an AI agent — it is closer to a script. Embedding it as orchestrator logic keeps the pipeline simpler, keeps latency low (no agent launch overhead), and avoids the ambiguity of an agent making freeform decisions about conflict resolution.

If future iterations require AST-aware merging across multiple compiled languages, a specialized `merge-coordinator` agent would be the right approach at that point.

### Why Markdown-section-aware merging?

specrails' file corpus is overwhelmingly Markdown. The `templates/commands/implement.md` and `.claude/agents/*.md` files — the most frequently modified files in the repo — are Markdown. Section-aware merging using `##` boundaries handles the dominant case correctly with no external dependencies.

`##` (H2) is the right boundary level because specrails Markdown files use H1 for the document title and H2 for logical sections. Smaller boundaries (H3, H4) would over-split sections and miss that a `###` heading belongs to its parent `##` section's scope.

### Why `patch` for non-Markdown?

`patch` is universally available in POSIX environments and is the established tool for applying unified diffs. It handles context lines, fuzz matching, and partial failure gracefully. The alternative (manual line-by-line diff application) would be significantly more complex to specify and execute reliably in an orchestrator prompt.

### Why not `git merge`?

`git merge` operates on branches and commits, not on working tree files. The worktrees in this pipeline are git repos, but merging them back into main via `git merge` would require rebasing or creating merge commits on the main branch — which conflicts with the pipeline's design of producing a single clean branch per feature group. The working-tree approach (copy + patch) is simpler and more predictable for the orchestrator.

### Why not serialize developer agents for high-risk files?

Serializing developers would eliminate conflicts at the source, but at the cost of removing the parallelism that makes multi-feature mode valuable. The correct trade-off: keep developers parallel (speed), handle conflicts at merge time (correctness). For truly irreconcilable conflicts, the pipeline surfaces them clearly rather than silently failing.

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Three features all modify the same Markdown section | Each is merged in MERGE_ORDER. First two may auto-resolve; if all three conflict, the final file has conflict markers showing the last-applied incoming vs. the accumulated base. The reviewer resolves. |
| A feature creates a file that another feature also creates (net-new collision) | Treated as `high`-risk shared file. Section-aware merge or diff-apply will surface the conflict. |
| `patch` binary not available | Detect at Phase -1 (environment setup). If missing, fall back to section-aware merge for all file types with a warning. |
| Single feature in MERGE_ORDER has no shared files | Processes normally. MERGE_ORDER degenerates to a single-feature list. |
| `SINGLE_MODE=true` | Phase 3a.1 and Phase 4a smart merge are entirely skipped. No behavioral change from current implementation. |
| Worktree diff against main returns empty (no changes) | Feature is skipped in MERGE_ORDER. Log: `No changes detected in worktree for <feature>`. |
| Conflict markers already present in a file (from a prior failed run) | The diff-apply strategy will detect this as a pre-existing conflict and log a warning rather than adding nested markers. |
