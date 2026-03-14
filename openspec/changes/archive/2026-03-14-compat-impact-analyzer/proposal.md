# Proposal: Backwards Compatibility Impact Analyzer

## Problem Statement

OSS maintainers who use specrails today have no automated signal when a proposed design introduces a breaking change. The architect agent produces an excellent implementation plan but has no obligation to examine what the current API surface looks like or flag contract violations. The result: breaking changes reach PRs or even releases without a migration guide, forcing downstream users to update without notice and damaging project trust.

This problem is acute in specrails itself. The system exposes a contract surface across three dimensions:

1. **Shell CLI flags** — `install.sh` arguments that users script against
2. **Template placeholder schema** — `{{PLACEHOLDER}}` keys that target repos depend on through generated `.claude/` files
3. **Command/agent interface** — slash command names, argument formats, and output shapes that users invoke daily

Any refactor that renames a flag, removes a placeholder, or changes a command's argument contract is a breaking change. Today, nothing catches this before it ships.

## Proposed Solution

Add a `compat-check` slash command and extend the architect agent with an explicit **compatibility check phase** that runs as part of the OpenSpec fast-forward workflow.

The solution has two modes:

### Mode 1: `/compat-check` (standalone command)
An on-demand command that snapshots and diffs the current API surface. Users run it before and after a proposed change to get a compatibility report. Generates a migration guide when breaking changes are detected.

### Mode 2: Architect integration (automatic)
The architect agent gains a mandatory compatibility check phase that runs after designing an implementation plan but before finalizing tasks. It diffs the proposed design against the snapshotted API surface, identifies breaking changes, and appends a "Migration Guide" section to `design.md` when breakage is found.

The check is intentionally heuristic — it reads the codebase and proposed changes with AI reasoning rather than executing static analysis tools. This keeps the solution bash + markdown, with no new dependencies.

## What "API Surface" Means in specrails

| Surface | Extraction Method |
|---------|------------------|
| `install.sh` CLI flags | Parse `case "$1" in` blocks for flag names |
| Template placeholders | `grep -r '{{[A-Z_]*}}'` across `templates/` |
| Slash command names | Frontmatter `name:` fields in `templates/commands/` |
| Command argument schema | `$ARGUMENTS` parsing sections in command files |
| Agent names | Frontmatter `name:` fields in `templates/agents/` |
| Config schema keys | `openspec/config.yaml` top-level keys |

## Success Criteria

1. `/compat-check` produces a surface snapshot and diff report in under 60 seconds on the specrails repo.
2. The architect agent always includes a compatibility analysis section in its output when processing an OpenSpec change.
3. When breaking changes are detected, a migration guide is generated with at least: change category, what broke, and one concrete remediation path.
4. The command works on specrails itself — the specrails repo is the primary test case.
5. No new runtime dependencies are introduced.
6. The system handles the case where no prior snapshot exists (first run).

## Non-Goals

- Static analysis / AST parsing (too language-specific, adds dependencies)
- Semver bump automation (out of scope; the guide informs the human who decides)
- Runtime compatibility testing (no test harness exists yet)
- Enforcement / blocking of PRs (advisory only at this stage)
