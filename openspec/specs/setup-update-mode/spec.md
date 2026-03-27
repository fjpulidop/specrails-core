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

### Requirement: Command template checksum detection
In `--update` mode, `/setup` SHALL check command templates (in `.claude/setup-templates/commands/specrails/`) against their manifest checksums and identify changed or new command templates.

#### Scenario: Changed command template detected
- **WHEN** `templates/commands/specrails/implement.md` checksum in manifest differs from the current file in `.claude/setup-templates/commands/specrails/`
- **THEN** `implement.md` is marked as changed and included in the update analysis display

#### Scenario: New command template detected
- **WHEN** `templates/commands/specrails/why.md` exists in `.claude/setup-templates/commands/specrails/` but has no entry in the manifest
- **THEN** `why.md` is marked as new and offered to the user for installation

#### Scenario: Unchanged command template
- **WHEN** `templates/commands/specrails/health-check.md` checksum matches the manifest
- **THEN** health-check is listed as unchanged and skipped

### Requirement: Command template update (overwrite)
In `--update` mode, `/setup` SHALL overwrite changed command templates in `.claude/commands/specrails/` with the new versions from `.claude/setup-templates/commands/specrails/`, substituting any `{{PLACEHOLDER}}` values using the codebase analysis from Phase U2 and stored config from `.claude/backlog-config.json`.

#### Scenario: Changed command applied
- **WHEN** `implement.md` is detected as changed
- **THEN** `.claude/commands/specrails/implement.md` is overwritten with the new template, placeholders substituted, and the manifest entry updated

#### Scenario: New command installed
- **WHEN** a new `sr:refactor-recommender.md` template is present and not in manifest
- **THEN** setup prompts the user: "New command available: /specrails:refactor-recommender — install it? [Y/n]" and installs if accepted

### Requirement: Update summary
At the end of `--update` mode, `/setup` SHALL display a summary of what was regenerated, added, and skipped.

#### Scenario: Summary displayed
- **WHEN** `/setup --update` completes
- **THEN** a summary shows: agents regenerated (N), agents added (N), agents skipped (N), commands updated (N), commands added (N)
