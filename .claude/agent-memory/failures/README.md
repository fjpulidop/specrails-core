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
