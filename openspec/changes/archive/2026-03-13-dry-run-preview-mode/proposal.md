# Proposal: Local Agent Dry-Run / Preview Mode

## Problem

The `/implement` pipeline is a powerful but irreversible sequence of actions: it creates branches, pushes commits, opens PRs, and comments on GitHub Issues. There is no way to preview what the pipeline would produce — code changes, OpenSpec artifacts, test output — before those side effects fire.

This makes `/implement` unsafe to run experimentally. Developers who want to explore whether a feature idea is feasible, or verify that agents interpret a spec correctly, must either commit to the full pipeline or avoid running it altogether. The result is a workflow where iteration is expensive and mistakes are visible in the repo and backlog before they can be caught.

## Solution

Add a `--dry-run` flag (alias: `--preview`) to `/implement`.

When `--dry-run` is active:

- All agents run normally: product-manager explores, architect designs, developer implements, reviewer validates.
- All generated artifacts — OpenSpec files, code, tests, documentation — are written to a cache directory (`.claude/.dry-run/<feature-name>/`) instead of their real locations.
- Git operations are suppressed: no branch creation, no commits, no push, no PR.
- GitHub/backlog operations are suppressed: no issue comments.
- A full preview report is shown: diffs of what would change, a summary of all artifacts generated, and a list of operations that were skipped.
- The cache is retained so re-running with `--apply` copies artifacts to real locations and proceeds with Phase 4c shipping.

## Non-Goals

- This does not add a dry-run mode to individual agents. The flag is an orchestrator-level concern.
- This does not sandbox file system access during agent execution. Files are written to the cache directory under `.claude/.dry-run/`; real repo files are not touched.
- This does not add rollback to non-dry-run runs. Rollback is a separate concern.
- This does not change the behavior of `/implement` without the flag. The default pipeline is unchanged.

## Scope

Two files change:

1. `templates/commands/implement.md` — the source template, which drives all future installs.
2. `.claude/commands/implement.md` — the currently-active generated command in this repo.

Both files receive identical changes because specrails is self-hosting: the generated command IS the active command. Changes to the template propagate to target repos on their next `/setup` run.

## Success Criteria

- `--dry-run` flag is parsed in Phase 0 and a `DRY_RUN` boolean is set.
- Phases 3a and 3b write output to `.claude/.dry-run/<feature-name>/` when `DRY_RUN=true`.
- Phase 4c git and backlog operations are entirely skipped when `DRY_RUN=true`.
- A preview report is shown at the end of Phase 4e that includes diffs and a list of skipped operations.
- `--apply` flag reads from cache and triggers Phase 4c shipping without re-running agents.
- Pipeline is fully unchanged when neither flag is passed.
