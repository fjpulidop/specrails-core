## ADDED Requirements

### Requirement: Profile-aware agent discovery (Phase -1)
Phase -1 agent discovery SHALL read the active profile (per the `specrails-profiles` resolution order) to determine `AVAILABLE_AGENTS`. When a profile is active, `AVAILABLE_AGENTS` SHALL equal the set of `agents[].id` declared in the profile. When no profile is active, Phase -1 SHALL fall back to the legacy behavior of listing `.claude/agents/sr-*.md`.

#### Scenario: Profile-mode discovery
- **WHEN** `$SPECRAILS_PROFILE_PATH` points to a profile with `agents: [{id:"sr-architect"},{id:"sr-developer"},{id:"sr-data-engineer"},{id:"sr-reviewer"}]`
- **THEN** Phase -1 sets `AVAILABLE_AGENTS = sr-architect sr-developer sr-data-engineer sr-reviewer` regardless of other files present in `.claude/agents/`

#### Scenario: Legacy-mode discovery
- **WHEN** no profile is active AND `.claude/agents/` contains `sr-architect.md`, `sr-developer.md`, `sr-reviewer.md`, `sr-frontend-developer.md`
- **THEN** Phase -1 sets `AVAILABLE_AGENTS` to all four agents via the legacy glob

#### Scenario: Profile references missing agent file
- **WHEN** a profile declares `{id: "sr-data-engineer"}` AND `.claude/agents/sr-data-engineer.md` does not exist
- **THEN** Phase -1 halts with an error identifying the missing agent file

### Requirement: Profile-aware routing (Phase 3b)
Phase 3b task routing SHALL apply `profile.routing` rules in order when a profile is active. The first rule whose `tags` array intersects the task's tags wins; a terminal `default: true` rule catches otherwise unmatched tasks. When no profile is active, Phase 3b SHALL fall back to the legacy hardcoded routing rules.

#### Scenario: Profile-mode routing
- **WHEN** a profile is active with routing `[{tags:["etl"], agent:"sr-data-engineer"}, {default:true, agent:"sr-developer"}]` AND a task has tags `["etl","schema"]`
- **THEN** the task is routed to `sr-data-engineer`

#### Scenario: Legacy-mode routing
- **WHEN** no profile is active AND a task has tags `["frontend"]`
- **THEN** the task is routed to `sr-frontend-developer` per the legacy hardcoded rules

### Requirement: Subagent model override mechanism
When a profile is active, subagent invocations SHALL pass the agent's profile-declared `model` explicitly. When no profile is active, subagent invocations SHALL use the agent's frontmatter `model:` value (legacy behavior).

#### Scenario: Invocation uses profile model
- **WHEN** a profile declares `{id:"sr-reviewer", model:"opus"}` AND Phase 4b invokes the reviewer
- **THEN** the Agent tool call includes `model: opus` regardless of the `model:` field in `sr-reviewer.md`

#### Scenario: Invocation uses frontmatter model in legacy mode
- **WHEN** no profile is active AND `sr-reviewer.md` declares `model: sonnet` AND Phase 4b invokes the reviewer
- **THEN** the reviewer is invoked with model `sonnet`

### Requirement: Orchestrator model from profile
When a profile is active, the orchestrator (the top-level `implement.md` execution) SHALL run with `profile.orchestrator.model`. When no profile is active, the orchestrator SHALL run with its current default model (legacy behavior).

#### Scenario: Profile orchestrator model honored
- **WHEN** `$SPECRAILS_PROFILE_PATH` references a profile with `orchestrator: {model: "opus"}`
- **THEN** the `implement` pipeline executes under model `opus`

### Requirement: Profile validation at Phase -1
Phase -1 SHALL validate the active profile against the published schema before proceeding. Validation errors SHALL halt the pipeline with a message naming the invalid field and the expected format.

#### Scenario: Invalid profile halts pipeline
- **WHEN** a profile is missing the `routing` array
- **THEN** Phase -1 halts with an error: "profile validation failed: missing required field `routing`"

### Requirement: Profile snapshot immutability
The pipeline SHALL treat the resolved profile as immutable for the duration of a single invocation. Re-reading the profile mid-invocation SHALL NOT occur.

#### Scenario: Mid-run profile edit does not affect active run
- **WHEN** a rail is running with profile X AND the source file at `$SPECRAILS_PROFILE_PATH` is edited mid-run
- **THEN** the running pipeline continues using the originally-resolved profile X
