## MODIFIED Requirements

### Requirement: Agent references
All agent invocations within the implement pipeline SHALL use `sr-` prefixed `subagent_type` values. The pipeline SHALL treat `sr-architect`, `sr-developer`, and `sr-reviewer` as the only mandatory core agents. All other agents, including `sr-merge-resolver`, SHALL be treated as optional with graceful skip behavior.

#### Scenario: Architect launch
- **WHEN** Phase 3a launches architect agents
- **THEN** the Agent tool is called with `subagent_type: sr-architect`

#### Scenario: Product manager launch
- **WHEN** Phase 1 launches product manager agents
- **THEN** the Agent tool is called with `subagent_type: sr-product-manager`

#### Scenario: Developer launch
- **WHEN** Phase 3b launches developer agents
- **THEN** the Agent tool is called with `subagent_type: sr-developer`

#### Scenario: Test writer launch
- **WHEN** Phase 3c launches test writer agents
- **THEN** the Agent tool is called with `subagent_type: sr-test-writer`

#### Scenario: Doc sync launch
- **WHEN** Phase 3d launches doc sync agents
- **THEN** the Agent tool is called with `subagent_type: sr-doc-sync`

#### Scenario: Layer reviewer launches
- **WHEN** Phase 4b launches layer reviewers
- **THEN** the Agent tool is called with `subagent_type: sr-frontend-reviewer`, `subagent_type: sr-backend-reviewer`, and `subagent_type: sr-security-reviewer` respectively

#### Scenario: Generalist reviewer launch
- **WHEN** Phase 4b launches the generalist reviewer
- **THEN** the Agent tool is called with `subagent_type: sr-reviewer`

#### Scenario: Merge resolver absent — graceful skip
- **WHEN** the implement pipeline runs Phase 4a multi-feature merge
- **AND** `sr-merge-resolver` is not in `AVAILABLE_AGENTS`
- **THEN** the pipeline prints `"sr-merge-resolver not installed — skipping merge conflict resolution agent"` and applies the built-in section-aware merge fallback

#### Scenario: Core agent missing — pipeline stops
- **WHEN** `sr-architect`, `sr-developer`, or `sr-reviewer` is not in `AVAILABLE_AGENTS`
- **THEN** the pipeline stops immediately with: `[error] Core agent <name> not found. Run /specrails:enrich or reinstall.`

## ADDED Requirements

### Requirement: Optional agent gate rules — legacy mode
In legacy mode, the implement pipeline SHALL gate every optional agent invocation and skip gracefully when the agent is absent from the filesystem.

#### Scenario: Optional agent absent in legacy mode
- **WHEN** legacy mode is active (no profile)
- **AND** an optional agent such as `sr-test-writer` is not present in `.claude/agents/`
- **THEN** that phase is skipped with a note: `"sr-test-writer not installed — skipping"`

#### Scenario: Optional agent present in legacy mode
- **WHEN** legacy mode is active
- **AND** an optional agent is present in `.claude/agents/`
- **THEN** that agent is invoked normally

### Requirement: Optional agent gate rules — profile mode
In profile mode, the implement pipeline SHALL gate every optional agent invocation based solely on the profile's `agents[]` list, not on disk presence.

#### Scenario: Optional agent absent from profile
- **WHEN** profile mode is active
- **AND** an optional agent's id is not listed in `profile.agents[]`
- **THEN** that phase is skipped with a note: `"<agent> not in profile — skipping"`

#### Scenario: Optional agent in profile but missing on disk
- **WHEN** profile mode is active
- **AND** an optional agent's id is listed in `profile.agents[]` but its `.md` file does not exist
- **THEN** the pipeline stops with: `[error] profile references agent '<id>' but .claude/agents/<id>.md does not exist`
