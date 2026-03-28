## MODIFIED Requirements

### Requirement: Selective agent regeneration
In `--update` mode, `/setup` SHALL regenerate only the agents whose source templates have changed according to the manifest.

#### Scenario: Only changed agents regenerated
- **WHEN** `sr-architect.md` and `sr-developer.md` templates changed but `sr-reviewer.md` did not
- **THEN** only `.claude/agents/sr-architect.md` and `.claude/agents/sr-developer.md` are regenerated; `sr-reviewer.md` is preserved

### Requirement: New agent evaluation
In `--update` mode, `/setup` SHALL evaluate new agent templates (present in specrails but absent from the manifest) against the detected project stack and offer to generate them.

#### Scenario: New relevant agent available
- **WHEN** a new `sr-frontend-developer.md` template exists and the project has React in its stack
- **THEN** setup offers to generate the agent: "New agent available: sr-frontend-developer. Your project uses React — add it? [y/N]"

#### Scenario: New irrelevant agent available
- **WHEN** a new `sr-backend-developer.md` template exists but the project has no backend code
- **THEN** setup informs the user but recommends skipping: "New agent available: sr-backend-developer. No backend detected — skip? [Y/n]"

### Requirement: Workflow command update
In `--update` mode, `/setup` SHALL update workflow commands to reference any newly added agents using sr- prefixed names.

#### Scenario: New agent added to implement pipeline
- **WHEN** an `sr-frontend-developer` agent was added during update
- **THEN** `/specrails:implement` is updated to include sr-frontend-developer in its agent orchestration where relevant
