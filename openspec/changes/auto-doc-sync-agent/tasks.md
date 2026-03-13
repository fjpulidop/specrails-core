---
change: auto-doc-sync-agent
type: tasks
---

# Tasks: Auto-Doc Sync Agent

Tasks are ordered by dependency. Each task has a layer tag, description, files involved, and acceptance criteria.

---

## Task 1 — Create the doc-sync agent template [templates]

**Description:** Write `templates/agents/doc-sync.md`. This is the canonical template that `install.sh` copies into target repos. Follow the exact same structure as `templates/agents/test-writer.md` — same frontmatter schema, same placeholder conventions, same section ordering.

**Files:**
- Create: `templates/agents/doc-sync.md`

**YAML frontmatter (exact):**
```yaml
---
name: doc-sync
description: "Use this agent after tests are written to automatically update documentation — changelog entries, README feature listings, inline docstrings, and migration guides — keeping docs in sync with code changes. Runs as Phase 3d in the implement pipeline.

Examples:

- Example 1:
  user: (orchestrator) Tests complete. Update docs for the implemented files.
  assistant: \"Launching the doc-sync agent to update documentation for the implemented code.\"

- Example 2:
  user: (orchestrator) Implementation and tests done. Sync docs before review.
  assistant: \"I'll use the doc-sync agent to generate changelog entries, update the README, and add missing docstrings.\""
model: sonnet
color: yellow
memory: project
---
```

**Prompt body MUST include (in order):**

1. **Identity**: "You are a documentation specialist. Your only job is to generate and update documentation — you never modify implementation or test files."
2. **Mission**: Detect the project's existing documentation conventions and extend them to cover newly implemented code. Never invent a new documentation convention.
3. **What you receive**: Explain `IMPLEMENTED_FILES_LIST` (files the developer created or modified), `TASK_DESCRIPTION` (the original feature spec), and layer conventions at `{{LAYER_CLAUDE_MD_PATHS}}`.
4. **Documentation detection protocol**: The four detection signals (inline docstrings, CHANGELOG.md, README feature section, migration guide). If none detected, output `DOC_SYNC_STATUS: SKIPPED` and stop.
5. **Style learning protocol**: Before generating anything, read: up to 3 existing same-language files for docstring style; first 40 lines of CHANGELOG.md for entry format; the README feature section for entry format; the most recent migration entry for structure.
6. **Generation mandate**: Per detected type — docstrings for undocumented exported symbols in `IMPLEMENTED_FILES_LIST`; a new changelog entry prepended to CHANGELOG.md; a new feature entry in the README feature section; a migration guide section if breaking changes detected.
7. **Breaking change detection**: Four signals (signature change, removed export, schema modification, CLI interface change). If detected and migration guide convention present: generate migration section. If no migration convention: add `### Breaking Changes` to changelog entry.
8. **Generation rules**: Never modify implementation or test files; never modify existing docstrings; only add entries to sections that already exist; use `TASK_DESCRIPTION` prose as the basis for changelog and README entries.
9. **Output format**: Full report with `DOC_SYNC_STATUS` as final line.
10. **Memory protocol**: Using `{{MEMORY_PATH}}`.

**Placeholders to include:**
- `{{TECH_EXPERTISE}}`
- `{{LAYER_CLAUDE_MD_PATHS}}`
- `{{MEMORY_PATH}}`

**Output format section must define:**

```
## Doc Sync Results

### Documentation Detected
- Docstrings: yes/no (<style>)
- CHANGELOG.md: yes/no (<format>)
- README feature section: yes/no (<section heading>)
- Migration guide: yes/no (<location>)

### Documentation Written
| Type | File | Description |
|------|------|-------------|
| Docstrings | <file> | Added docstrings to N exported symbols |
| Changelog | CHANGELOG.md | Added entry for <feature> |
| README | README.md | Added feature entry under <section> |
| Migration | <file> | Added breaking change section for <change> |

### Skipped
| Type | Reason |
|------|--------|
(rows or "None")

---
DOC_SYNC_STATUS: DONE|SKIPPED|PARTIAL|FAILED
```

