## Context

The specrails-core installer currently defines `QUICK_REQUIRED_AGENTS` in `scaffold.ts` as a set of four agents: `sr-architect`, `sr-developer`, `sr-reviewer`, and `sr-merge-resolver`. This set is used in two ways: (1) as the list of agents that cannot be excluded from a quick-tier install regardless of user selection, and (2) implicitly as the "core" agents that the implement pipeline guarantees will be present.

The implement pipeline template (`implement.md`) currently documents `sr-merge-resolver` as a core agent in the agent role table, meaning the pipeline is expected to stop with an error if it is absent. However, `sr-merge-resolver` is only invoked in multi-feature merge conflict scenarios — it is not part of the single-feature loop. This conflation of "always installed" with "always required by the pipeline" creates brittleness: if a project using only the three-agent core loop did not opt in to `sr-merge-resolver`, the pipeline would surface a confusing error.

The `install-config.yaml` schema already defines `sr-architect`, `sr-developer`, and `sr-reviewer` as the three required baseline agents in `profile.v1.json`. The installer code has not fully converged on this definition.

## Goals / Non-Goals

**Goals:**
- Define `sr-architect`, `sr-developer`, `sr-reviewer` as the single authoritative mandatory baseline in every runtime context: init scaffolding, update scaffolding, legacy implement pipeline, and profile-mode implement pipeline.
- Reduce the default agent set for fresh `init` (both quick and full tiers) to exactly the three core agents; make all others opt-in.
- Demote `sr-merge-resolver` from required to optional in `scaffold.ts` and in the implement pipeline's agent role table and gate rules.
- Harden the implement pipeline's optional-agent gate rules so any non-core agent absence is a graceful skip in both legacy and profile modes.
- Harden `update.ts` to ensure previously installed optional agents survive a `--update` run unchanged.

**Non-Goals:**
- Removing, deprecating, or rewriting optional agent templates.
- Removing the legacy (no-profile) runtime mode.
- Changing the `profile.v1.json` JSON schema (it already encodes the correct three-agent baseline requirement).
- Retroactive changes to existing installs (non-retroactive by design; the update path preserves what is there).

## Decisions

### Decision 1: Remove `sr-merge-resolver` from `QUICK_REQUIRED_AGENTS`

**Rationale**: `sr-merge-resolver` is only invoked in multi-feature merge conflict scenarios. It is not part of the primary architect → developer → reviewer loop. Treating it as mandatory inflates the default install surface and contradicts the profile.v1.json schema (which does not require it). Demoting it to opt-in aligns the installer with the schema and the product intent.

**Alternatives considered**:
- Keep it required, add a `sr-merge-resolver` absent graceful skip in implement.md only. Rejected: this leaves the installer still placing `sr-merge-resolver` by default, which contradicts the "minimal core baseline" goal.
- Create a second constant `CORE_RAIL_AGENTS` separate from `QUICK_REQUIRED_AGENTS`. Already exists in `placeSkills` but hardcodes `sr-merge-resolver` in the same set. Align both constants to the three-agent baseline.

### Decision 2: Single constant, single source of truth

Rather than scattering `new Set(['sr-architect', 'sr-developer', 'sr-reviewer'])` across multiple call sites, introduce one exported constant:

```ts
export const CORE_AGENTS = new Set(['sr-architect', 'sr-developer', 'sr-reviewer'])
```

`QUICK_REQUIRED_AGENTS` becomes an alias of (or equals) `CORE_AGENTS`. `CORE_RAIL_AGENTS` in `placeSkills` is updated to reference the same constant. This means one grep confirms the authoritative baseline everywhere.

**Alternatives considered**: Keep two constants in sync manually. Rejected: prone to drift.

### Decision 3: Default install includes only the three core agents

For installs where `install-config.yaml` is absent (legacy/direct `npx specrails-core init` without a TUI config), the `selectedAgents` parameter is `undefined`, which causes `placeQuickTierArtefacts` to place ALL non-excluded agents. Change the default so that when `selectedAgents` is `undefined` but tier is `quick`, the default list is `CORE_AGENTS` only.

For the `full` tier, agents are placed in `setup-templates/` and activated via `/specrails:enrich`. The enrich wizard already prompts for agent selection; we simply update the default selection list the wizard pre-selects to the three core agents.

**Alternatives considered**: Prompt users during `init` for agent selection even without TUI config. Rejected: adds interactive complexity to a zero-config path. The three-agent baseline is a safe, usable default; users can add more via `--update` or re-enrich.

### Decision 4: Preserve optional agents across `--update` by reading install-config

`update.ts` already reads `install-config.yaml` and passes `selectedAgents` to `scaffoldInstallation`. When `selectedAgents` contains the previously-chosen optional agents, they are re-placed on update. No structural change is needed to `update.ts` — the preservation contract is already present via the config round-trip. The task here is to confirm (via test) that:
1. `install-config.yaml` stores the full set at init time (including any opt-in agents the user chose).
2. `update.ts` reads and re-passes that full set correctly.

If the TUI does not currently write optional agents to `install-config.yaml` when the user selects them, that is the gap to close in `tui-installer.mjs`.

### Decision 5: implement.md gate rules — demote `sr-merge-resolver` to optional

The agent role table in implement.md currently marks `sr-merge-resolver` as "Core (always present)". Change this to "Optional" with a graceful skip note. The existing gate rule already handles optional agents: "If an optional agent is NOT in `AVAILABLE_AGENTS`, skip that phase/sub-step silently." Extending the same rule to `sr-merge-resolver` requires only updating the table and confirming the Phase 4a merge conflict path checks for agent presence before invoking it.

## Risks / Trade-offs

- **[Risk] Existing installs that have `sr-merge-resolver` continue to work** → No risk: demoting to optional only affects the gate-check path; installed agents remain functional.
- **[Risk] Full-tier enrich wizard defaulting to three agents surprises users who expected a richer set** → Mitigation: the enrich wizard explicitly lists available agents and lets the user add more. We update the pre-selected defaults, not the available set.
- **[Risk] TUI installer does not write optional agent selections to `install-config.yaml`** → Mitigation: verified in Task 4 (tests); if the gap exists, Task 3 closes it in `tui-installer.mjs`.
- **[Risk] Multi-feature runs that encounter merge conflicts fail silently when `sr-merge-resolver` is absent** → Mitigation: Phase 4a's `sr-merge-resolver` invocation is gated; when absent, the pipeline falls back to the built-in section-aware merge algorithm and prints a warning. This behavior already exists; Task 5 confirms and documents it.

## Migration Plan

1. No data migration required — changes are code-only.
2. Existing installs retain all currently installed agents (update is non-destructive).
3. New installs from this version forward install three core agents by default.
4. Rollback: revert the three changed files (`scaffold.ts`, `implement.md`, and any TUI change). No schema migration needed.

## Open Questions

- Does the TUI (`tui-installer.mjs`) currently write the complete `agents.selected` list to `install-config.yaml` when optional agents are chosen? This needs to be verified in Task 4. If not, a targeted fix is required.
- Should `sr-merge-resolver` appear as a recommended opt-in agent in the TUI's agent picker, with a tooltip explaining it enables smart multi-feature merge conflict resolution? Suggested yes — defer to the TUI UX pass, not this change.
