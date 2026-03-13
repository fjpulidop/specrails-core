---
change: automated-test-writer
type: context-bundle
---

# Context Bundle: Automated Test Writer Agent

This document contains everything a developer needs to implement this change without reading any other file. It bundles key context from the design, delta-spec, and codebase exploration.

---

## What You Are Building

A new Claude Code agent called `test-writer` that:
1. Detects the target repo's test framework from standard manifest files
2. Reads existing test files to learn the project's test patterns
3. Generates unit tests, integration tests, edge case tests, and error handling tests for newly implemented code
4. Targets >80% coverage of new code
5. Integrates into the implement pipeline as **Phase 3c**, running after the developer (Phase 3b) and before the reviewer (Phase 4)
6. Is non-blocking on failure — if the agent fails, the pipeline continues

The agent is a **markdown prompt file** — no shell scripts, no external tool dependencies. All test generation happens through Claude's code analysis.

---

## Codebase Patterns to Follow

### Agent file structure

All agents follow this pattern. Study `templates/agents/security-reviewer.md` for a clean recent example of the template, and `.claude/agents/security-reviewer.md` for the generated instance.

**Template file** (`templates/agents/*.md`): Uses `{{PLACEHOLDER}}` for values that vary per target repo.

**Generated file** (`.claude/agents/*.md`): Same content with placeholders substituted.

YAML frontmatter required fields:
```yaml
---
name: <kebab-case-name>
description: "Multi-line string with usage examples"
model: sonnet
color: <color-name>
memory: project
---
```

Color `cyan` is assigned to the test-writer. It is not used by any existing agent:
- `green` — architect
- `purple` — developer
- `red` — reviewer
- `orange` — security-reviewer
- `cyan` — test-writer (new)

### Placeholders in templates

Templates use `{{UPPER_SNAKE_CASE}}` for static substitution by `install.sh`. The specrails-instance values for the test-writer are:

| Placeholder | Resolved value |
|-------------|---------------|
| `{{TECH_EXPERTISE}}` | (see below) |
| `{{LAYER_CLAUDE_MD_PATHS}}` | `.claude/rules/*.md` |
| `{{MEMORY_PATH}}` | `.claude/agent-memory/test-writer/` |

For `{{TECH_EXPERTISE}}`, match what `.claude/agents/developer.md` uses:
```
- **Shell scripting**: Bash, POSIX sh, installers, CLI tools
- **TypeScript/JavaScript**: Node.js, CLI frameworks (commander, oclif, yargs), npm packaging
- **Template systems**: Markdown templates with placeholder substitution, code generation
- **Developer tooling**: CI/CD pipelines, GitHub Actions, package distribution
- **AI prompt engineering**: Claude Code agents, structured prompts, multi-agent orchestration
```

**Runtime-injected values** — these are NOT substitution targets. They appear in the prompt body as instructional references (plain text, not `{{...}}`):
- `IMPLEMENTED_FILES_LIST` — injected by the orchestrator at invocation time
- `TASK_DESCRIPTION` — injected by the orchestrator at invocation time

### Memory pattern

Every agent has a memory directory with an initial `MEMORY.md` file:
```
.claude/agent-memory/<agent-name>/MEMORY.md
```

Header content:
```markdown
# Test Writer Agent Memory

No memories recorded yet.
```

### Implement command structure

`templates/commands/implement.md` is a long Markdown document describing the pipeline phases. The existing phase structure:

```
Phase -1: Environment Setup
Phase 0:  Parse input and determine mode
Phase 1:  Explore (parallel)
Phase 2:  Select
Phase 3a: Architect (parallel, in main repo)
Phase 3b: Implement
           ← INSERT Phase 3c: Write Tests HERE
Phase 4:  Merge & Review
  4a. Merge worktree changes
  4b. Launch Reviewer agent
  4b-sec. Launch Security Reviewer agent
  4c. Ship
  4d. Monitor CI
  4e. Report
```

