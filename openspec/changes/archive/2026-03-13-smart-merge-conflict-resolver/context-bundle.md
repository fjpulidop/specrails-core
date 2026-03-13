---
change: smart-merge-conflict-resolver
type: context-bundle
---

# Context Bundle: Smart Merge Conflict Resolver

This document is a self-contained developer briefing. You do not need to read any other file to execute these tasks.

---

## What You Are Building

You are adding a concrete merge algorithm to the `/implement` pipeline. Currently, when multiple features are implemented in parallel using git worktrees, Phase 4a says "merge shared files manually" — which is undefined and causes silent data loss (last-writer-wins). You will:

1. Replace the Phase 3a.1 stub with a full shared-file analysis that classifies each shared file by conflict risk and derives a merge order.
2. Replace the Phase 4a stub with a concrete, ordered merge algorithm (section-aware for Markdown, diff/patch for everything else).
3. Add merge conflict reporting to the Phase 4e summary.
4. Mirror all changes to the generated command file.
5. Update the spec with normative documentation.

**This is exclusively an edit to two command files and one spec file. No new agents, no new templates, no new directories.**

---

## Files to Change

| File | Change Type | Notes |
|------|-------------|-------|
| `templates/commands/implement.md` | Modify | Primary target — contains the pipeline definition with `{{PLACEHOLDER}}` syntax |
| `.claude/commands/implement.md` | Modify | Generated copy — same changes but placeholders already resolved; do NOT introduce `{{...}}` |
| `openspec/specs/implement.md` | Modify | Spec — add "Merge Behavior" section and three variable rows |

**Do NOT modify:**
- Any file in `templates/agents/` or `.claude/agents/`
- `install.sh`
- Any other command file
- Any OpenSpec change artifact file (proposal.md, design.md, delta-spec.md, tasks.md — the files you are reading right now)

---

## Current State

### `templates/commands/implement.md` — Phase 3a.1 (the stub, lines ~143–147)

```markdown
### 3a.1 Identify shared file conflicts

Before launching developers, scan all tasks.md files to identify **shared files** that multiple features will modify.
```

This is three lines. It says nothing about how to scan, what risk levels to assign, or what to do with the result.

### `templates/commands/implement.md` — Phase 4a (the stub, lines ~233–239)

```markdown
### 4a. Merge worktree changes to main repo

- If `SINGLE_MODE`: skip (no worktrees were used).
- If `DRY_RUN=true`: merge worktree outputs to `CACHE_DIR` instead of the main repo. Apply the same merge logic (copy feature-specific files, handle shared files) but destination is `CACHE_DIR/<file-path>`.
- Otherwise: merge to main repo working tree as normal (copy feature-specific files, merge shared files manually, clean up worktrees).
```

The word "manually" is the problem. There is no algorithm.

### `openspec/specs/implement.md` — Variable Reference table (lines ~110–119)

The table has four rows: `DRY_RUN`, `APPLY_MODE`, `APPLY_TARGET`, `CACHE_DIR`. Three new rows must be added: `SHARED_FILES`, `MERGE_ORDER`, `MERGE_REPORT`.

### `.claude/commands/implement.md`

Identical structure to the template but with `{{PLACEHOLDER}}` strings resolved. Phase 3a.1 and Phase 4a have the same stub content. The generated file does not have placeholders in these sections — the Phase 3a.1 and Phase 4a sections are plain prose.

---

## Exact Changes

### Change 1 — Replace Phase 3a.1 stub in `templates/commands/implement.md`

**Location:** The section starting with `### 3a.1 Identify shared file conflicts` and ending before `### 3a.2 Pre-validate architect output`.

**Replace this exact block:**

```markdown
### 3a.1 Identify shared file conflicts

Before launching developers, scan all tasks.md files to identify **shared files** that multiple features will modify.
```

**With this block:**

