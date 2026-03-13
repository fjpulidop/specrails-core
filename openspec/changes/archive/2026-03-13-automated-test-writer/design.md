---
change: automated-test-writer
type: design
---

# Technical Design: Automated Test Writer Agent

## Architecture Overview

The test-writer is a Claude Code agent — a markdown prompt file with YAML frontmatter, identical in structure to `developer.md` and `reviewer.md`. No new runtime dependencies are required.

The agent runs as a new **Phase 3c** in the implement pipeline, inserted between the existing Phase 3b (developer implementation) and Phase 4 (merge and review).

```
Current pipeline:
  Phase 3b: Developer  →  Phase 4: Merge & Review

After this change:
  Phase 3b: Developer  →  Phase 3c: Test Writer  →  Phase 4: Merge & Review
```

The test-writer receives the implementation output as context (list of files created/modified), reads existing tests for pattern matching, detects the framework, and writes new test files. It never modifies implementation files.

---

## Framework Detection

Framework detection is performed by the agent at the start of its run. It reads standard manifest files and infers the test runner and conventions:

| Manifest File | Detected Framework | Test Runner Command |
|---------------|-------------------|---------------------|
| `package.json` (has `jest` in devDeps or scripts) | Jest | `npx jest` / `npm test` |
| `package.json` (has `vitest` in devDeps or scripts) | Vitest | `npx vitest` |
| `package.json` (has `mocha`) | Mocha | `npx mocha` |
| `requirements.txt` or `pyproject.toml` | pytest | `pytest` |
| `Gemfile` (has `rspec`) | RSpec | `bundle exec rspec` |
| `go.mod` | Go test | `go test ./...` |
| `Cargo.toml` | Rust/cargo | `cargo test` |
| `composer.json` (has `phpunit`) | PHPUnit | `./vendor/bin/phpunit` |

Detection is sequential: the agent reads files top-to-bottom from this table and stops on the first match. If no manifest file is found or no framework is identified, the agent writes a `TEST_FRAMEWORK_UNKNOWN.md` note and stops gracefully without blocking the pipeline.

### Pattern Learning

Before generating any tests, the agent reads existing test files to understand:
- File naming convention (`*.test.ts`, `*_test.go`, `test_*.py`, `*_spec.rb`)
- Directory structure (co-located vs. dedicated `tests/` directory)
- Import style and assertion library (`expect`, `assert`, `should`)
- Test block structure (`describe`/`it`, `test`, `func Test*`, `context`/`it`)
- Fixture and mock patterns

The agent reads up to 3 representative existing test files as pattern examples. It selects files that are closest in layer to the newly implemented code.

---

## Agent Prompt Structure

### File: `templates/agents/test-writer.md`

YAML frontmatter:
```yaml
---
name: test-writer
description: "..."
model: sonnet
color: cyan
memory: project
---
```

Color choice: `cyan` — distinguishes the test-writer from the developer (purple) and reviewer (red) while maintaining visual coherence in the pipeline.

### Placeholders

| Placeholder | Description | Resolved to (specrails) |
|-------------|-------------|-------------------------|
| `{{TECH_EXPERTISE}}` | Tech expertise list | specrails' own language list |
| `{{LAYER_CLAUDE_MD_PATHS}}` | Layer-specific CLAUDE.md paths | `.claude/rules/*.md` |
| `{{MEMORY_PATH}}` | Agent memory directory | `.claude/agent-memory/test-writer/` |

Note: `{{IMPLEMENTED_FILES_LIST}}` and `{{TASK_DESCRIPTION}}` appear in the prompt as instructional references (runtime-injected by the orchestrator) — they are not static substitution targets.

### Prompt Sections

1. **Identity**: "You are a specialist test engineer. Your only job is to write tests..."
2. **What you receive**: Implemented files list, task description, existing test patterns
3. **Framework detection protocol**: Ordered manifest-reading procedure
4. **Pattern learning protocol**: How to read existing tests before writing new ones
5. **Test generation mandate**: Unit, integration, edge case, error handling. Target: >80% coverage of new code
6. **Test writing rules**: Never modify implementation files. One test file per implementation file (or follow project convention). Follow exact naming and structure of existing tests.
7. **Untestable code protocol**: If code structure prevents unit testing (no dependency injection, global state, etc.), write an `# UNTESTABLE: <reason>` comment at the top of what you would have written, then write the best-effort test.
8. **Output format**: List of test files written with brief description of what each covers
9. **Memory protocol**: Using `{{MEMORY_PATH}}`

---

## Pipeline Integration

### Phase 3c: Test Writing

The new phase is inserted in `templates/commands/implement.md` after Phase 3b (Implement) and before Phase 4 (Merge & Review).

