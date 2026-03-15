## MODIFIED Requirements

### Requirement: Command namespace
The `/compat-check` command SHALL be invoked as `/sr:compat-check`. The command file SHALL be located at `.claude/commands/sr/compat-check.md`.

#### Scenario: Command invocation
- **WHEN** user types `/sr:compat-check`
- **THEN** the compatibility check runs identically to the former `/compat-check`

### Requirement: Agent name surface extraction
The surface extraction for `agent_names` SHALL read from `templates/agents/sr-*.md` and extract `sr-` prefixed names from frontmatter.

#### Scenario: Agent names in snapshot
- **WHEN** Phase 1 extracts agent names
- **THEN** the snapshot contains entries like `{ "name": "sr-architect", "source": "templates/agents/sr-architect.md" }`

### Requirement: Command name surface extraction
The surface extraction for `command_names` SHALL read from `templates/commands/sr/*.md` and extract command names.

#### Scenario: Command names in snapshot
- **WHEN** Phase 1 extracts command names
- **THEN** the snapshot contains entries like `{ "name": "sr:implement", "source": "templates/commands/sr/implement.md" }`