```markdown
### 3a.1 Identify shared file conflicts

**Only runs in multi-feature mode** (more than one feature). Skip entirely if `SINGLE_MODE=true`.

After all architect agents complete, before launching any developer agent:

#### Step 1: Extract file references

For each `openspec/changes/<name>/tasks.md`, extract all paths listed under `**Files:**` entries (both `Create:` and `Modify:` lines). Normalize paths: strip leading `./`.

#### Step 2: Build the shared-file registry

Group file paths across all features. Any path appearing in two or more features' task lists is a **shared file**. Store as `SHARED_FILES` map: `{path: {features: [...], risk: ""}}`.

#### Step 3: Classify risk

For each shared file, classify risk based on file type and which regions each feature modifies (consult each feature's context-bundle.md "Exact Changes" section):

| Risk | Condition |
|------|-----------|
| `low` | Both features only append new named sections not present in the other feature's changes |
| `medium` | Both features modify structurally distinct regions (different `##` sections or different top-level YAML keys) |
| `high` | Both features modify the same region (same `##` section, same YAML key subtree, or any region in shell scripts) |

Shell scripts (`.sh`, `.bash`): always `high`.
Net-new files that two features both create: always `high`.

#### Step 4: Derive MERGE_ORDER

Sort features so that for any pair sharing a `high`-risk file, one appears before the other. Use topological sort; break ties alphabetically. Set `MERGE_ORDER` = sorted feature list.

#### Step 5: Print pre-flight report

```
## Shared File Analysis

| File | Features | Risk |
|------|----------|------|
| <path> | <feature-a>, <feature-b> | <risk> |

Merge order: <feature-a> → <feature-b> → <feature-c>

High-risk files detected. These files will be merged sequentially.
Developers will still run in parallel — merge order applies at Phase 4a only.
```

If no shared files: print `No shared files detected. All features modify independent files.`
```

---

### Change 2 — Replace Phase 4a body in `templates/commands/implement.md`

**Location:** The section starting with `### 4a. Merge worktree changes to main repo` and ending before `### 4b. Launch Reviewer agent`.

**Replace this exact block:**

```markdown
### 4a. Merge worktree changes to main repo

- If `SINGLE_MODE`: skip (no worktrees were used).
- If `DRY_RUN=true`: merge worktree outputs to `CACHE_DIR` instead of the main repo. Apply the same merge logic (copy feature-specific files, handle shared files) but destination is `CACHE_DIR/<file-path>`.
- Otherwise: merge to main repo working tree as normal (copy feature-specific files, merge shared files manually, clean up worktrees).
```

**With this block:**

```markdown
### 4a. Merge worktree changes to main repo

- If `SINGLE_MODE`: skip (no worktrees were used). Proceed to Phase 4b.
- If `DRY_RUN=true`: apply the merge algorithm below, writing all outputs to `CACHE_DIR/<file-path>` instead of the main repo working tree. Do NOT clean up worktrees in dry-run mode.
- Otherwise: apply the merge algorithm below, writing outputs to the main repo working tree. Clean up worktrees at the end.

#### Merge Algorithm

Process features in `MERGE_ORDER` sequence. For each feature:

**Step 1: Identify changed files**

```bash
git -C <worktree-path> diff main --name-only
```

Split into `exclusive_files` (only this feature modifies them) and `shared_files_for_this_feature` (also modified by another feature in MERGE_ORDER).

**Step 2: Merge exclusive files**

Copy directly from worktree to target:
```bash
cp <worktree-path>/<file> <target>/<file>
```
Log: `Copied (exclusive): <file>`

**Step 3: Merge shared files**

For each shared file, choose strategy by file type:

**Strategy A — Markdown section-aware merge** (`.md` files):
1. Read base: current content of `<target>/<file>`.
2. Read incoming: `<worktree-path>/<file>`.
3. Parse both into sections using `##` heading boundaries (heading line + all content until next `##` or EOF).
4. Build section maps: `{heading_text: content}` for base and incoming.
5. Merge:
   - Section in base only: keep.
   - Section in incoming only: append to merged output.
   - Section in both, content identical: keep base.
   - Section in both, content differs: insert conflict markers:
     ```
     <<<<<<< <feature-name>
     <incoming section content>
     =======
     <base section content>
     >>>>>>> base
     ```
     Log: `CONFLICT: <file> — section "<heading>" requires manual resolution.`
6. Write merged result to `<target>/<file>`.

**Strategy B — Unified diff sequential apply** (all other file types):
1. Generate incoming diff against original `main`:
   ```bash
   git -C <worktree-path> diff main -- <file>
   ```
2. Apply to current target:
   ```bash
   patch --forward --fuzz=3 <target>/<file> < <diff>
   ```
3. If `patch` succeeds: log `Merged (diff-apply): <file>`.
4. If `patch` fails: insert conflict markers around rejected hunks. Log: `CONFLICT: <file> — N hunks rejected.`

