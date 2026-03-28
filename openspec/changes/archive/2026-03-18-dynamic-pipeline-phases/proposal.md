## Why

The pipeline progress in `/specrails:implement` and other commands was hardcoded to the `architect → developer → reviewer → ship` workflow. Every other command (product-backlog, health-check, refactor-recommender, etc.) had no way to declare its own phases, making it impossible to accurately represent their progress.

## What Changes

- **Command metadata**: Each command defines its own pipeline phases via frontmatter in its `.md` file (e.g., `phases: [analyst]` for product-backlog, `phases: [architect, developer, reviewer, ship]` for implement). Commands with no phases declare an empty array.

## Capabilities

### New Capabilities
- `command-phase-registry`: Frontmatter-based phase declaration per command

## Impact

- **Command files**: All 8 command `.md` files in `.claude/commands/specrails/` get a `phases` frontmatter field.
- **Breaking**: None — phases are metadata only and do not affect pipeline execution logic.
