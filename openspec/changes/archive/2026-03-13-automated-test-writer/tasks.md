---
change: automated-test-writer
type: tasks
---

# Tasks: Automated Test Writer Agent

Tasks are ordered by dependency. Each task has a layer tag, description, files involved, and acceptance criteria.

---

## Task 1 — Create the test-writer agent template [templates]

**Description:** Write `templates/agents/test-writer.md`. This is the canonical template that `install.sh` copies into target repos and that drives all generated instances. Follow the exact same structure as `templates/agents/developer.md` and `templates/agents/security-reviewer.md`.

**Files:**
- Create: `templates/agents/test-writer.md`

**YAML frontmatter:**
```yaml
---
name: test-writer
description: "Use this agent after a developer agent completes implementation, to generate comprehensive tests for the implemented code. Runs as Phase 3c in the implement pipeline, before the reviewer.

Examples:

- Example 1:
  user: (orchestrator) Developer agent completed. Write tests for the implemented files.
  assistant: \"Launching the test-writer agent to generate tests for the implemented code.\"

- Example 2:
  user: (orchestrator) Implementation done. Run test writer before review.
  assistant: \"I'll use the test-writer agent to write tests following the project's test patterns.\""
model: sonnet
color: cyan
memory: project
---
```

**Prompt body MUST include (in order):**
1. Identity: "You are a specialist test engineer. Your only job is to write tests — you never modify implementation files."
2. Mission: generate comprehensive tests targeting >80% coverage of newly implemented code
3. "What you receive" section explaining `IMPLEMENTED_FILES_LIST`, `TASK_DESCRIPTION`, layer CLAUDE.md paths (`{{LAYER_CLAUDE_MD_PATHS}}`)
4. Framework detection protocol: ordered manifest-reading procedure (package.json → requirements.txt/pyproject.toml → Gemfile → go.mod → Cargo.toml → composer.json)
5. Pattern learning protocol: read up to 3 representative existing test files, extract naming convention, directory structure, import style, assertion library, test block structure, mock patterns
6. Test generation mandate: unit tests, integration tests, edge case tests, error handling tests
7. Test writing rules: never modify implementation files; follow exact naming and structure of existing tests; one test file per implementation file unless project convention differs
8. Untestable code protocol: write best-effort test, prepend `# UNTESTABLE: <reason>` comment
9. Files to skip: auto-generated files (migrations, type declaration stubs, scaffold output), binary files
10. Output format: list of test files written with brief coverage description per file, framework detected, patterns learned, files skipped
11. Memory protocol section using `{{MEMORY_PATH}}`

**Placeholders to include:**
- `{{TECH_EXPERTISE}}`
- `{{LAYER_CLAUDE_MD_PATHS}}`
- `{{MEMORY_PATH}}`

**Acceptance criteria:**
- File exists at `templates/agents/test-writer.md`
- Valid YAML frontmatter
- All three placeholders (`{{TECH_EXPERTISE}}`, `{{LAYER_CLAUDE_MD_PATHS}}`, `{{MEMORY_PATH}}`) present exactly once in the body
- `IMPLEMENTED_FILES_LIST` and `TASK_DESCRIPTION` appear as instructional references in the prompt body (not as `{{...}}` substitution targets)
- Framework detection table covers at minimum: Jest/Vitest/Mocha, pytest, RSpec, Go test, cargo test, PHPUnit
- Output format section describes what "done" looks like for the orchestrator to parse
- File follows kebab-case naming: `test-writer.md`

**Dependencies:** None (can start immediately)

---

## Task 2 — Generate the specrails-instance test-writer agent [templates]

**Description:** Create `.claude/agents/test-writer.md` by applying the template. This is what Claude Code uses when running the test-writer in the specrails repo itself. Substitutions:
- `{{TECH_EXPERTISE}}` → specrails full stack description (match what `.claude/agents/developer.md` uses)
- `{{LAYER_CLAUDE_MD_PATHS}}` → `.claude/rules/*.md`
- `{{MEMORY_PATH}}` → `.claude/agent-memory/test-writer/`

**Files:**
- Create: `.claude/agents/test-writer.md`

**Acceptance criteria:**
- File exists at `.claude/agents/test-writer.md`
- No unresolved `{{PLACEHOLDER}}` strings remain (except `IMPLEMENTED_FILES_LIST` and `TASK_DESCRIPTION` which are runtime references in prose)
- Memory path resolves to `.claude/agent-memory/test-writer/`
- YAML frontmatter is valid
- Content matches the template with substitutions applied consistently with other `.claude/agents/*.md` files

**Dependencies:** Task 1

---

## Task 3 — Create test-writer agent memory directory [templates]

**Description:** Create `.claude/agent-memory/test-writer/MEMORY.md` — the initial (empty) memory file. Follows the same pattern as reviewer and security-reviewer agents.

**Files:**
- Create: `.claude/agent-memory/test-writer/MEMORY.md`

**Content:**
```markdown
# Test Writer Agent Memory

No memories recorded yet.
```

**Acceptance criteria:**
- File exists at `.claude/agent-memory/test-writer/MEMORY.md`
- Contains only the standard empty-memory header
- No other content

