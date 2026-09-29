## ADDED Requirements

### Requirement: Committed workflow events are ordered and attributable
Core SHALL emit lifecycle JSONL only after its producing transaction commits, with strictly increasing per-run sequence across resume and node/visit/attempt identity plus branch identity when applicable. Each run/resume SHALL first expose its graph metadata.

#### Scenario: A persisted event is recovered after restart
- **WHEN** the run resumes and emits later lifecycle events
- **THEN** their sequence exceeds the earlier committed sequence and their identities permit host deduplication

### Requirement: Output volume is bounded
Core SHALL cap JSONL lines at 1,000,000 characters and bound node output and history according to the contract before serialization. Large provider/shell output SHALL not corrupt framing or lose terminal state.

#### Scenario: A piece emits ten megabytes of output
- **WHEN** the engine publishes progress and completion
- **THEN** all lines remain valid bounded JSON and the run can still be inspected and resumed

### Requirement: Unknown usage remains unknown
Usage reducers SHALL preserve null for unknown billed cost or tokens and track known totals separately for budget enforcement. Core SHALL report per-invocation and per-attempt usage but SHALL never write Desktop accounting rows.

#### Scenario: One invocation omits billed cost
- **WHEN** usage is aggregated with a known-cost invocation
- **THEN** aggregate billed cost is null while the known subtotal remains available

### Requirement: CLI exposes completion and evidence without storage coupling
Core SHALL provide v2 graph/status/result/evidence through its documented CLI, with workflow identity, completion, pending input, node steps and usage. Desktop SHALL not read `run.sqlite` directly and SHALL remain the authority for delivery and accounting.

#### Scenario: Desktop inspects a completed definition
- **WHEN** it invokes compact status using the retained runtime
- **THEN** Core returns the documented completion and step information sufficient to project host evidence without requiring database access