`DOC_SYNC_STATUS` must be the final line of output.

**Acceptance criteria:**
- File exists at `templates/agents/doc-sync.md`
- Valid YAML frontmatter with `color: yellow`
- All three placeholders (`{{TECH_EXPERTISE}}`, `{{LAYER_CLAUDE_MD_PATHS}}`, `{{MEMORY_PATH}}`) present exactly once in the body
- `IMPLEMENTED_FILES_LIST` and `TASK_DESCRIPTION` appear as instructional prose references, not as `{{...}}` targets
- Four documentation types covered in detection and generation sections
- `DOC_SYNC_STATUS:` output format defined, with `DOC_SYNC_STATUS:` as the final line
- File uses kebab-case naming: `doc-sync.md`

**Dependencies:** None (can start immediately)

---

## Task 2 — Generate the specrails-instance doc-sync agent [templates]

**Description:** Create `.claude/agents/doc-sync.md` by applying template substitutions. This is what Claude Code uses when running doc-sync in the specrails repo itself.

**Files:**
- Create: `.claude/agents/doc-sync.md`

**Substitutions to apply:**

| Placeholder | Resolved value |
|-------------|---------------|
| `{{TECH_EXPERTISE}}` | Copy verbatim from `.claude/agents/developer.md` (the `{{TECH_EXPERTISE}}` block — Shell scripting, TypeScript/JavaScript, Template systems, Developer tooling, AI prompt engineering) |
| `{{LAYER_CLAUDE_MD_PATHS}}` | `.claude/rules/*.md` |
| `{{MEMORY_PATH}}` | `.claude/agent-memory/doc-sync/` |

**Acceptance criteria:**
- File exists at `.claude/agents/doc-sync.md`
- No unresolved `{{PLACEHOLDER}}` strings remain
- `color: yellow` present in frontmatter
- Memory path resolves to `.claude/agent-memory/doc-sync/`
- YAML frontmatter is valid
- Content matches the template with substitutions applied consistently with other `.claude/agents/*.md` files

**Dependencies:** Task 1

---

## Task 3 — Create doc-sync agent memory directory [templates]

**Description:** Create `.claude/agent-memory/doc-sync/MEMORY.md` — the initial empty memory file. Follows the same pattern as other agent memory files.

**Files:**
- Create: `.claude/agent-memory/doc-sync/MEMORY.md`

**Content (exact):**
```markdown
# Doc Sync Agent Memory

No memories recorded yet.
```

**Acceptance criteria:**
- File exists at `.claude/agent-memory/doc-sync/MEMORY.md`
- Contains only the standard two-line empty-memory header
- No other content

**Dependencies:** None (can run in parallel with Tasks 1 and 4)

---

## Task 4 — Update `templates/commands/implement.md`: add Phase 3d [templates]

**Description:** Modify `templates/commands/implement.md` to insert Phase 3d (Doc Sync) between Phase 3c (Write Tests) and Phase 4 (Merge & Review). This is a surgical insertion — do NOT restructure, reorder, or rewrite any existing phases.

**Files:**
- Modify: `templates/commands/implement.md`

**Change 1 — Insert Phase 3d.**

Find the end of the Phase 3c failure handling block. The last line of Phase 3c (as it currently exists) is:

```
- Include in the reviewer agent prompt: "Note: the test-writer failed for this feature. Check for coverage gaps."
```

Immediately after that line (before the blank line and `## Phase 4: Merge & Review` heading), insert this block:

