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

---

## Multi-file grep false positive — template vs instance

**Pattern:** When running `grep -n '{{[A-Z_]*}}'` across both template and instance directories in a single search, a hit in a template file (e.g., `templates/commands/update-product-driven-backlog.md`) can be mistakenly attributed to the adjacent instance file (`.claude/commands/update-product-driven-backlog.md`).

**Why:** The grep output shows the matching file path, but when mentally scanning multi-file results, it's easy to misread which file owns a given hit.

**How to apply:** Always run the placeholder check on the instance file in isolation:
```bash
grep -r '{{[A-Z_]*}}' .claude/commands/update-product-driven-backlog.md || echo "OK"
```
Never combine template and instance paths in a single grep for placeholder-clean assertions.

---

## find -name '*[A-Z]*' on macOS matches lowercase .md extensions

**Pattern:** On macOS with certain locale settings, `find -name '*[A-Z]*'` matches filenames like `reviewer.md` because the character range `[A-Z]` can match lowercase letters or punctuation under the default locale.

**Why:** macOS `find` uses locale-sensitive collation for character ranges. `[A-Z]` in some locales covers more than A–Z.

**How to apply:** File naming check results should be validated by inspecting the actual basenames. If all returned filenames are lowercase kebab-case, the check passes. Alternatively, use `grep -P '[A-Z]'` or `LC_ALL=C find` for strict ASCII range matching.
