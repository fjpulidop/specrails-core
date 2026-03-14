---
change: agent-failure-learning
type: context-bundle
---

# Context Bundle: Agent Post-Mortem & Failure Learning Loop

This document contains everything a developer needs to implement this change without reading any other file.

---

## What You Are Building

A lightweight failure learning loop between the reviewer and developer agents:

1. After the reviewer fixes CI failures, it writes structured JSON records to `.claude/agent-memory/failures/`.
2. Before the developer starts implementing, it reads those records and treats matching ones as proactive guardrails.
3. A `README.md` in the failures directory documents the schema for human and agent reference.

No new agents. No new pipeline phases. No new shell scripts. This is entirely a markdown + JSON change to two existing agent templates and their generated instances, plus one new directory with one new file.

---

## Files to Create or Modify

### Create (new files)

| Path | Description |
|------|-------------|
| `.claude/agent-memory/failures/README.md` | Schema documentation for the failure store |

### Modify (existing files)

| Path | Change | Notes |
|------|--------|-------|
| `templates/agents/reviewer.md` | Add `## Write Failure Records` section | After `## Workflow`, before `## Output Format` |
| `.claude/agents/reviewer.md` | Same section, verbatim | Generated instance — no `{{PLACEHOLDER}}` strings allowed |
| `templates/agents/developer.md` | Add one bullet to Phase 1 (Understand) | After CLAUDE.md reading step, before "Identify all files" |
| `.claude/agents/developer.md` | Same bullet, verbatim | Generated instance — no `{{PLACEHOLDER}}` strings allowed |

### Do NOT modify

- `install.sh` — no new directory scaffolding needed; the failures dir is created on first reviewer write
- `templates/commands/implement.md` or `.claude/commands/implement.md` — no pipeline phase changes
- Any other agent template (`test-writer.md`, `security-reviewer.md`, `architect.md`, etc.)
- `openspec/specs/` — no spec file changes needed

---

## Current State of Files You Will Edit

### `templates/agents/reviewer.md` — structure

The file has this top-level section order:
```
[YAML frontmatter]
Identity paragraph
## Your Mission
## CI/CD Pipeline Equivalence
## Known CI vs Local Gaps
## Review Checklist
## Workflow
## Output Format
## Rules
## Critical Warnings
# Persistent Agent Memory
## MEMORY.md
```

You are inserting `## Write Failure Records` between `## Workflow` and `## Output Format`.

The end of `## Workflow` reads:
```
1. **Run all CI checks** (all layers, in the exact order CI runs them)
2. **If anything fails**: Fix it, then re-run ALL checks from scratch (not just the failing one)
3. **Repeat** up to 3 fix-and-verify cycles
4. **Report** a summary of what passed, what failed, and what you fixed
```

The `## Output Format` heading immediately follows. Insert the new section between step 4 of Workflow and the `## Output Format` heading.

### `templates/agents/developer.md` — structure

The file has this top-level section order:
```
[YAML frontmatter]
Identity paragraph
## Your Identity & Expertise
## Your Mission
## Workflow Protocol
  ### Phase 1: Understand
  ### Phase 2: Plan
  ### Phase 3: Implement
  ### Phase 4: Verify
## CI-Equivalent Verification Suite
## Code Quality Standards
## Critical Warnings
## Output Standards
## Update Your Agent Memory
# Persistent Agent Memory
## MEMORY.md
```

You are inserting one bullet into `### Phase 1: Understand`.

The current Phase 1 bullets read:
```
- Read the OpenSpec change spec thoroughly
- Read referenced base specs
- Read layer-specific CLAUDE.md files ({{LAYER_CLAUDE_MD_PATHS}})
- Identify all files that need to be created or modified
- Understand the data flow through the architecture
```

Insert the new bullet between "Read layer-specific CLAUDE.md files..." and "Identify all files...".

---

## Exact Content to Insert

### Into `templates/agents/reviewer.md` and `.claude/agents/reviewer.md`

Insert this block between `## Workflow` and `## Output Format`:

```markdown
## Write Failure Records

After completing the review report, for each distinct failure category found (one record per class of failure, not per instance):

1. Create a JSON file at `.claude/agent-memory/failures/<YYYY-MM-DD>-<error-type-slug>.json`.
2. Populate all fields using the schema in `.claude/agent-memory/failures/README.md`.
3. Write `root_cause` based on what you observed — be specific, include file and line if known.
4. Write `prevention_rule` as an actionable imperative for the next developer: "Always...", "Never...", "Before X, do Y".
5. Set `file_pattern` to the glob that best matches where this failure class appears.
6. Set `severity` to `"error"` if CI failed, `"warning"` if CI passed but you noted the issue.

### When to write a record

Write a record when you:
- Fixed a CI check failure
- Fixed a lint error
- Fixed a test failure
- Fixed an unresolved placeholder in a generated file
- Fixed a shell script quoting, escaping, or flag error

Do NOT write a record when:
- All CI checks passed on first run (no fixes required)
- The failure was a transient environment issue (network timeout, missing tool), not a code issue

### Idempotency

Before writing a new record, scan `.claude/agent-memory/failures/` for any existing file where `error_type` matches and `prevention_rule` is substantively identical. If found, skip — do not create duplicates for the same known pattern.
```

### Into `templates/agents/developer.md` and `.claude/agents/developer.md`

Insert this single bullet into Phase 1, after the CLAUDE.md reading step:

```markdown
- **Read recent failure records**: Check `.claude/agent-memory/failures/` for JSON records where `file_pattern` matches files you will create or modify. For each matching record, treat `prevention_rule` as an explicit guardrail in your implementation plan. If the directory does not exist or is empty, proceed normally — this is expected on fresh installs.
```