```markdown
## Phase 3d: Doc Sync

Launch a **doc-sync** agent for each feature after its test-writer completes.

Construct the agent invocation prompt to include:
- **IMPLEMENTED_FILES_LIST**: the complete list of files the developer created or modified for this feature
- **TASK_DESCRIPTION**: the original task or feature description that drove the implementation

### Launch modes

**If `SINGLE_MODE`**: Launch a single doc-sync agent in the foreground (`run_in_background: false`). Wait for completion before proceeding to Phase 4.

**If multiple features (worktrees)**: Launch one doc-sync agent per feature, each in its corresponding worktree (`isolation: worktree`, `run_in_background: true`). Wait for all doc-sync agents to complete before proceeding to Phase 4.

### Dry-run behavior

**If `DRY_RUN=true`**, include in every doc-sync agent prompt:

> IMPORTANT: This is a dry-run. Write all new or modified documentation files under:
>   .claude/.dry-run/\<feature-name\>/
>
> Mirror the real destination path within this directory. After writing each file, append an entry
> to .claude/.dry-run/\<feature-name\>/.cache-manifest.json using this JSON format:
>   {"cached_path": "...", "real_path": "...", "operation": "create|modify"}

### Failure handling

If a doc-sync agent fails or times out:
- Record `Docs: FAILED` for that feature in the Phase 4e report
- Continue to Phase 4 — doc-sync failure is non-blocking
- Include in the reviewer agent prompt: "Note: the doc-sync agent failed for this feature. Documentation may be incomplete."
```

**Change 2 — Update the Phase 4e report table header.**

Find the line (in Phase 4e):
```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

Replace with:
```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Security | CI | Status |
```

(`Docs` is inserted between `Tests` and `Reviewer`, reflecting pipeline execution order.)

**Acceptance criteria:**
- `## Phase 3d: Doc Sync` section exists, positioned after `## Phase 3c: Write Tests` and before `## Phase 4: Merge & Review`
- Phase 3d section describes single-mode and multi-feature launch behavior
- Phase 3d section describes dry-run redirect behavior
- Phase 3d section describes non-blocking failure handling
- Phase 4e report table includes `Docs` column between `Tests` and `Reviewer`
- All existing content is preserved unchanged
- No `{{PLACEHOLDER}}` strings are broken by the edit

**Dependencies:** None (can run in parallel with agent tasks)

---

## Task 5 — Update `.claude/commands/implement.md`: same changes [commands]

**Description:** Apply the identical changes from Task 4 to `.claude/commands/implement.md` (the specrails-adapted generated copy). This file has all template placeholders already resolved; apply the same logical insertions in the resolved content.

**Files:**
- Modify: `.claude/commands/implement.md`

**Specific changes:**
- Same Phase 3d block insertion as Task 4, positioned after the Phase 3c failure handling block and before `## Phase 4: Merge & Review`
- Same Phase 4e report table update as Task 4

**Acceptance criteria:**
- Same structure requirements as Task 4, applied to the generated copy
- No template placeholders (`{{...}}`) are introduced into this file — it is a fully resolved instance
- The `## Phase 3d` section references `doc-sync` (not a placeholder)
- The Phase 4e table column order matches: `Developer | Tests | Docs | Reviewer | Security | CI | Status`

**Dependencies:** Task 4 (content pattern established by template edit)

---

## Task 6 — Verify no broken placeholders [templates]

**Description:** After Tasks 1 and 2 are complete, run the placeholder integrity check on the generated agent file.

**Files:** Read-only verification

**Command:**
```bash
grep -r '{{[A-Z_]*}}' /path/to/repo/.claude/agents/doc-sync.md 2>/dev/null || echo "OK: no broken placeholders"
```

Expected output: `OK: no broken placeholders`

**Acceptance criteria:**
- The grep command returns no matches (or echoes "OK")
- If matches are found: fix them in `.claude/agents/doc-sync.md` before considering this task done

**Dependencies:** Task 2

---

## Execution Order

```
Task 1 (template)  ──> Task 2 (generated instance)  ──> Task 6 (verify)

Task 3 (memory)  — independent, run any time

Task 4 (template implement.md)  ──> Task 5 (generated implement.md)
```

Tasks 1, 3, and 4 can all start in parallel. Task 2 depends on Task 1. Task 5 depends on Task 4. Task 6 is the final verification gate and depends on Task 2.

### Minimum critical path

Task 1 → Task 2 → Task 6 (plus Task 4 → Task 5 in parallel)
