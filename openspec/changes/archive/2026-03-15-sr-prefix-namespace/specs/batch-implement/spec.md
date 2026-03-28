## MODIFIED Requirements

### Requirement: Command namespace
The `/batch-implement` command SHALL be invoked as `/specrails:batch-implement`. The command file SHALL be located at `.claude/commands/specrails/batch-implement.md`.

#### Scenario: Command invocation
- **WHEN** user types `/specrails:batch-implement #85, #71, #63`
- **THEN** the batch pipeline runs identically to the former `/batch-implement #85, #71, #63`

### Requirement: Implement delegation
All delegated invocations SHALL reference `/specrails:implement` instead of `/implement`.

#### Scenario: Per-feature delegation
- **WHEN** batch-implement delegates a feature to the implement pipeline
- **THEN** it invokes `/specrails:implement` with the appropriate flags

#### Scenario: Error message for single feature
- **WHEN** user provides fewer than 2 feature refs
- **THEN** error message reads: `For a single feature, use /specrails:implement directly.`

#### Scenario: Dry-run message
- **WHEN** `--dry-run` flag is present
- **THEN** startup message reads: `/specrails:implement will be called with --dry-run for each wave.`
