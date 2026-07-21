# Delta Spec: implement

## ADDED Requirements

### Requirement: Single agent-resolution path
The implement pipeline SHALL resolve its agent roster in Phase -1 through exactly one path: `AVAILABLE_AGENTS = profile ?? baseline`, where the profile is resolved as (highest wins) `$SPECRAILS_PROFILE_PATH` → `<cwd>/.specrails/profiles/project-default.json`, and the baseline is the implicit in-command default `{sr-architect, sr-developer, sr-reviewer}` with standard model defaults. The terms "legacy mode" and "profile mode" SHALL NOT appear in the command; there are no per-mode behavior branches.

#### Scenario: No profile present
- **WHEN** neither `$SPECRAILS_PROFILE_PATH` nor `project-default.json` exists
- **THEN** `AVAILABLE_AGENTS` is exactly `{sr-architect, sr-developer, sr-reviewer}` and the pipeline runs architect → developer → reviewer with no optional phases

#### Scenario: Profile present
- **WHEN** a valid profile exists
- **THEN** `AVAILABLE_AGENTS`, routing, and per-agent models come from the profile; baseline agents are still required members

#### Scenario: No default profile is ever written
- **WHEN** the pipeline falls back to the baseline
- **THEN** no file is created under `.specrails/profiles/` (the baseline is an in-memory default, honoring the reserved-paths contract)

### Requirement: Profile agents validated with warn-and-skip
When a profile lists a non-baseline agent whose `.md` file does not exist on disk, the pipeline SHALL print a warning naming the missing agent and continue without it. The three baseline agents remain hard-required: if any baseline agent's file is missing, the pipeline SHALL stop with an error.

#### Scenario: Profile references a removed v4 agent
- **WHEN** a v4-era profile lists `sr-frontend-developer` and no `.claude/agents/sr-frontend-developer.md` exists
- **THEN** the pipeline prints `[warn] profile references agent 'sr-frontend-developer' but no agent file exists — skipping (removed in v5; use a custom-* agent)` and continues with the remaining agents

#### Scenario: Baseline agent missing
- **WHEN** `sr-developer.md` is absent from the agents directory
- **THEN** the pipeline stops with `[error] Core agent sr-developer not found. Run npx specrails-core update to reinstall.`

## MODIFIED Requirements

### Requirement: Agent references
All agent invocations within the implement pipeline SHALL use `sr-` prefixed `subagent_type` values. The pipeline SHALL invoke exactly three first-party agents — `sr-architect`, `sr-developer`, `sr-reviewer` — plus any `custom-*` agents declared by an active profile. No other first-party `subagent_type` values exist in the command.

#### Scenario: Architect launch
- **WHEN** Phase 3a launches architect agents
- **THEN** the Agent tool is called with `subagent_type: sr-architect`

#### Scenario: Developer launch
- **WHEN** Phase 3b launches developer agents
- **THEN** the Agent tool is called with `subagent_type: sr-developer` (or a profile-declared custom developer for profile-routed tasks)

#### Scenario: Reviewer launch
- **WHEN** Phase 4b launches the reviewer
- **THEN** the Agent tool is called with `subagent_type: sr-reviewer`

#### Scenario: No removed-agent references remain
- **WHEN** the implement command template is searched for `sr-product-manager`, `sr-product-analyst`, `sr-test-writer`, `sr-doc-sync`, `sr-merge-resolver`, `sr-frontend-`, `sr-backend-`, `sr-security-reviewer`, or `sr-performance-reviewer`
- **THEN** zero matches are found

#### Scenario: Core agent missing — pipeline stops
- **WHEN** `sr-architect`, `sr-developer`, or `sr-reviewer` is not in `AVAILABLE_AGENTS`
- **THEN** the pipeline stops immediately with: `[error] Core agent <name> not found. Run npx specrails-core update to reinstall.`

## REMOVED Requirements

### Requirement: Optional agent gate rules — legacy mode
**Reason**: Legacy mode no longer exists; the dual-mode resolution collapses into the single path (`profile ?? baseline`) and the optional agents the gates guarded are removed.
**Migration**: None needed at runtime — installs without a profile get the baseline automatically. Teams using optional v4 agents migrate them to `custom-*` agents declared in a profile.

### Requirement: Optional agent gate rules — profile mode
**Reason**: Superseded by "Profile agents validated with warn-and-skip". The v4 rule hard-errored when a profile agent was missing on disk; v5 warns and skips non-baseline agents so v4 profiles referencing removed agents degrade gracefully.
**Migration**: Profiles keep working; entries for removed `sr-*` agents produce a warning and are skipped. Replace them with `custom-*` agents to restore the behavior.

### Requirement: Optional pipeline phases for non-core agents
**Reason**: Phases 3c (sr-test-writer), 3d (sr-doc-sync), the layer-routing table in 3b (sr-frontend-developer / sr-backend-developer), and the extra reviewer passes in 4b (sr-frontend/backend/security/performance-reviewer) are removed together with their agents. Tests and documentation are the responsibility of well-written OpenSpec tasks executed by sr-developer; review consolidates into the single sr-reviewer pass.
**Migration**: Profile-declared `custom-*` agents with routing metadata can reintroduce equivalent stages where the profile schema supports routing; otherwise fold the concerns into task definitions and the reviewer checklist.