---

## Content for the New README

Write the following to `.claude/agent-memory/failures/README.md`:

```markdown
# Failure Record Store

This directory contains structured failure records written by the reviewer agent after each review session. The developer agent reads these records at the start of each implementation to add proactive guardrails.

## JSON Schema

Each record is a JSON file named `<YYYY-MM-DD>-<error-type-slug>.json`.

| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Always `"reviewer"` |
| `timestamp` | string | ISO 8601 UTC timestamp of the review session |
| `feature` | string | Kebab-case OpenSpec change name (e.g., `"automated-test-writer"`) |
| `error_type` | string | Kebab-case failure category (see list below) |
| `root_cause` | string | Concrete description of what went wrong; include file and line if known |
| `file_pattern` | string | Glob pattern of files this failure class is likely to appear in |
| `prevention_rule` | string | Actionable imperative the developer can apply ("Always...", "Never...") |
| `severity` | string | `"error"` (CI failed) or `"warning"` (CI passed, issue noted) |

## Canonical error_type Values

| Value | Meaning |
|-------|---------|
| `shell-quoting-error` | Unquoted variables or paths in shell scripts |
| `unresolved-placeholder` | `{{PLACEHOLDER}}` string in a generated (non-template) file |
| `broken-frontmatter` | YAML frontmatter missing required field or malformed |
| `test-failure` | A test case failed CI |
| `lint-error` | Lint check failed (shellcheck, markdownlint, etc.) |
| `missing-set-flags` | Shell script missing `set -euo pipefail` |
| `naming-convention` | File or variable name violates kebab-case or convention |
| `import-error` | Import or require statement broken or circular |
| `security-issue` | Security scan finding |
| `merge-conflict-marker` | Conflict marker (`<<<<<<<`) left in a committed file |

Use one of these values, or coin a new kebab-case value if none fits.

## Example Record

```json
{
  "agent": "reviewer",
  "timestamp": "2026-03-14T10:23:00Z",
  "feature": "automated-test-writer",
  "error_type": "shell-quoting-error",
  "root_cause": "Variable $TARGET_DIR used without quotes in install.sh line 42, causing word-splitting when the path contains spaces.",
  "file_pattern": "*.sh",
  "prevention_rule": "Always quote shell variables: use \"$VAR\" not $VAR. Apply to every variable in shell scripts, including loop variables and function arguments.",
  "severity": "error"
}
```

## Write Path

The reviewer agent writes to this directory after completing its review report. One file per failure class per session.

## Read Path

The developer agent reads from this directory during Phase 1 (Understand), before writing any code. Matching records (by `file_pattern`) become explicit implementation guardrails.
```

---

## Existing Patterns to Follow

### Agent template structure

Both `reviewer.md` and `developer.md` follow the same pattern as all other agent templates:
- YAML frontmatter block (do not modify)
- Prose identity paragraph (do not modify)
- Numbered/bulleted workflow sections (surgical insertion only)
- `# Persistent Agent Memory` section at the bottom (do not modify)

Study `templates/agents/test-writer.md` or `templates/agents/security-reviewer.md` for reference on how sections are laid out and how instructions are written in imperative style.

### Template vs. generated instance

`templates/agents/*.md` files are the canonical source. They contain `{{PLACEHOLDER}}` strings.

`.claude/agents/*.md` files are the generated instances. They have placeholders resolved. Never introduce `{{PLACEHOLDER}}` strings into generated instances.

The new content you are inserting contains no `{{PLACEHOLDER}}` strings — the failure store path (`.claude/agent-memory/failures/`) is a concrete resolved path, not a substitution target.

### Writing style for agent prompts

- Use imperative voice: "Write a record when you:", "Check the directory for..."
- Be concrete about paths — spell out the full relative path
- Handle edge cases inline ("If the directory does not exist or is empty, proceed normally")
- Keep sections cohesive — related instructions in one block, not scattered

---

## Conventions Checklist

Before marking this change complete, verify:

- [ ] `.claude/agent-memory/failures/README.md` exists with full schema, canonical error_type list, and example record
- [ ] `## Write Failure Records` section exists in `templates/agents/reviewer.md`, positioned after `## Workflow` and before `## Output Format`
- [ ] `## Write Failure Records` section exists in `.claude/agents/reviewer.md` at the same position
- [ ] Phase 1 (Understand) in `templates/agents/developer.md` contains the "Read recent failure records" bullet
- [ ] Phase 1 (Understand) in `.claude/agents/developer.md` contains the same bullet
- [ ] `grep -r '{{[A-Z_]*}}' .claude/agents/reviewer.md` returns no output (or reviewer's known doc-prose hits only)
- [ ] `grep -r '{{[A-Z_]*}}' .claude/agents/developer.md` returns no output (or developer's known doc-prose hits only)
- [ ] No other files were modified beyond those listed in "Files to Create or Modify"

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Inserting section in wrong position in reviewer.md | Low | Use the exact anchor text: "4. **Report** a summary of what passed..." followed by `## Output Format` |
| Developer prompt bullet inserted in wrong phase | Low | Verify it is inside `### Phase 1: Understand` not Phase 2 or Phase 3 |
| Placeholder false positive from grep check | Low | Reviewer/developer templates contain `{{PLACEHOLDER}}` in documentation prose — check that hits are backtick-quoted, not bare |
| Failure store growing unbounded over time | None now | Idempotency rule limits duplicates; archival is a Phase 2 concern |
| Multi-feature reviewer race on write | None | Each record is a separate file with unique name — no write conflict possible |
