---
change: agent-failure-learning
type: design
---

# Technical Design: Agent Post-Mortem & Failure Learning Loop

## Architecture Overview

This feature is entirely markdown + JSON — no new binaries, shell scripts, or external tools. It extends two existing agent templates with new behavioral instructions and establishes a shared directory as the failure store.

The write path (reviewer → failures store) and read path (failures store → developer) are both agent-side operations: the agents read and write files using their existing file I/O capabilities. The orchestrator (implement.md) is not involved.

```
Reviewer detects failure
        │
        ▼
Writes JSON record to .claude/agent-memory/failures/<timestamp>-<slug>.json
        │
        ▼ (next feature implementation)
Developer reads recent records matching current file patterns
        │
        ▼
Adds explicit guardrails to implementation approach
```

---

## Failure Record Schema

Each failure record is a JSON file. The filename encodes both when the failure occurred and a short slug for human readability.

### Filename convention

```
.claude/agent-memory/failures/<ISO8601-date>-<slug>.json
```

Examples:
```
.claude/agent-memory/failures/2026-03-14-shell-unquoted-variable.json
.claude/agent-memory/failures/2026-03-15-placeholder-not-resolved.json
```

The slug is kebab-case, derived from the `error_type` field. Using the date prefix keeps records naturally sorted by recency (most recent last) and makes manual inspection straightforward.

### JSON schema

```json
{
  "agent": "reviewer",
  "timestamp": "2026-03-14T10:23:00Z",
  "feature": "automated-test-writer",
  "error_type": "shell-quoting-error",
  "root_cause": "Variable $TARGET_DIR used without quotes in install.sh line 42, causing word-splitting when path contains spaces.",
  "file_pattern": "*.sh",
  "prevention_rule": "Always quote shell variables: use \"$VAR\" not $VAR. Apply to every variable in shell scripts, including loop variables and function arguments.",
  "severity": "error"
}
```

### Field descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | yes | Always `"reviewer"` — the only agent that writes records |
| `timestamp` | string | yes | ISO 8601 UTC timestamp of the review session |
| `feature` | string | yes | Kebab-case feature name from the OpenSpec change (e.g., `"automated-test-writer"`) |
| `error_type` | string | yes | Kebab-case error category. See canonical list below. |
| `root_cause` | string | yes | Concrete description of what went wrong and where. Include file and line if known. |
| `file_pattern` | string | yes | Glob pattern of files this failure class is most likely to appear in (e.g., `"*.sh"`, `"templates/agents/*.md"`, `"*.ts"`). Used by the developer to determine relevance. |
| `prevention_rule` | string | yes | Actionable sentence the developer can apply proactively. Written as an imperative: "Always...", "Never...", "Before X, do Y". |
| `severity` | string | yes | `"error"` (CI failed) or `"warning"` (CI passed but issue noted). |

### Canonical `error_type` values

The reviewer MUST use one of these values, or coin a new kebab-case value if none fits:

| Value | Meaning |
|-------|---------|
| `shell-quoting-error` | Unquoted variables or paths in shell scripts |
| `unresolved-placeholder` | `{{PLACEHOLDER}}` string present in generated (non-template) file |
| `broken-frontmatter` | YAML frontmatter missing required field or malformed |
| `test-failure` | A test case failed CI |
| `lint-error` | Lint check failed (shellcheck, markdownlint, etc.) |
| `missing-set-flags` | Shell script missing `set -euo pipefail` |
| `naming-convention` | File or variable name violates kebab-case or convention |
| `import-error` | Import or require statement broken or circular |
| `security-issue` | Security scan finding (complement to security-reviewer) |
| `merge-conflict-marker` | Conflict marker (`<<<<<<<`) left in committed file |

---

## Failure Store Directory

```
.claude/agent-memory/failures/
├── README.md                                        # Schema documentation
└── <ISO8601-date>-<slug>.json                      # One file per failure record
```

The directory is in `.claude/agent-memory/` which, by the existing conventions of all agent memory directories, is:
- Part of the repo (tracked in git if the team chooses to, excluded if not)
- Writable by agents during their run
- Readable by any agent in any subsequent run

No `.gitignore` change is required by this feature. The existing `.claude/agent-memory/` tracking policy of the target repo applies.

---

## Reviewer Agent Changes

### Current state

`templates/agents/reviewer.md` has a `## Rules` section and a `## Workflow` section. The workflow ends at "Report" with no post-report actions.

### New section: Write Failure Records

A new section is appended after the `## Workflow` section (before `## Output Format`) in both the template and the generated instance:

```markdown
## Write Failure Records

After completing the review report, for each distinct failure category found (not each individual instance — one record per class of failure):

1. Create a JSON file at `.claude/agent-memory/failures/<YYYY-MM-DD>-<error-type-slug>.json`.
2. Populate all fields using the schema defined in `.claude/agent-memory/failures/README.md`.
3. Write `root_cause` based on what you actually observed — be specific (include file and line number if known).
4. Write `prevention_rule` as an actionable imperative the next developer can follow.
5. Set `file_pattern` to the glob that best matches where this class of failure appears.

### When to write a record

Write a record when:
- A CI check failed and required a fix
- A lint rule was violated
- A test case failed
- A placeholder was not resolved in a generated file
- A shell script had quoting, escaping, or flag issues

Do NOT write a record when:
- You found no failures (all CI checks passed on first run)
- A failure was a transient environment issue (e.g., network timeout), not a code issue
- The failure has an identical record already written in `.claude/agent-memory/failures/` from a recent run (check by scanning existing files)

### Idempotency

Before writing a new record, scan `.claude/agent-memory/failures/` for any file where `error_type` matches and the `prevention_rule` is substantively identical. If found, skip writing a new record. Do not create duplicates for the same known pattern.
```

