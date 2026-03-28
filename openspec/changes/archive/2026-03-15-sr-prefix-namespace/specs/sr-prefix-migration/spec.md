## ADDED Requirements

### Requirement: Legacy installation detection
The update script SHALL detect legacy (unprefixed) specrails installations by checking for the existence of `.claude/agents/architect.md` (without `sr-` prefix).

#### Scenario: Legacy installation detected
- **WHEN** `update.sh` runs and `.claude/agents/architect.md` exists
- **THEN** the migration function `do_migrate_sr_prefix()` is invoked before any other update operations

#### Scenario: Already migrated installation
- **WHEN** `update.sh` runs and `.claude/agents/sr-architect.md` exists but `.claude/agents/architect.md` does not
- **THEN** the migration function is skipped

### Requirement: Agent file migration
The migration function SHALL rename all specrails agent files from `<name>.md` to `sr-<name>.md` in `.claude/agents/`.

#### Scenario: All agents renamed
- **WHEN** migration runs with legacy agent files present
- **THEN** all 12 agent files are renamed: architect, developer, reviewer, product-manager, product-analyst, test-writer, doc-sync, frontend-developer, backend-developer, frontend-reviewer, backend-reviewer, security-reviewer

#### Scenario: Partial installation
- **WHEN** migration runs but some agent files are missing (e.g., project skipped frontend-developer)
- **THEN** only existing files are renamed; missing files are skipped without error

### Requirement: Persona file migration
The migration function SHALL rename all persona files from `<name>.md` to `sr-<name>.md` in `.claude/agents/personas/`.

#### Scenario: Personas renamed
- **WHEN** migration runs with persona files present
- **THEN** all persona files are renamed with `sr-` prefix

### Requirement: Command directory migration
The migration function SHALL move all specrails workflow commands from `.claude/commands/<name>.md` to `.claude/commands/specrails/<name>.md`.

#### Scenario: Commands moved to sr/ subdirectory
- **WHEN** migration runs with legacy command files present
- **THEN** commands implement, batch-implement, product-backlog, update-product-driven-backlog, health-check, compat-check, refactor-recommender, and why are moved to `.claude/commands/specrails/`

#### Scenario: Non-specrails commands preserved
- **WHEN** migration runs and `.claude/commands/` contains files not in the specrails command list (e.g., user-created commands)
- **THEN** those files remain in `.claude/commands/` untouched

#### Scenario: setup.md stays at root
- **WHEN** migration runs
- **THEN** `.claude/commands/setup.md` remains at `.claude/commands/setup.md` (not moved to sr/)

### Requirement: Agent memory directory migration
The migration function SHALL rename all agent memory directories from `.claude/agent-memory/<name>/` to `.claude/agent-memory/sr-<name>/`.

#### Scenario: Memory directories renamed
- **WHEN** migration runs with legacy memory directories present
- **THEN** directories architect, developer, reviewer, product-manager, product-analyst, test-writer, doc-sync, security-reviewer are renamed with `sr-` prefix

#### Scenario: Non-agent memory preserved
- **WHEN** migration runs and `.claude/agent-memory/` contains directories not in the agent list (e.g., `failures/`, `explanations/`)
- **THEN** those directories remain untouched

### Requirement: Manifest regeneration
The migration function SHALL regenerate `.specrails-manifest.json` with updated template paths after renaming files.

#### Scenario: Manifest updated
- **WHEN** migration completes file operations
- **THEN** `.specrails-manifest.json` entries reference `sr-` prefixed paths (e.g., `templates/agents/sr-architect.md`)

### Requirement: Migration summary
The migration function SHALL print a summary of all operations performed.

#### Scenario: Summary displayed
- **WHEN** migration completes
- **THEN** output shows: agents renamed (N), personas renamed (N), commands moved (N), memory dirs renamed (N)

### Requirement: Migration ordering
The migration function SHALL run before any other update operations in `update.sh`.

#### Scenario: Migration before update
- **WHEN** `update.sh` detects a legacy installation
- **THEN** `do_migrate_sr_prefix()` runs before `do_core()`, `do_agents()`, or any other update function