If `patch` is not available (detected in Phase -1): use Strategy A for all file types and print: `[warn] patch not available — using section-aware fallback for all shared files.`

**Step 4: Record outcomes**

Maintain `MERGE_REPORT`:
- `cleanly_merged`: exclusive files + shared files with no conflict markers
- `auto_resolved`: shared files merged without conflict markers
- `requires_resolution`: `{file, feature, regions}` for files with conflict markers

**Step 5: Emit merge report**

After all features are processed:

```
## Phase 4a Merge Report

### Cleanly Merged
- <file> (exclusive to <feature>)

### Auto-Resolved
- <file> (features: <a>, <b> — distinct sections)

### Requires Manual Resolution
- <file> (features: <a>, <b> — conflicting section: "<heading>")
  Search for `<<<<<<< <feature-name>` to locate conflict markers.

Pipeline will continue. Fix conflicts above before the reviewer runs CI.
```

**Step 6: Clean up worktrees** (skip if `DRY_RUN=true`)

```bash
git worktree remove <worktree-path> --force
```

Pass `MERGE_REPORT` to the Phase 4b reviewer agent prompt, listing any files in `requires_resolution`.
```

---

### Change 3 — Add conflict table to Phase 4e in `templates/commands/implement.md`

**Location:** In the Phase 4e "Otherwise" (non-dry-run) report section. After the pipeline status table code block, insert:

```markdown
If `MERGE_REPORT.requires_resolution` is non-empty, print an additional section:

```
### Merge Conflicts Requiring Resolution

| File | Features | Conflicting Region |
|------|----------|-------------------|
| <file> | <feature-a>, <feature-b> | <section heading or hunk description> |

Fix these conflicts (search for `<<<<<<<` in each file), then commit the resolved files.
```
```

**Location anchor:** After the closing ` ``` ` of the pipeline status table (the table with `Area | Feature | Change Name | ...`), before the "Include the shipping mode in the report" line.

---

### Change 4 — Apply the same changes to `.claude/commands/implement.md`

Apply Changes 1, 2, and 3 to `.claude/commands/implement.md`. The content is identical — this file has no placeholders in the Phase 3a.1 or Phase 4a sections, so no placeholder resolution is needed.

Verify: after editing, run:
```bash
grep -n 'manually' /Users/javi/repos/specrails/.claude/commands/implement.md
```
Expected: no matches in Phase 4a (the word "manually" must be gone from the merge section).

---

### Change 5 — Add "Merge Behavior" section to `openspec/specs/implement.md`

**Location:** After the "Edge Cases" section (currently the last section in the file).

**Insert this section:**

```markdown
---

## Merge Behavior

### Shared File Analysis (Phase 3a.1)

**When multi-feature mode is active** (more than one feature is being implemented), the pipeline SHALL run a shared file analysis before launching any developer agent.

The analysis MUST:
1. Extract all file paths listed in `**Files:**` entries within each feature's `tasks.md`.
2. Identify paths that appear in two or more features' file lists as **shared files**.
3. Classify each shared file with a risk level: `low`, `medium`, or `high`.
4. Derive `MERGE_ORDER`: an ordered sequence of feature names such that features with `high`-risk shared files are processed sequentially.
5. Print a pre-flight shared file report before developer agents launch.

The analysis SHALL NOT block developer agent launch.

**Risk Classification Rules:**

| Risk | Condition |
|------|-----------|
| `low` | Both features append new, named sections that do not exist in the other feature's changes |
| `medium` | Both features modify structurally distinct regions of the same file |
| `high` | Both features modify overlapping regions; or the file is a shell script; or both features create the same net-new file |

### Merge Algorithm (Phase 4a)

**When multi-feature mode is active**, Phase 4a MUST process features in `MERGE_ORDER` sequence.

**For exclusive files**: copy directly from worktree to merge target.

**For shared Markdown files** (`.md`): apply section-aware merging using `##` heading boundaries. Non-overlapping sections are combined additively. Overlapping sections receive conflict markers (`<<<<<<< / ======= / >>>>>>>`).

**For shared non-Markdown files**: apply unified diff sequential merging using `patch --forward --fuzz=3`. Failed hunks receive conflict markers.

