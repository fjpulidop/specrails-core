## MODIFIED Requirements

### Requirement: Command namespace
The `/implement` command SHALL be invoked as `/specrails:implement`. The command file SHALL be located at `.claude/commands/specrails/implement.md`.

#### Scenario: Command invocation
- **WHEN** user types `/specrails:implement #85`
- **THEN** the full implementation pipeline runs identically to the former `/implement #85`

### Requirement: Agent references
All agent invocations within the implement pipeline SHALL use `sr-` prefixed `subagent_type` values.

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

### Requirement: Agent memory paths
All references to agent memory paths within the implement pipeline SHALL use `sr-` prefixed directory names.

#### Scenario: Reviewer common fixes path
- **WHEN** Phase 3b reads reviewer common fixes
- **THEN** the path used is `.claude/agent-memory/sr-reviewer/common-fixes.md`

### Requirement: Confidence override flag
The confidence override flag SHALL reference `/specrails:implement` in its documentation.

#### Scenario: Override flag documentation
- **WHEN** `--confidence-override` is passed to `/specrails:implement`
- **THEN** the behavior is identical to the former `/implement --confidence-override`
