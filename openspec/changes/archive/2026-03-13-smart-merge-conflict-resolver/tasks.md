---
change: smart-merge-conflict-resolver
type: tasks
---

# Tasks: Smart Merge Conflict Resolver

Tasks are ordered by dependency. Each task has a layer tag, description, files involved, and acceptance criteria.

---

## Task 1 — Expand Phase 3a.1 in `templates/commands/implement.md` [templates]

**Description:** Replace the current one-paragraph stub for Phase 3a.1 with the full shared file analysis algorithm. This is a surgical replacement of the existing stub content — do NOT restructure surrounding phases.

**Files:**
- Modify: `templates/commands/implement.md`

**Current content to replace (the stub):**

```markdown
### 3a.1 Identify shared file conflicts

Before launching developers, scan all tasks.md files to identify **shared files** that multiple features will modify.
```

**Replace with:**

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
Non-existent files that two features both create: always `high`.

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

**Acceptance criteria:**
- The stub is fully replaced; no "manually" or vague language remains in Phase 3a.1
- The replacement text matches the above content exactly
- `SINGLE_MODE=true` skip guard is present
- Five steps (extract, registry, classify, MERGE_ORDER, report) are all present
- Risk classification table is present with three rows
- Pre-flight report format matches the above code block
- No surrounding phases are modified
- No `{{PLACEHOLDER}}` strings are broken by the edit

**Dependencies:** None (can start immediately)

---

## Task 2 — Expand Phase 4a in `templates/commands/implement.md` [templates]

**Description:** Replace the vague "merge shared files manually" instruction in Phase 4a with the concrete, ordered merge algorithm. This is a surgical replacement of Phase 4a's body — do NOT alter Phase 4b or surrounding content.

**Files:**
- Modify: `templates/commands/implement.md`

**Current content to replace:**

```markdown
### 4a. Merge worktree changes to main repo

- If `SINGLE_MODE`: skip (no worktrees were used).
- If `DRY_RUN=true`: merge worktree outputs to `CACHE_DIR` instead of the main repo. Apply the same merge logic (copy feature-specific files, handle shared files) but destination is `CACHE_DIR/<file-path>`.
- Otherwise: merge to main repo working tree as normal (copy feature-specific files, merge shared files manually, clean up worktrees).
```

**Replace with:**

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
- `cleanly_merged`: exclusive files + shared files with no conflicts
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

**Acceptance criteria:**
- Phase 4a body is fully replaced; no "manually" language remains
- `SINGLE_MODE` skip guard is preserved
- `DRY_RUN` path is preserved and uses `CACHE_DIR`
- Six steps are all present (identify, exclusive, shared, record, report, cleanup)
- Both Strategy A (Markdown) and Strategy B (diff/patch) are present with code blocks
- `patch` fallback warning is present
- Conflict marker format is exactly: `<<<<<<< <feature-name>` / `=======` / `>>>>>>> base`
- Merge report format matches the code block above
- `MERGE_REPORT` is passed to Phase 4b
- No surrounding phases (4b, 4b-sec) are modified
- No `{{PLACEHOLDER}}` strings are broken

**Dependencies:** Task 1 (MERGE_ORDER must be defined before Phase 4a references it)

---

## Task 3 — Add conflicts to Phase 4e report in `templates/commands/implement.md` [templates]

**Description:** The Phase 4e final pipeline report table currently has no column or row for merge conflicts. When Phase 4a detects files requiring manual resolution, the Phase 4e report must surface them. This is an additive change to the Phase 4e section.

**Files:**
- Modify: `templates/commands/implement.md`

**Specific change:**

In the Phase 4e "Otherwise" (non-dry-run) report section, after the pipeline status table, add:

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

**Acceptance criteria:**
- The merge conflict table appears in the Phase 4e non-dry-run report section
- The table is conditional on `MERGE_REPORT.requires_resolution` being non-empty
- The table has three columns: File, Features, Conflicting Region
- Instructions to search for `<<<<<<<` are present
- No other Phase 4e content is modified (pipeline status table is unchanged)

**Dependencies:** Task 2 (MERGE_REPORT is defined in Phase 4a)

---