Phase 3c is inserted between the final line of Phase 3b ("Wait for all developers to complete.") and the `## Phase 4: Merge & Review` heading.

The Phase 4e report table already has both `Security` and `Tests` columns (stubs added by prior changes). The table currently reads:
```
| Area | Feature | Change Name | Architect | Developer | Reviewer | Security | Tests | CI | Status |
```

After this change it should read:
```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

This is a **column reorder**, not an addition. `Tests` moves from after `Security` to between `Developer` and `Reviewer`, to reflect execution order in the pipeline.

---

## Files to Create or Modify

### Create (new files)

| Path | Description |
|------|-------------|
| `templates/agents/test-writer.md` | Canonical agent template with `{{PLACEHOLDER}}` syntax |
| `.claude/agents/test-writer.md` | Generated specrails instance with placeholders resolved |
| `.claude/agent-memory/test-writer/MEMORY.md` | Initial empty memory file |

### Modify (existing files)

| Path | Change |
|------|--------|
| `templates/commands/implement.md` | Insert Phase 3c after Phase 3b; update Phase 4e table |
| `.claude/commands/implement.md` | Same changes applied to generated copy |

---

## Phase 3c Content to Insert

Insert the following Markdown block into both `templates/commands/implement.md` and `.claude/commands/implement.md`, immediately after the "Wait for all developers to complete." line of Phase 3b:

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

---

## Framework Detection Table (for agent prompt)

The agent prompt must include this detection logic:

| Manifest File | Framework | Test runner |
|---------------|-----------|-------------|
| `package.json` — `jest` in scripts/devDeps | Jest | `npx jest` / `npm test` |
| `package.json` — `vitest` in scripts/devDeps | Vitest | `npx vitest` |
| `package.json` — `mocha` in scripts/devDeps | Mocha | `npx mocha` |
| `requirements.txt` or `pyproject.toml` present | pytest | `pytest` |
| `Gemfile` with `rspec` | RSpec | `bundle exec rspec` |
| `go.mod` present | Go test | `go test ./...` |
| `Cargo.toml` present | cargo test | `cargo test` |
| `composer.json` with `phpunit` | PHPUnit | `./vendor/bin/phpunit` |

Detection is sequential: stop at first match.

---

## Key Design Decisions (Do Not Deviate)

1. **Test-writer is always-on** — no flag to disable it. If framework detection fails, the agent outputs `SKIPPED` and continues. Do not add a `--skip-tests` flag.

2. **Test-writer does NOT run tests** — writing only. Running tests is the reviewer's job via CI checks.

3. **Test-writer does NOT modify implementation files** — generating untestable code is flagged, not fixed.

4. **One test-writer per feature in multi-feature mode** — scoped to its own worktree, not a single agent over all features.

5. **Non-blocking failure** — if the agent fails, Phase 4 continues. The reviewer notes the gap.

6. **Color is `cyan`** — do not change this to an already-used color.

---

## Verification Checklist

Before considering this change complete:

- [ ] `templates/agents/test-writer.md` exists and has valid YAML frontmatter
- [ ] `templates/agents/test-writer.md` contains exactly these placeholders: `{{TECH_EXPERTISE}}`, `{{LAYER_CLAUDE_MD_PATHS}}`, `{{MEMORY_PATH}}`
- [ ] `.claude/agents/test-writer.md` exists with no unresolved `{{...}}` strings
- [ ] `.claude/agent-memory/test-writer/MEMORY.md` exists
- [ ] `templates/commands/implement.md` has a `## Phase 3c: Write Tests` section positioned between Phase 3b and Phase 4
- [ ] `.claude/commands/implement.md` has the same Phase 3c section
- [ ] Phase 4e report table in both implement files includes `Tests` column between `Developer` and `Reviewer`
- [ ] `grep -r '{{[A-Z_]*}}' .claude/agents/test-writer.md` returns no output
