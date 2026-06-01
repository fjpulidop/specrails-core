# Spec: Core Agent Baseline

The specrails installer defines a fixed set of three mandatory agents that every installation requires. All other agents are optional and must be explicitly selected.

---

## Requirements

### Requirement: Authoritative core agent constant
The installer SHALL define a single exported constant `CORE_AGENTS` as the authoritative set of mandatory agents: `sr-architect`, `sr-developer`, `sr-reviewer`.

#### Scenario: Constant used by scaffold
- **WHEN** `scaffoldInstallation` is invoked
- **THEN** `QUICK_REQUIRED_AGENTS` is equal to `CORE_AGENTS` and contains exactly `sr-architect`, `sr-developer`, `sr-reviewer`

#### Scenario: Constant used by rail placement
- **WHEN** `placeSkills` runs its rail placement logic
- **THEN** `CORE_RAIL_AGENTS` references the same three agents as `CORE_AGENTS`

### Requirement: Fresh init activates only core agents by default
On a fresh `init` without an `install-config.yaml`, the installer SHALL activate exactly the three core agents and no others.

#### Scenario: Quick-tier fresh init
- **WHEN** `init` runs in quick tier without a pre-existing `install-config.yaml`
- **THEN** only `sr-architect.md`, `sr-developer.md`, and `sr-reviewer.md` are placed in `.claude/agents/`

#### Scenario: Full-tier fresh init
- **WHEN** `init` runs in full tier
- **THEN** `setup-templates/agents/` contains all agent templates but the enrich wizard pre-selects only the three core agents by default

### Requirement: sr-merge-resolver is opt-in
`sr-merge-resolver` SHALL be treated as an optional agent by the installer and the implement pipeline.

#### Scenario: Missing sr-merge-resolver does not block init
- **WHEN** a fresh init installs only the three core agents
- **THEN** `sr-merge-resolver` is absent from `.claude/agents/` and no warning or error is emitted

#### Scenario: Missing sr-merge-resolver does not block implement pipeline
- **WHEN** the implement pipeline runs and `sr-merge-resolver` is not in `AVAILABLE_AGENTS`
- **THEN** the pipeline prints `"sr-merge-resolver not installed — skipping merge conflict resolution agent"` and uses the built-in merge fallback