## Task 4 — Apply same changes to `.claude/commands/implement.md` [cli]

**Description:** Mirror all changes from Tasks 1, 2, and 3 into `.claude/commands/implement.md` (the specrails-adapted generated copy). The generated copy has all `{{PLACEHOLDER}}` strings resolved; apply the same logical content without reintroducing placeholders.

**Files:**
- Modify: `.claude/commands/implement.md`

**Specific changes:**
- Replace Phase 3a.1 stub with the expanded algorithm (same content as Task 1, no placeholder changes needed — Phase 3a.1 has no placeholders)
- Replace Phase 4a body with the concrete merge algorithm (same content as Task 2, no placeholder changes needed — Phase 4a has no placeholders)
- Add merge conflict table to Phase 4e (same content as Task 3)

**Acceptance criteria:**
- All three changes from Tasks 1–3 are present in `.claude/commands/implement.md`
- No template placeholders (`{{...}}`) are introduced — this is a fully resolved file
- Content is logically identical to the template changes (accounting for already-resolved placeholders)
- Phase 3a.1 stub is gone; full algorithm is present
- Phase 4a "manually" language is gone; concrete algorithm is present
- Phase 4e conflict table is present

**Dependencies:** Tasks 1, 2, 3 (establish the canonical content to mirror)

---

## Task 5 — Update `openspec/specs/implement.md` with Merge Behavior section [core]

**Description:** Add a "Merge Behavior" normative section to `openspec/specs/implement.md`. This section documents the SHALL/MUST/SHOULD contracts for Phase 3a.1 and Phase 4a, and adds three new variables to the Variable Reference table. Follow the delta-spec.md exactly.

**Files:**
- Modify: `openspec/specs/implement.md`

**Specific changes:**

**Change 1 — Add "Merge Behavior" section** after the "Edge Cases" section (currently last):

Insert the full "Merge Behavior" section from `delta-spec.md`. This section covers:
- Shared File Analysis normative rules
- Risk classification table
- Merge Algorithm normative rules (exclusive files, Markdown strategy, diff/patch strategy)
- Merge Report requirements
- Dry-run compatibility requirements
- Constraints (`SINGLE_MODE` bypass, no git ops, no nested conflict markers)

**Change 2 — Extend the Variable Reference table** with three new rows:

| Variable | Type | Set when | Description |
|----------|------|----------|-------------|
| `SHARED_FILES` | map | After Phase 3a.1, multi-feature only | Registry mapping file paths to `{features: [...], risk: "low"\|"medium"\|"high"}` |
| `MERGE_ORDER` | list | After Phase 3a.1, multi-feature only | Ordered sequence of feature names for Phase 4a processing |
| `MERGE_REPORT` | map | During Phase 4a, multi-feature only | Accumulates merge outcomes: `cleanly_merged`, `auto_resolved`, `requires_resolution` |

**Acceptance criteria:**
- "Merge Behavior" section exists after "Edge Cases" in `openspec/specs/implement.md`
- Section uses SHALL/MUST/SHOULD normative language consistently
- Risk classification table is present with three rows (low, medium, high)
- All three algorithm descriptions are present (exclusive, Markdown, diff/patch)
- Merge Report requirements are present
- Dry-run compatibility is documented
- `SINGLE_MODE` bypass constraint is documented
- Three new rows added to Variable Reference table
- Existing spec content is unchanged

**Dependencies:** None (can run in parallel with Tasks 1–4)

---

## Execution Order

```
Task 1 (Phase 3a.1 in template)  ──┐
                                    ├──> Task 4 (mirror to generated .claude/commands/)
Task 2 (Phase 4a in template)    ──┤
                                    │
Task 3 (Phase 4e in template)    ──┘

Task 5 (spec update)  — independent, runs in parallel
```

Tasks 1, 2, 3, and 5 can all start in parallel. Task 4 depends on Tasks 1, 2, and 3 (needs all template changes established first).

### Minimum critical path

Task 1 → Task 4 (longest path; Task 2 and 3 must also complete before Task 4)

### Execution note

The developer should apply Tasks 1, 2, and 3 to the template file in a single editing session to minimize re-reading the file. Task 4 can then copy the pattern directly from the already-modified template.
