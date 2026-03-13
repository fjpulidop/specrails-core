---
name: common-fixes
description: Recurring CI failure patterns and their fixes found during code reviews
type: project
---

# Common Fixes

## Placeholder grep false positives

**Pattern:** `grep -r '{{[A-Z_]*}}' .claude/agents/` flags existing agent files (reviewer.md, architect.md, developer.md, rules/templates.md) that contain `{{PLACEHOLDER}}` in documentation prose — not as unresolved substitutions.

**Why:** These files use the `{{...}}` notation to document the convention itself ("use `{{UPPER_SNAKE_CASE}}` for placeholders"). They are not broken.

**How to apply:** When the placeholder check flags hits in existing (non-newly-generated) files, confirm the match is in a documentation context (backtick-quoted or descriptive sentence) rather than a bare value. Only flag bare `{{WORD}}` usages outside of documentation/example prose.

---

## Template vs instance placeholder count

**Pattern:** Template agent files should contain exactly the documented placeholders (e.g., `{{TECH_EXPERTISE}}`, `{{LAYER_CLAUDE_MD_PATHS}}`, `{{MEMORY_PATH}}`). The generated instance must contain zero `{{...}}` strings.

**Verification command:**
```bash
grep -c '{{' templates/agents/<name>.md   # should equal expected count
grep -c '{{' .claude/agents/<name>.md     # must be 0
```

---

## shellcheck not installed

**Pattern:** `shellcheck` is not in PATH on this machine. The check exits with "command not found" but is treated as non-fatal (`|| true`).

**How to apply:** Until shellcheck is installed, the shell validation check is advisory only. Manual review of `set -euo pipefail`, quoted variables, and `local` usage in shell scripts is required.
