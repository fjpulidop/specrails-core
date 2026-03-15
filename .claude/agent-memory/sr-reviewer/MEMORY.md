# Reviewer Agent Memory

## Reference
- [common-fixes.md](common-fixes.md) — CI check false positives, variable quoting gotchas, install.sh patterns, generated-file sync gap
- [placeholder-resolution-bug.md](placeholder-resolution-bug.md) — Broken placeholder substitution in resolved agent copies: `/setup`-time placeholders must be preserved verbatim in `.claude/agents/`, not replaced with wrong literals

## Known False Positives
- File naming check: `find .claude/agents .claude/commands .claude/rules -name '*[A-Z]*'` matches directory names (e.g., `.claude/agents`), not just files — this is a false positive. Actual file names are all kebab-case.
- Placeholder check: backtick-quoted `{{PLACEHOLDER}}` in documentation prose (e.g., review checklists) are false positives. Only bare `{{WORD}}` outside documentation context are real issues.
