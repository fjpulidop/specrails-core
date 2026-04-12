---
agent: developer
feature: SPEA-743-phase-2
tags: [rename, commands, enrich, setup, install.sh]
date: 2026-04-11
---

## Decision

`/specrails:setup` was renamed to `/specrails:enrich` by creating new `commands/enrich.md` and `templates/commands/specrails/enrich.md` files (keeping the old setup files during the transition period) and updating `install.sh` to install the enrich command/skill.

## Why This Approach

The rename is non-destructive: setup.md files are preserved alongside the new enrich.md files. This supports repos that were installed before the rename and may still have `/specrails:setup` in their `.claude/commands/specrails/` directory — they continue to work during the transition window documented in `integration-contract.json`'s `legacyCompat` field.

## Alternatives Considered

Deleting setup.md and doing an in-place rename was rejected per the task spec — coexistence during transition is required.

## See Also

- `integration-contract.json` — machine-readable contract for hub/TUI integration, including `legacyCompat.setupCommandAlias`
- `commands/enrich.md` — adds From-Config Mode (FC1–FC5) and renames Lite Mode to Quick Mode
