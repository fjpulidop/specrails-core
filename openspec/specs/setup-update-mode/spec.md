## ADDED Requirements

### Requirement: Setup --update flag
`/setup` SHALL accept an `--update` argument that triggers surgical regeneration mode instead of the full setup wizard.

#### Scenario: --update mode invoked
- **WHEN** user runs `/setup --update`
- **THEN** setup reads `.specrails-manifest.json`, identifies changed templates, and regenerates only affected agents/rules

### Requirement: Quick codebase re-analysis
In `--update` mode, `/setup` SHALL perform a fast codebase analysis (stack detection, conventions) without prompting the user for personas or product discovery.

#### Scenario: Codebase analyzed silently
- **WHEN** `/setup --update` runs
- **THEN** Phase 1 (codebase analysis) executes automatically, Phases 2-3 (personas, product discovery) are skipped

### Requirement: Selective agent regeneration
In `--update` mode, `/setup` SHALL regenerate only the agents whose source templates have changed according to the manifest.

#### Scenario: Only changed agents regenerated
- **WHEN** `architect.md` and `developer.md` templates changed but `reviewer.md` did not
- **THEN** only `.claude/agents/architect.md` and `.claude/agents/developer.md` are regenerated; `reviewer.md` is preserved

### Requirement: New agent evaluation
In `--update` mode, `/setup` SHALL evaluate new agent templates (present in specrails but absent from the manifest) against the detected project stack and offer to generate them.

#### Scenario: New relevant agent available
- **WHEN** a new `frontend-developer.md` template exists and the project has React in its stack
- **THEN** setup offers to generate the agent: "New agent available: frontend-developer. Your project uses React — add it? [y/N]"

#### Scenario: New irrelevant agent available
- **WHEN** a new `backend-developer.md` template exists but the project has no backend code
- **THEN** setup informs the user but recommends skipping: "New agent available: backend-developer. No backend detected — skip? [Y/n]"

### Requirement: Workflow command update
In `--update` mode, `/setup` SHALL update workflow commands (e.g., `/implement`) to reference any newly added agents.

#### Scenario: New agent added to implement pipeline
- **WHEN** a `frontend-developer` agent was added during update
- **THEN** `/implement` is updated to include frontend-developer in its agent orchestration where relevant

### Requirement: Update summary
At the end of `--update` mode, `/setup` SHALL display a summary of what was regenerated, added, and skipped.

#### Scenario: Summary displayed
- **WHEN** `/setup --update` completes
- **THEN** a summary shows: agents regenerated (N), agents added (N), agents skipped (N), rules updated (N)
