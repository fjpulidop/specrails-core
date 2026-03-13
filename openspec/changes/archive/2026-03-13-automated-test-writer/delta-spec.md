---
change: automated-test-writer
type: delta-spec
---

# Delta Spec: Automated Test Writer Agent

This document describes the spec-level changes this feature introduces. It defines what the system should do after this change is applied, framed as additions and modifications to the existing conceptual specification.

---

## 1. New Capability: Test Writing Agent

**Spec statement:** The specrails agent system SHALL include a `test-writer` agent that generates comprehensive tests for code implemented by developer agents.

### 1.1 Agent identity

The `test-writer` agent:
- Has name `test-writer`
- Runs on model `sonnet`
- Color `cyan`
- Has persistent memory at `.claude/agent-memory/test-writer/`
- Is self-contained — requires no external binaries to perform its core function

### 1.2 Test writing scope

When invoked, the agent MUST:
- Receive a list of implemented files (`IMPLEMENTED_FILES_LIST`) via its invocation prompt
- Receive the task description (`TASK_DESCRIPTION`) for context on intended behavior
- Read existing test files to learn project test patterns before generating any tests
- Detect the test framework from standard manifest files
- Write test files only — never modify implementation files
- Target >80% coverage for all newly implemented code

### 1.3 Framework detection

The agent MUST detect the test framework by reading manifest files in this order of priority:
1. `package.json` — detect `jest`, `vitest`, or `mocha` in scripts or devDependencies
2. `requirements.txt` or `pyproject.toml` — infer pytest
3. `Gemfile` — detect `rspec`
4. `go.mod` — infer Go test
5. `Cargo.toml` — infer cargo test
6. `composer.json` — detect `phpunit`

If no framework is detected, the agent MUST output a `TEST_FRAMEWORK_UNKNOWN.md` file with an explanation and set its report status to `SKIPPED`. This MUST NOT block the pipeline.

### 1.4 Pattern learning

Before generating any tests, the agent MUST:
- Identify existing test files related to the layer being tested
- Read up to 3 representative existing test files
- Extract: file naming convention, directory structure, import style, assertion library, test block structure, fixture/mock patterns
- Apply those patterns to all generated tests

### 1.5 Test categories

For each implemented file, the agent MUST attempt to generate:
- Unit tests for all public functions and methods
- Integration tests for interactions between modules (where applicable)
- Edge case tests: null/empty inputs, boundary values, type coercion
- Error handling tests: expected exceptions, failure modes, invalid inputs

### 1.6 Untestable code handling

If an implemented file cannot be meaningfully unit-tested (global state, no dependency injection, etc.), the agent MUST:
- Write the best-effort test file
- Add a comment at the top of the test file: `# UNTESTABLE: <reason>`
- This file still counts as "written" in the output report

### 1.7 Output format

The agent MUST produce a summary listing:
- Each test file written and the path it was written to
- The framework detected
- The test patterns learned from existing files
- Any files skipped and the reason

---

## 2. Modified Capability: Implementation Pipeline (Phase 3)

**Spec statement:** Phase 3 of the implementation pipeline SHALL include a test-writing step (Phase 3c) that runs after developer implementation and before the merge and review phase.

### 2.1 Phase 3c execution

Phase 3 executes in this order:
1. Phase 3a: Architect — unchanged
2. Phase 3b: Implement (developer) — unchanged
3. Phase 3c: Write Tests — new

### 2.2 Test-writer invocation

The orchestrator MUST pass to the test-writer agent:
- `IMPLEMENTED_FILES_LIST`: all files created or modified by the developer in this feature
- `TASK_DESCRIPTION`: the original task/feature description that drove the implementation

### 2.3 Failure handling

If the test-writer agent fails or times out:
- The failure MUST be logged in the Phase 4e report under `Tests` as `FAILED`
- The pipeline MUST continue to Phase 4 (merge and review) — the test-writer failure is non-blocking
- The reviewer agent MUST note the missing test coverage in its review

### 2.4 Dry-run behavior

When `DRY_RUN=true`, the test-writer MUST:
- Write all test files under `.claude/.dry-run/<feature-name>/` mirroring real paths
- Append each written test file to `.cache-manifest.json` with `operation: "create"`

### 2.5 Multi-feature mode

In multi-feature mode (worktrees):
- One test-writer agent MUST be launched per feature, in its corresponding worktree
- Each test-writer operates on the files for its own feature only
- All test-writers run in background (`run_in_background: true`)
- Phase 4 begins only after all test-writers complete (or time out)

---

## 3. Modified Capability: Phase 4e Report

**Spec statement:** The Phase 4e pipeline report table SHALL include a `Tests` column showing the outcome of the test-writer phase.

### 3.1 Report table schema

The Phase 4e report table:

```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

### 3.2 Tests column values

| Value | Meaning |
|-------|---------|
| `ok` | Test-writer completed, test files written |
| `FAILED` | Test-writer agent failed or timed out |
| `SKIPPED` | No test framework detected |

---

## 4. New Artifact: Test Writer Agent Template

**Spec statement:** `templates/agents/test-writer.md` SHALL exist as a canonical template following the `{{PLACEHOLDER}}` convention used by all other agent templates.

### 4.1 Required placeholders

| Placeholder | Resolved to (specrails) |
|-------------|-------------------------|
| `{{TECH_EXPERTISE}}` | Specrails' full stack description |
| `{{LAYER_CLAUDE_MD_PATHS}}` | `.claude/rules/*.md` |
| `{{MEMORY_PATH}}` | `.claude/agent-memory/test-writer/` |

Runtime-injected values (not static substitution targets — appear as instructional references in the prompt body):
- `IMPLEMENTED_FILES_LIST`
- `TASK_DESCRIPTION`

### 4.2 Template conventions

The template MUST follow all conventions in `.claude/rules/agents.md`:
- YAML frontmatter with `name`, `description`, `model`, `color`, `memory`
- `description` field includes usage examples
- Agent is self-contained
- Output format is specified
- Memory protocol section matches other agents
