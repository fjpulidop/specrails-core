## ADDED Requirements

### Requirement: CLI entry point
The package SHALL expose a `specrails` binary via `package.json` `bin` field that delegates to bash scripts.

#### Scenario: Init subcommand
- **WHEN** user runs `npx specrails init`
- **THEN** the CLI SHALL execute `install.sh` from the package directory with inherited stdio

#### Scenario: Init with arguments
- **WHEN** user runs `npx specrails init --root-dir /some/path`
- **THEN** the CLI SHALL forward `--root-dir /some/path` to `install.sh`

#### Scenario: Update subcommand
- **WHEN** user runs `npx specrails update`
- **THEN** the CLI SHALL execute `update.sh` from the package directory with inherited stdio

#### Scenario: Update with arguments
- **WHEN** user runs `npx specrails update --only core`
- **THEN** the CLI SHALL forward `--only core` to `update.sh`

#### Scenario: No subcommand
- **WHEN** user runs `npx specrails` without a subcommand
- **THEN** the CLI SHALL print usage help listing available subcommands and exit with code 0

#### Scenario: Unknown subcommand
- **WHEN** user runs `npx specrails foo`
- **THEN** the CLI SHALL print an error message with usage help and exit with code 1

#### Scenario: Script failure propagation
- **WHEN** the underlying bash script exits with a non-zero code
- **THEN** the CLI SHALL exit with the same non-zero code

### Requirement: Zero runtime dependencies
The package SHALL have no entries in `dependencies` in `package.json`. Only Node built-in modules (`child_process`, `path`) SHALL be used.

#### Scenario: Clean dependency tree
- **WHEN** the package is published
- **THEN** `package.json` SHALL contain `"dependencies": {}` or omit the field entirely

### Requirement: Minimal package contents
The package SHALL use a `files` whitelist in `package.json` to include only files needed for installation and updates.

#### Scenario: Published package contents
- **WHEN** the package is packed or published
- **THEN** it SHALL include only: `bin/`, `install.sh`, `update.sh`, `templates/`, `prompts/`, `.claude/skills/`, `commands/`
- **THEN** it SHALL NOT include: `openspec/`, `tests/`, `docs/`, `.claude/agents/`, `.claude/agent-memory/`, `.claude/rules/`, `.claude/commands/`

### Requirement: Node and engine compatibility
The package SHALL declare minimum Node version in `engines` field.

#### Scenario: Engine declaration
- **WHEN** `package.json` is read
- **THEN** `engines.node` SHALL be set to `>=18.0.0`