**Dependencies:** None (can run in parallel with Tasks 1 and 4)

---

## Task 4 — Update `templates/commands/implement.md`: add Phase 3c [templates]

**Description:** Modify `templates/commands/implement.md` to add Phase 3c (Write Tests) between Phase 3b (Implement) and Phase 4 (Merge & Review). This is a surgical insertion — do NOT restructure any existing phases.

**Files:**
- Modify: `templates/commands/implement.md`

**Specific changes:**

**Change 1 — Insert Phase 3c after Phase 3b.**

After the final line of the `## Phase 3b: Implement` section (the "Wait for all developers to complete." line), insert:

```markdown
## Phase 3c: Write Tests

Launch a **test-writer** agent for each feature immediately after its developer completes.

Construct the agent invocation prompt to include:
- **IMPLEMENTED_FILES_LIST**: the complete list of files the developer created or modified for this feature
- **TASK_DESCRIPTION**: the original task or feature description that drove the implementation

### Launch modes

**If `SINGLE_MODE`**: Launch a single test-writer agent in the foreground (`run_in_background: false`). Wait for it to complete before proceeding to Phase 4.

**If multiple features (worktrees)**: Launch one test-writer agent per feature, each in its corresponding worktree (`isolation: worktree`, `run_in_background: true`). Wait for all test-writer agents to complete before proceeding to Phase 4.

### Dry-run behavior

**If `DRY_RUN=true`**, include in every test-writer agent prompt:

> IMPORTANT: This is a dry-run. Write all new or modified test files under:
>   .claude/.dry-run/\<feature-name\>/
>
> Mirror the real destination path within this directory. After writing each file, append an entry
> to .claude/.dry-run/\<feature-name\>/.cache-manifest.json using:
>   {"cached_path": "...", "real_path": "...", "operation": "create"}

### Failure handling

If a test-writer agent fails or times out:
- Record `Tests: FAILED` for that feature in the Phase 4e report
- Continue to Phase 4 — the test-writer failure is non-blocking
- Include in the reviewer agent prompt: "Note: the test-writer failed for this feature. Check for coverage gaps."
```

**Change 2 — Update the Phase 4e report table header.**

Find the line:
```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Security | Tests | CI | Status |
```

Replace with:
```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

(This reorders `Tests` to appear between `Developer` and `Reviewer`, matching execution order.)

**Acceptance criteria:**
- `## Phase 3c: Write Tests` section exists, positioned after `## Phase 3b: Implement` and before `## Phase 4: Merge & Review`
- Section describes single-mode and multi-feature launch behavior
- Section describes dry-run behavior for test files
- Section describes non-blocking failure handling
- Phase 4e report table includes `Tests` column between `Developer` and `Reviewer`
- All existing content is preserved unchanged
- No `{{PLACEHOLDER}}` strings are broken by the edit

**Dependencies:** None (can run in parallel with agent tasks)

---

## Task 5 — Update `.claude/commands/implement.md`: same changes [commands]

**Description:** Apply the same changes from Task 4 to `.claude/commands/implement.md` (the specrails-adapted generated copy). The generated copy has had its template placeholders resolved; apply the same logical sections but in the resolved content.

**Files:**
- Modify: `.claude/commands/implement.md`

**Specific changes:**
- Same Phase 3c insertion as Task 4, positioned after the existing `## Phase 3b: Implement` section
- Same Phase 4e report table update as Task 4

**Acceptance criteria:**
- Same as Task 4, applied to the generated copy
- No template placeholders (`{{...}}`) are introduced into this file — it is a fully resolved instance
- The `## Phase 3c` section references `test-writer` (not a placeholder)
- The Phase 4e table column order matches the template: `Developer | Tests | Reviewer | Security | CI | Status`

**Dependencies:** Task 4 (content pattern established by template edit)

---

## Task 6 — Verify no broken placeholders [templates]

**Description:** After Tasks 1 and 2 are complete, run the placeholder integrity check on the generated agent file to ensure no unresolved `{{PLACEHOLDER}}` strings exist.

**Files:** Read-only verification

**Command:**
```bash
grep -r '{{[A-Z_]*}}' /path/to/repo/.claude/agents/test-writer.md 2>/dev/null || echo "OK: no broken placeholders"
```

Expected output: `OK: no broken placeholders`

**Acceptance criteria:**
- The grep command returns no matches (or echoes "OK")
- If matches are found: fix them in `.claude/agents/test-writer.md` before considering this task done

**Dependencies:** Task 2

---

## Execution Order

```
Task 1 (template)  ──> Task 2 (generated instance)  ──> Task 6 (verify)

Task 3 (memory)  — independent, run any time

Task 4 (template implement.md)  ──> Task 5 (generated implement.md)
```

Tasks 1, 3, and 4 can all start in parallel. Task 2 depends on Task 1. Task 5 depends on Task 4. Task 6 is the final verification and depends on Task 2.

### Minimum critical path

Task 1 → Task 2 → Task 6 (plus Task 4 → Task 5 in parallel)
