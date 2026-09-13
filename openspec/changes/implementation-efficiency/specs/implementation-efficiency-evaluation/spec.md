## ADDED Requirements

### Requirement: Metrics preserve measured meaning
Core SHALL retain RuntimeEfficiency schema1 semantics and add optional versioned invocation, context, route and check metadata. Executor calls MUST remain distinct from observable inference requests; unknown values MUST remain unknown. Replayed events MUST be idempotent.

#### Scenario: A provider hides internal inference requests
- **WHEN** an executor reports one invocation without an internal request count
- **THEN** providerCalls increments once and modelRequests remains unavailable
- **AND** cached token counts are not added again to input totals

#### Scenario: A continuation replays recorded events
- **WHEN** the same deterministic event IDs are projected again
- **THEN** cumulative costs, durations and check counts are unchanged

### Requirement: Offline evaluation checks mechanics and acceptance
Core SHALL supply an offline default runner with at least the five cases and defective variants defined in design.md. It SHALL freeze case, repository, acceptance, runtime and configuration identities and MUST NOT invoke paid providers or install tools by default.

#### Scenario: Long unchanged context is followed by a correction
- **WHEN** the fixed fixture runs with supported continuation
- **THEN** the correction prompt is at least 40 percent smaller than the full-context baseline
- **AND** the fixture uses no additional provider invocation and preserves all acceptance gates

#### Scenario: A defective implementation reaches the oracle
- **WHEN** each seeded defect is evaluated
- **THEN** its independent acceptance check fails rather than trusting the runtime completed status

### Requirement: Real-provider comparisons account for unsuccessful work
An explicitly enabled real-provider evaluation SHALL require selected models, aggregate spend policy and stop conditions. It SHALL compare paired fresh runs with the same-model experiment separated from model-routing experiments and include failures, retries, corrections and rescues in cost per independently accepted implementation.

#### Scenario: No output passes independent acceptance
- **WHEN** a comparison cohort has zero accepted implementations
- **THEN** cost per accepted output is reported as unavailable and the cohort is unsuccessful

#### Scenario: Some failed attempts have unknown billing
- **WHEN** the cohort lacks complete cost measurements
- **THEN** the monetary comparison is inconclusive while observed tokens, duration and acceptance remain reportable
- **AND** the report cannot claim aggregate savings from known costs only

#### Scenario: A small cohort does not establish a quality-preserving saving
- **WHEN** three paired replicas per case show ambiguous or worse acceptance, critical/high defects, cost or median active duration
- **THEN** the report includes sample size and variation and marks the economic target inconclusive or unmet
- **AND** no measured-savings claim or cheaper default is promoted from that result

### Requirement: Runtime completion is distinct from independent acceptance
Core SHALL expose typed technical acceptance separately from archive, delivery and independent evaluation acceptance. It MUST NOT infer acceptance or monetary savings from successful process exit alone.

#### Scenario: Workflow succeeds but independent checks reject output
- **WHEN** the evaluator detects an acceptance regression
- **THEN** the evaluation fails even if the runtime completed and archived successfully
