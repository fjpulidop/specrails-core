## ADDED Requirements

### Requirement: Shared memory is scoped to its project
The optional SQLite store SHALL isolate namespaces by project and enforce each piece's declared store access. The host SHALL be able to delete project memory without altering retained run evidence.

#### Scenario: Two projects use the same role identifier
- **WHEN** they store session or review data
- **THEN** neither can read or overwrite the other's namespace

### Requirement: Steering is durable and consumed at attempt boundaries
`signal` SHALL accept at most 20,000 characters for an existing run and durably acknowledge an inbox identifier. Prompt and role pieces SHALL consume eligible messages at the next attempt boundary and record consumption atomically with that attempt; live provider sessions SHALL not be steered mid-turn.

#### Scenario: The process dies after consuming steering
- **WHEN** recovery or invalidation revisits the attempt boundary
- **THEN** the durable consumption record prevents duplicate message application

### Requirement: Evaluation and traces are optional and offline-testable
Core SHALL evaluate reference definitions using deterministic fixtures and expose optional trace export without a required hosted service or provider call in CI. Evaluation SHALL compare acceptance and receipts against the legacy baseline before migration claims.

#### Scenario: CI evaluates implementation parity
- **WHEN** the definition evaluation suite runs without external credentials
- **THEN** it completes using fixtures and reports any acceptance, receipt or invocation-count difference