### Placement rationale

Appending after `## Workflow` (before `## Output Format`) places it logically: the reviewer completes its review workflow, produces the report, then writes failure records as a closing action. This ordering ensures the reviewer has a complete picture of all failures before deciding which to record.

---

## Developer Agent Changes

### Current state

`templates/agents/developer.md` has a `## Workflow Protocol` section with Phase 1 (Understand), Phase 2 (Plan), Phase 3 (Implement), Phase 4 (Verify). Phase 1 currently instructs the developer to read: the OpenSpec change spec, base specs, layer CLAUDE.md files, and existing code patterns.

### New step in Phase 1: Read Recent Failures

A new bullet point is added to Phase 1 (Understand), after the existing reading steps and before "Identify all files that need to be created or modified":

```markdown
- **Read recent failure records**: Check `.claude/agent-memory/failures/` for any JSON records where `file_pattern` matches files you will be creating or modifying. For each matching record, add the `prevention_rule` as an explicit guardrail in your implementation plan. If the directory does not exist or is empty, proceed normally — this is expected on fresh installs.
```

### Behavior when no records exist

The instruction explicitly handles the empty-directory case gracefully: "If the directory does not exist or is empty, proceed normally." This ensures zero behavioral change for new installs or repos with no failures yet.

### Matching logic

The developer uses its own judgment to match `file_pattern` globs against the files it expects to create or modify (derived from reading the tasks.md). This is intentionally agent-side reasoning, not a shell glob expansion — the developer reads the records and applies contextual judgment about which patterns are relevant.

---

## Files Changed Summary

### New Files

| File | Description |
|------|-------------|
| `.claude/agent-memory/failures/README.md` | Schema documentation for the failure store |

### Modified Files

| File | Change |
|------|--------|
| `templates/agents/reviewer.md` | Add "Write Failure Records" section after `## Workflow` |
| `.claude/agents/reviewer.md` | Same change applied to generated instance |
| `templates/agents/developer.md` | Add failure-record reading step to Phase 1 |
| `.claude/agents/developer.md` | Same change applied to generated instance |

---

## Design Decisions and Rationale

### JSON over Markdown for failure records

Failure records are JSON rather than Markdown because the developer agent needs to extract specific fields (`file_pattern`, `prevention_rule`) programmatically — by reading the file and applying matching logic. JSON makes the field extraction unambiguous. Markdown narrative notes (like `common-fixes.md`) are written for human scanning, not field extraction.

### One file per failure record, not a single append file

A single append file (like `failures.jsonl`) would create merge conflicts when multiple reviewers write simultaneously (multi-feature mode). One file per record avoids all write contention. It also makes idempotency checking straightforward: scan filenames or scan the `error_type` field in existing files.

### One record per failure class, not per instance

Recording every line where a quoting error appears would produce noisy, redundant records. The reviewer writes one record per failure class per review session. The `prevention_rule` covers the class, not the instance.

### Developer reads records, reviewer writes records — no cross-reading

The reviewer does not read existing failure records before reviewing (its job is to catch what is there). The developer reads records before implementing (its job is prevention). This clear separation avoids the reviewer modifying its behavior based on its own past records, which could introduce blind spots.

### No expiry or archival mechanism

In the pre-code phase, automatic expiry adds complexity with unclear benefit. Old records with accurate `prevention_rule` values remain useful indefinitely. Records that become stale (e.g., a lint rule was removed) can be deleted manually. Phase 2 can add a `last_seen` field and archival logic.

### Failures directory in `.claude/agent-memory/`, not a new top-level path

Placing failures under the existing `agent-memory/` tree keeps the directory structure consistent with the established pattern (each logical memory domain has a directory). A new top-level `.claude/failures/` path would require install.sh updates and documentation changes across multiple files.

---

## Edge Cases

- **Multi-feature mode**: Multiple reviewer instances run concurrently (each in its own worktree). Each reviewer writes to the same `.claude/agent-memory/failures/` directory. Since each record is a separate file with a unique timestamped name, there is no write conflict.
- **First run / empty store**: Developer's instruction says "if the directory does not exist or is empty, proceed normally." Zero behavior change.
- **Reviewer finds no failures**: The "When to write a record" section explicitly covers this: if all CI checks passed on first run, no records are written.
- **Reviewer finds 10+ failure instances of the same class**: Reviewer writes one record per class (not per instance), as specified by "one record per category found."
- **Duplicate record prevention**: Reviewer scans existing records for matching `error_type` + `prevention_rule` before writing. If substantively identical, it skips. This keeps the store lean over time.
