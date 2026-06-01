## Why

The installer currently activates a broad set of agents by default (test-writer, doc-sync, frontend/backend layer reviewers, etc.), adding setup weight and cognitive overhead for projects that only need the core product loop. There is no single, explicit, authoritative definition of the minimal mandatory baseline shared across both the installer (init/update), the implement pipeline (legacy and profile modes), and the install-config schema — leaving the pipeline brittle when optional agents are absent.

## What Changes

- Fresh `init` reduces the default active agent set to exactly three: `sr-architect`, `sr-developer`, `sr-reviewer`. All other agents become opt-in during setup.
- `scaffold.ts` `QUICK_REQUIRED_AGENTS` and related constants are updated so the mandatory baseline is authoritative in one place and re-used everywhere.
- `update.ts` is hardened to ensure previously-installed optional agents are never removed on `--update` (preserving user choices across upgrades).
- `implement.md` (the orchestrator template) is extended with explicit gate rules for optional agents in both legacy and profile modes, so the pipeline degrades gracefully without the optional agents rather than stopping with an error.
- `sr-merge-resolver` is demoted from the hardcoded "always required" list to opt-in status; it is not part of the canonical three-agent core loop.

## Capabilities

### New Capabilities

- `core-agent-baseline`: A single, authoritative definition of the mandatory core agents (`sr-architect`, `sr-developer`, `sr-reviewer`) shared across installer phases, update logic, and the implement pipeline.

### Modified Capabilities

- `implement`: The implement orchestrator's agent role table and gate rules are extended to treat `sr-merge-resolver` and all specialist agents as optional, with graceful skip behavior in both legacy and profile modes.
- `setup-update-mode`: The update command is hardened to read and preserve `agents.selected` from `install-config.yaml`, preventing optional agents from being silently dropped on update.

## Impact

- `src/installer/phases/scaffold.ts` — `QUICK_REQUIRED_AGENTS` updated; `sr-merge-resolver` moved to opt-in; default agent list for non-config installs reduced to three.
- `src/installer/commands/update.ts` — `selectedAgents` preservation logic confirmed present; update scaffold call explicitly passes the persisted selection.
- `templates/commands/specrails/implement.md` — agent role table updated; gate rules for optional-agent absence extended to cover `sr-merge-resolver` and all specialist agents in both modes.
- `openspec/specs/implement/spec.md` and `openspec/specs/setup-update-mode/spec.md` — delta specs capture the changed behavioral requirements.
- Tests: `src/installer/__tests__/scaffold.test.ts` (or equivalent) should assert the new default agent set.
