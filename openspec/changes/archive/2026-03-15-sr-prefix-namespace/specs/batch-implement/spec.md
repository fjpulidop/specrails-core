## MODIFIED Requirements

### Requirement: Command namespace
The `/batch-implement` command SHALL be invoked as `/sr:batch-implement`. The command file SHALL be located at `.claude/commands/sr/batch-implement.md`.

#### Scenario: Command invocation
- **WHEN** user types `/sr:batch-implement #85, #71, #63`
- **THEN** the batch pipeline runs identically to the former `/batch-implement #85, #71, #63`

### Requirement: Implement delegation
All delegated invocations SHALL reference `/sr:implement` instead of `/implement`.

#### Scenario: Per-feature delegation
- **WHEN** batch-implement delegates a feature to the implement pipeline
- **THEN** it invokes `/sr:implement` with the appropriate flags

#### Scenario: Error message for single feature
- **WHEN** user provides fewer than 2 feature refs
- **THEN** error message reads: `For a single feature, use /sr:implement directly.`

#### Scenario: Dry-run message
- **WHEN** `--dry-run` flag is present
- **THEN** startup message reads: `/sr:implement will be called with --dry-run for each wave.`
