# Delta Spec: core-agent-baseline

## MODIFIED Requirements

### Requirement: Authoritative core agent constant
The installer SHALL define a single exported constant `CORE_AGENTS` as the authoritative set of mandatory agents: `sr-architect`, `sr-developer`, `sr-reviewer`. This set SHALL also be the COMPLETE set of agents shipped as templates — no other first-party agent templates exist.

#### Scenario: Constant used by scaffold
- **WHEN** `scaffoldInstallation` is invoked
- **THEN** the agent placement set is exactly `CORE_AGENTS` (`sr-architect`, `sr-developer`, `sr-reviewer`)

#### Scenario: Constant used by rail placement
- **WHEN** `placeSkills` runs its rail placement logic
- **THEN** `CORE_RAIL_AGENTS` references the same three agents as `CORE_AGENTS`

#### Scenario: No non-core templates in the package
- **WHEN** `templates/agents/` is enumerated
- **THEN** it contains exactly `sr-architect.md`, `sr-developer.md`, `sr-reviewer.md`

### Requirement: Fresh init activates only core agents by default
On a fresh `init`, the installer SHALL activate exactly the three core agents and no others. Additional agents come exclusively from profiles referencing user-owned `custom-*.md` files.

#### Scenario: Fresh init
- **WHEN** `init` runs without a pre-existing `install-config.yaml`
- **THEN** only `sr-architect.md`, `sr-developer.md`, and `sr-reviewer.md` are placed in `.claude/agents/`

#### Scenario: Custom agents untouched
- **WHEN** `init` or `update` runs in a repo containing `.claude/agents/custom-security-reviewer.md`
- **THEN** the custom agent file is not created, modified, or deleted (reserved-paths contract)

## REMOVED Requirements

### Requirement: sr-merge-resolver is opt-in
**Reason**: `sr-merge-resolver` is removed in v5 along with all non-core agents; opt-in semantics for it are meaningless.
**Migration**: Multi-feature merge conflicts are handled by the orchestrator's built-in section-aware/patch merge fallback (which was already the behavior when the agent was absent). Teams that want a dedicated resolver can copy the v4 agent body to `.claude/agents/custom-merge-resolver.md` and declare it in a profile.
