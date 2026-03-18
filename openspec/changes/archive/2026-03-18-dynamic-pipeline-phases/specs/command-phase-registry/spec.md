## ADDED Requirements

### Requirement: Commands declare pipeline phases via frontmatter
Each command `.md` file in `.claude/commands/sr/` MAY declare a `phases` array in its YAML frontmatter. Each phase entry SHALL have `key` (identifier), `label` (display name), and `description` (tooltip text).

#### Scenario: Command with phases
- **WHEN** a command file contains frontmatter with a `phases` array
- **THEN** the server SHALL parse and include those phases in the command's `CommandInfo`

#### Scenario: Command without phases
- **WHEN** a command file has no `phases` field in frontmatter (or no frontmatter at all)
- **THEN** the command SHALL have an empty phases array and no pipeline bar SHALL be rendered

#### Scenario: Implement command phases
- **WHEN** the `/sr:implement` command is loaded
- **THEN** its phases SHALL be `[architect, developer, reviewer, ship]` as declared in its frontmatter

#### Scenario: Product-backlog command phases
- **WHEN** the `/sr:product-backlog` command is loaded
- **THEN** its phases SHALL be `[analyst]` as declared in its frontmatter

### Requirement: Server exposes phase definitions in config API
The `GET /api/config` response SHALL include phase definitions for each command in the `commands` array.

#### Scenario: Config response includes phases
- **WHEN** client fetches `GET /api/config`
- **THEN** each command object SHALL include a `phases` array with `{ key, label, description }` objects

### Requirement: Server validates hook events against active command phases
When a job is running, the `POST /hooks/events` endpoint SHALL validate the `agent` field against the phases declared by the active job's command, not a hardcoded list.

#### Scenario: Valid phase event for active command
- **WHEN** a hook event arrives with `agent: "architect"` and the active job's command declares an `architect` phase
- **THEN** the server SHALL update and broadcast the phase state

#### Scenario: Unknown phase event for active command
- **WHEN** a hook event arrives with `agent: "analyst"` but the active job's command does not declare an `analyst` phase
- **THEN** the server SHALL log a warning and ignore the event

#### Scenario: Phase state reset on new job
- **WHEN** a new job starts
- **THEN** the server SHALL reset phase states to `idle` for all phases declared by the new job's command and broadcast the reset along with the phase definitions

### Requirement: WebSocket init message includes active phase definitions
The WebSocket `init` message SHALL include the phase definitions for the currently active job's command so clients know which phases to render.

#### Scenario: Init with active job
- **WHEN** a client connects via WebSocket and a job is running
- **THEN** the init message SHALL include `phaseDefinitions` (array of `{ key, label, description }`) and `phases` (current state map) for the active command

#### Scenario: Init with no active job
- **WHEN** a client connects via WebSocket and no job is running
- **THEN** the init message SHALL include an empty `phaseDefinitions` array and empty `phases` map
