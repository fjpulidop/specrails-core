---
change: agent-failure-learning
type: tasks
---

# Tasks: Agent Post-Mortem & Failure Learning Loop

Tasks are ordered by dependency. Each task has a layer tag, description, files involved, and acceptance criteria.

---

## Task 1 — Create the failure store directory and README [core]

**Description:** Create the shared failure store at `.claude/agent-memory/failures/` with a `README.md` documenting the JSON schema. This is the foundational artifact — all other tasks reference it.

**Files:**
- Create: `.claude/agent-memory/failures/README.md`

**Content to write:**

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

**Acceptance criteria:**
- File exists at `.claude/agent-memory/failures/README.md`
- README contains the full JSON schema table with all 8 fields
- README contains the canonical `error_type` value list (all 10 values)
- README contains the filename convention
- README contains the example JSON record
- README is valid Markdown with no broken formatting

**Dependencies:** None (can start immediately)

---

## Task 2 — Add "Write Failure Records" section to the reviewer template [templates]

**Description:** Modify `templates/agents/reviewer.md` to add a "Write Failure Records" section. This section is appended after the `## Workflow` section and before `## Output Format`. Do not modify any other existing content.

**Files:**
- Modify: `templates/agents/reviewer.md`

**Exact insertion point:** After the last line of the `## Workflow` section (the line reading "4. **Report** a summary of what passed, what failed, and what you fixed") and before the `## Output Format` heading.

**Content to insert:**

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

**Acceptance criteria:**
- `## Write Failure Records` section exists in `templates/agents/reviewer.md`
- Section is positioned after `## Workflow` and before `## Output Format`
- Section includes: step-by-step write procedure, "When to write" conditions, idempotency rule
- All existing content is preserved unchanged (no existing lines removed or modified)
- No `{{PLACEHOLDER}}` strings are introduced or broken

**Dependencies:** Task 1 (references README path)

---

## Task 3 — Update the generated reviewer instance [templates]

**Description:** Apply the same "Write Failure Records" section from Task 2 to `.claude/agents/reviewer.md`. This is the specrails-instance copy — it has all placeholders already resolved. Apply the identical section content.

**Files:**
- Modify: `.claude/agents/reviewer.md`

**Specific change:** Insert the same `## Write Failure Records` section (verbatim from Task 2's content block) at the same logical position: after `## Workflow`, before `## Output Format`.

**Acceptance criteria:**
- `## Write Failure Records` section exists in `.claude/agents/reviewer.md`
- Section is positioned after `## Workflow` and before `## Output Format`
- No unresolved `{{PLACEHOLDER}}` strings are present in this file (run verification)
- Content is substantively identical to what was inserted in `templates/agents/reviewer.md`

**Dependencies:** Task 2 (content established by template edit)

---

## Task 4 — Add "Read Recent Failures" step to the developer template [templates]

**Description:** Modify `templates/agents/developer.md` to add a failure-record reading step to Phase 1 (Understand). This is a surgical insertion of one bullet point — do not restructure Phase 1 or any surrounding content.

**Files:**
- Modify: `templates/agents/developer.md`

**Exact insertion point:** In `## Phase 1: Understand` (within `## Workflow Protocol`), after the existing bullet that reads "Read layer-specific CLAUDE.md files..." and before the bullet "Identify all files that need to be created or modified".

**Content to insert (one bullet point):**

```markdown
- **Read recent failure records**: Check `.claude/agent-memory/failures/` for JSON records where `file_pattern` matches files you will create or modify. For each matching record, treat `prevention_rule` as an explicit guardrail in your implementation plan. If the directory does not exist or is empty, proceed normally — this is expected on fresh installs.
```

**Acceptance criteria:**
- The new bullet exists in the Phase 1 list inside `templates/agents/developer.md`
- It is positioned after the CLAUDE.md reading step and before the "Identify all files" step
- Existing bullets are unchanged and in the same order
- The instruction explicitly handles the empty/missing directory case ("proceed normally")
- No `{{PLACEHOLDER}}` strings are introduced or broken

**Dependencies:** Task 1 (references the failure store path)

---

## Task 5 — Update the generated developer instance [templates]

**Description:** Apply the same Phase 1 addition from Task 4 to `.claude/agents/developer.md`. This is the specrails-instance copy with all placeholders resolved.

**Files:**
- Modify: `.claude/agents/developer.md`

**Specific change:** Insert the same bullet point (verbatim from Task 4's content) at the same logical position within Phase 1 (Understand).

**Acceptance criteria:**
- The new bullet exists in Phase 1 of `.claude/agents/developer.md`
- Positioned correctly: after the CLAUDE.md reading step, before the "Identify all files" step
- No unresolved `{{PLACEHOLDER}}` strings remain in this file
- Content is substantively identical to what was inserted in `templates/agents/developer.md`

**Dependencies:** Task 4 (content established by template edit)

---

## Task 6 — Verify no broken placeholders in modified generated files [core]

**Description:** Run placeholder integrity checks on both modified generated agent files. Confirm no unresolved `{{PLACEHOLDER}}` strings are present.

**Files:** Read-only verification

**Commands:**

```bash
grep -r '{{[A-Z_]*}}' /path/to/repo/.claude/agents/reviewer.md 2>/dev/null || echo "OK: reviewer clean"
grep -r '{{[A-Z_]*}}' /path/to/repo/.claude/agents/developer.md 2>/dev/null || echo "OK: developer clean"
```

Expected output for each: `OK: <agent> clean`

**Acceptance criteria:**
- Both greps return no matches (or echo "OK")
- If matches are found: fix the offending file before considering this task done
- Note: false positives from documentation prose (backtick-quoted `{{PLACEHOLDER}}` in descriptive sentences) are acceptable; bare `{{WORD}}` outside of documentation context are not

**Dependencies:** Tasks 3 and 5

---

## Execution Order

```
Task 1 (failures/README.md)
    │
    ├──> Task 2 (reviewer template)  ──> Task 3 (reviewer instance)
    │                                                │
    └──> Task 4 (developer template) ──> Task 5 (developer instance)
                                                     │
                                              Task 6 (verify both)
```

Tasks 2 and 4 can run in parallel (both depend on Task 1 only). Tasks 3 and 5 can run in parallel once their respective template tasks complete. Task 6 is the final gate.

### Minimum critical path

Task 1 → Task 2 → Task 3 → Task 6 (reviewer path, plus Task 4 → Task 5 in parallel)