#### Positioning

```
## Phase 3b: Implement
[...existing content unchanged...]

## Phase 3c: Write Tests     ← NEW

## Phase 4: Merge & Review
[...existing content unchanged...]
```

#### Phase 3c Behavior

**Single-feature mode (`SINGLE_MODE=true`):**
- After the developer agent completes in Phase 3b, launch a single `test-writer` agent in the foreground.
- Pass to the agent:
  - `IMPLEMENTED_FILES_LIST`: the list of files the developer created or modified
  - `TASK_DESCRIPTION`: the original task description / feature spec
- Wait for the test-writer to complete before proceeding to Phase 4.

**Multi-feature mode (worktrees):**
- After all developer worktrees complete (Phase 3b), launch one `test-writer` agent per feature, each in its corresponding worktree (`isolation: worktree`, `run_in_background: true`).
- Each agent receives the `IMPLEMENTED_FILES_LIST` for its own feature only.
- Wait for all test-writer agents to complete before proceeding to Phase 4.

**Dry-run mode (`DRY_RUN=true`):**
Apply the same dry-run redirect as the developer:
> IMPORTANT: This is a dry-run. Write all new or modified test files under `.claude/.dry-run/<feature-name>/`. Mirror the real destination path within this directory. Append each file to `.cache-manifest.json`.

**If test-writer fails or times out:**
- Log the failure in the Phase 4e report under the `Tests` column as `FAILED`.
- Do NOT block Phase 4 (merge and review). Proceed without tests.
- Rationale: A missing test pass is preferable to blocking a valid implementation. The reviewer will note the coverage gap.

#### Report Table Update

The Phase 4e report table already contains a `Tests` column stub (after `Security`). This change **reorders** it to appear between `Developer` and `Reviewer`, reflecting the actual pipeline execution order:

**Current:**
```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Security | Tests | CI | Status |
```

**After:**
```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

`Tests` column values: `ok` (test files written), `FAILED` (agent failed or timed out), `SKIPPED` (no test framework detected).

---

## File Changes Summary

### New Files

| File | Description |
|------|-------------|
| `templates/agents/test-writer.md` | Canonical test-writer agent template |
| `.claude/agents/test-writer.md` | Generated specrails instance |
| `.claude/agent-memory/test-writer/MEMORY.md` | Initial empty memory file |

### Modified Files

| File | Change |
|------|--------|
| `templates/commands/implement.md` | Add Phase 3c, update Phase 4e table |
| `.claude/commands/implement.md` | Same changes applied to generated copy |

---

## Design Decisions and Rationale

### Always-on vs. optional flag

The test-writer runs unconditionally — no `--skip-tests` flag is provided. Rationale:

1. Making it optional creates a habit of opting out. The pipeline's value proposition is that it handles the full development lifecycle.
2. The fail-graceful behavior (if agent fails, pipeline continues) already handles the edge case where tests can't be generated.
3. If a project has no test framework at all, the agent detects this and outputs `SKIPPED` — zero disruption.

If a specific case arises requiring opt-out, that is a Phase 2 enhancement.

### Test-writer runs after each developer, not after all developers

In multi-feature mode, each test-writer is scoped to its own worktree and its own feature's implemented files. Running a single test-writer over all features at once would require merging context that isn't yet merged, producing cross-feature confusion. The worktree-local approach mirrors how the developer works.

### Test-writer does not run tests

The agent writes test files. The reviewer runs the test suite via CI checks. This separation keeps the test-writer focused on generation quality and keeps the reviewer as the authoritative quality gate. Running tests inside the test-writer would require the agent to know the full CI invocation, handle failures, and potentially modify both tests and implementation — collapsing two distinct concerns.

### Framework detection is agent-side, not orchestrator-side

The orchestrator does not detect the framework and pass it in. The agent reads the manifest files itself. Rationale: the agent needs to read existing test patterns anyway (which requires file I/O), so combining detection with pattern learning in a single reading phase is more efficient. It also keeps the orchestrator prompt simpler.

---

## Edge Cases

- **No existing test files**: Agent uses framework defaults (standard describe/it blocks, standard import style). It cannot learn from examples that don't exist, so it notes "No existing test files found — using framework defaults."
- **Mixed frameworks** (e.g., Jest for frontend, pytest for backend): Agent detects both based on the layer of the files it's testing and writes tests in the appropriate framework per file.
- **Generated/scaffold files**: If an implemented file is auto-generated (e.g., a migration file, a type declaration file), the agent skips it and notes the skip in its output.
- **Dry-run + test-writer**: Test files land in the dry-run cache alongside developer files. The `.cache-manifest.json` receives entries for test files just like implementation files.
