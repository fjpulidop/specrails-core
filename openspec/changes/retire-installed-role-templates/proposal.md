## Why

The programmatic agent runtime (`src/agent-runtime/prompts.ts`) is the only place that defines how the architect, developer, fixer and reviewer roles work, and it never reads a file to do so. The installer still ships `templates/agents/sr-*.md` and `templates/codex-skills/rails/sr-*/SKILL.md` and places them into every provider workspace (`.claude/agents`, `.gemini/agents` with tool grants and acknowledgments, `.codex/skills/rails`, `.kimi-code/skills/sr-*`), seeds agent-memory directories for them and requires an `agents.selected` list in the install config. That is a second, drifting copy of the role definitions, dead weight in every project, and a trap for hosts that treat "sr-* files present" as "installed".

## What Changes

- **BREAKING** (installer output): Core no longer ships or places role agent templates for any provider. Workspaces receive commands, workflow skills, OpenSpec skills and the runtime only.
- Assemble keeps the workspace clean: stale framework-owned `sr-*` links or copies left by older versions are pruned from `agents/` (claude, gemini), `skills/rails/sr-*` (codex) and `skills/sr-*` (kimi); reserved `custom-*` roles are never touched.
- Gemini role acknowledgments, per-role model tables, Gemini/Kimi role translation, role agent-memory seeding and the `selectedAgents` / `materializeAllAgents` plumbing are removed.
- `init` detects an installed workspace by its commands and runtime, never by role files; `snapshotWorkspaceProviderSelections` no longer reports agents.
- The install-config `agents` section becomes optional: it is validated for shape when present and ignored with a deprecation warning when non-empty. `assemble --selected-agents` is accepted and ignored with a warning.
- Integration contract 5.1 → 5.2: `configSchema.agents` optional, the `agent_generation` checkpoint removed, `modelPresets.max.overrides` emptied, no `sr-*` identifiers.
- Documentation (CLAUDE.md, README.md) and `.claude/rules/agents.md` updated or removed; every test that seeds or asserts role placement is updated.

## Capabilities

### New Capabilities
- `installer-workspace-artifacts`: what the installer materializes and links per provider, and how stale role artifacts from older versions are pruned without touching reserved files.
- `install-config-compatibility`: the optional, deprecated `agents` section of the install configuration and the ignored `--selected-agents` flag.
- `desktop-integration-contract`: the 5.2 contract surface Desktop negotiates against (checkpoints, config schema, model presets).

### Modified Capabilities
<!-- Core has no main specs yet; nothing to modify. -->

## Impact

- `templates/agents/**`, `templates/codex-skills/rails/**` deleted; `runtime-identity` and `frameworkSourceHash` change because they hash `templates/`.
- `src/installer/phases/scaffold.ts`, `install-config.ts`, `commands/init.ts`, `commands/framework.ts`, `util/paths.ts` (reserved paths unchanged).
- `integration-contract.json` 5.2; Desktop pairs through `retire-installed-role-agents` (setup completion by commands, profiles without baseline role files).
- Tests under `src/installer/**` and `src/agent-runtime/engine/package-surface.test.ts`; `CLAUDE.md`, `README.md`, `.claude/rules/agents.md`.
