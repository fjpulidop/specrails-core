---
change: smart-merge-conflict-resolver
type: delta-spec
---

# Delta Spec: Smart Merge Conflict Resolver

This document describes the changes to `openspec/specs/implement.md` required by this feature. It uses SHALL/MUST/SHOULD language to define normative behavior.

---

## Changes to `openspec/specs/implement.md`

### Add: "Merge Behavior" section

Insert the following section after the "Variable Reference" section (currently the last section) in `openspec/specs/implement.md`:

---

## Merge Behavior

### Shared File Analysis (Phase 3a.1)

**When multi-feature mode is active** (more than one feature is being implemented), the pipeline SHALL run a shared file analysis before launching any developer agent.

The analysis MUST:
1. Extract all file paths listed in `**Files:**` entries within each feature's `tasks.md`.
2. Identify paths that appear in two or more features' file lists as **shared files**.
3. Classify each shared file with a risk level: `low`, `medium`, or `high` (see risk classification rules below).
4. Derive `MERGE_ORDER`: an ordered sequence of feature names such that features with `high`-risk shared files are processed sequentially.
5. Print a pre-flight shared file report before developer agents launch.

The analysis SHALL NOT block developer agent launch. Regardless of risk classification, all developer agents launch in parallel after Phase 3a.1 completes.

**Risk Classification Rules:**

| Risk | Condition |
|------|-----------|
| `low` | Both features append new, named sections (`##` headings for Markdown; new top-level keys for YAML/JSON) that do not exist in the other feature's changes |
| `medium` | Both features modify structurally distinct regions of the same file (different `##` sections; different top-level YAML keys) |
| `high` | Both features modify overlapping regions of the same file (same `##` section; same YAML/JSON key subtree; any region in shell scripts) |

### Merge Algorithm (Phase 4a)

**When multi-feature mode is active**, Phase 4a MUST process features in `MERGE_ORDER` sequence (not arbitrary order).

**For exclusive files** (modified by only one feature): the pipeline SHALL copy the file directly from the worktree to the merge target.

**For shared Markdown files** (`.md` extension): the pipeline SHALL apply section-aware merging:
- Parse files into sections using `##` heading boundaries.
- Sections present in only one version SHALL be added to the merged output.
- Sections present in both versions with identical content SHALL be kept as-is (the base version is authoritative).
- Sections present in both versions with differing content SHALL be marked as conflicts using the following format:
  ```
  <<<<<<< <feature-name>
  <incoming section content>
  =======
  <base section content>
  >>>>>>> base
  ```

**For shared non-Markdown files** (`.yaml`, `.yml`, `.json`, `.sh`, `.bash`, and all other types): the pipeline SHALL apply unified diff sequential merging:
- Generate the incoming diff against the original `main` version.
- Apply the diff to the current target file using `patch --forward --fuzz=3`.
- If `patch` succeeds: the file is cleanly merged.
- If `patch` rejects one or more hunks: the rejected regions SHALL be marked with conflict markers as above.

**If `patch` is not available** in the environment: the pipeline SHALL fall back to section-aware merge for all file types and MUST print a warning noting the fallback.

### Merge Report

Phase 4a MUST emit a merge report after all features are processed. The report SHALL include:

- **Cleanly Merged**: files copied exclusively (no conflict possible)
- **Auto-Resolved**: shared files merged without conflicts
- **Requires Manual Resolution**: shared files where conflict markers were inserted, with the feature name and conflicting section or hunk

Files listed under "Requires Manual Resolution" MUST also appear in the Phase 4e final report.

The reviewer agent prompt MUST include the list of conflicting files (if any) so the reviewer can attempt auto-resolution.

### Dry-Run Compatibility

When `DRY_RUN=true`, Phase 4a MUST apply the identical merge algorithm, writing all results to `CACHE_DIR` instead of the main repo working tree.

The merge report MUST be written to `.cache-manifest.json` under a `merge_report` key.

Worktrees SHALL NOT be cleaned up in dry-run mode.

### Constraints

- `SINGLE_MODE=true` MUST bypass Phase 3a.1 and Phase 4a smart merge entirely. No shared file analysis, no MERGE_ORDER, no section-aware merge.
- The merge algorithm MUST NOT make any git commits, branch operations, or push operations. It operates exclusively on the working tree.
- If a file already contains conflict markers from a prior failed run, the pipeline MUST log a warning and MUST NOT insert nested conflict markers.

---

### Add: New variables to "Variable Reference" section

Append the following rows to the Variable Reference table in `openspec/specs/implement.md`:

| Variable | Type | Set when | Description |
|----------|------|----------|-------------|
| `SHARED_FILES` | map | After Phase 3a.1, multi-feature only | Registry mapping file paths to `{features: [...], risk: "low"|"medium"|"high"}` |
| `MERGE_ORDER` | list | After Phase 3a.1, multi-feature only | Ordered sequence of feature names for Phase 4a processing |
| `MERGE_REPORT` | map | During Phase 4a, multi-feature only | Accumulates merge outcomes: `cleanly_merged`, `auto_resolved`, `requires_resolution` |