**If `patch` is unavailable**: fall back to section-aware merge for all file types with a warning.

### Merge Report

Phase 4a MUST emit a merge report listing: Cleanly Merged, Auto-Resolved, and Requires Manual Resolution. Files in "Requires Manual Resolution" MUST appear in the Phase 4e final report. The reviewer agent prompt MUST include the conflict file list.

### Dry-Run Compatibility

When `DRY_RUN=true`, Phase 4a MUST apply the identical merge algorithm writing to `CACHE_DIR`. Merge report MUST be written to `.cache-manifest.json` under `merge_report`. Worktrees SHALL NOT be cleaned up.

### Constraints

- `SINGLE_MODE=true` MUST bypass Phase 3a.1 and Phase 4a smart merge entirely.
- The merge algorithm MUST NOT create git commits, branches, or pushes.
- Pre-existing conflict markers in a file MUST NOT be nested with new conflict markers — log a warning instead.
```

**Extend the Variable Reference table** with three new rows (insert after the `CACHE_DIR` row):

```markdown
| `SHARED_FILES` | map | After Phase 3a.1, multi-feature only | Registry mapping file paths to `{features: [...], risk: "low"\|"medium"\|"high"}` |
| `MERGE_ORDER` | list | After Phase 3a.1, multi-feature only | Ordered sequence of feature names for Phase 4a processing |
| `MERGE_REPORT` | map | During Phase 4a, multi-feature only | Accumulates merge outcomes: `cleanly_merged`, `auto_resolved`, `requires_resolution` |
```

---

## Existing Patterns to Follow

- **Phase section structure**: Each phase has a `##` heading, optional subsections with `###`, and numbered steps within code blocks or bold-prefixed paragraphs. Follow exactly.
- **Condition guards**: Use the pattern `**If `FLAG=true`:**` followed by bullet points. See Phase 3b "Dry-Run: Redirect developer writes" for the canonical example.
- **Code blocks in pipeline instructions**: Use triple-backtick blocks with the `bash` language tag for shell commands, no tag for output format examples.
- **Conflict markers**: The canonical format is `<<<<<<< <feature-name>` (not `<<<<<<< HEAD` or `<<<<<<< THEIRS` — feature name is more readable for the reviewer).
- **Non-breaking changes**: Always preserve existing content verbatim. The only removals in this change set are the two stubs being replaced.

---

## Conventions Checklist

Before marking any task done:

- [ ] No `{{PLACEHOLDER}}` strings introduced into `.claude/commands/implement.md`
- [ ] No `{{PLACEHOLDER}}` strings broken in `templates/commands/implement.md` (the sections being edited have none, but verify with surrounding context)
- [ ] The word "manually" does not appear in the new Phase 4a text
- [ ] `SINGLE_MODE=true` skip guard is present in Phase 3a.1 AND Phase 4a
- [ ] Dry-run path (`DRY_RUN=true`) is explicitly handled in both Phase 3a.1 (N/A — no change) and Phase 4a (CACHE_DIR target)
- [ ] Conflict marker format exactly: `<<<<<<< <feature-name>` / `=======` / `>>>>>>> base`
- [ ] `MERGE_ORDER`, `SHARED_FILES`, `MERGE_REPORT` variable names are spelled consistently across all three files
- [ ] Phase 4e conflict table is conditional (only printed when `requires_resolution` is non-empty)
- [ ] Spec additions use SHALL/MUST/SHOULD normative language

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Phase 4a edit accidentally truncates Phase 4b content | Medium | Read from `### 4a.` to `### 4b.` to identify the exact replacement boundary before editing |
| `MERGE_ORDER` variable referenced in Phase 4a but defined in Phase 3a.1 — ordering in the reader's mind may be confused | Low | Phase 3a.1 runs before developer launch; Phase 4a runs after all agents complete. The timeline is clear from the phase numbers. |
| Section-aware merge breaks on files that use `###` as top-level sections (non-standard) | Low | specrails files consistently use `##` for top-level logical sections. Document the `##` assumption in the algorithm text. |
| `patch` not available in some environments (Docker, minimal shells) | Low | Phase -1 fallback guard handles this. The context-bundle already includes the detection note. |
| Task 4 (generated file) diverges from template if editor applies slightly different phrasing | Medium | Developer should copy content directly from the modified template, not rewrite from scratch. The tasks.md says this explicitly. |
