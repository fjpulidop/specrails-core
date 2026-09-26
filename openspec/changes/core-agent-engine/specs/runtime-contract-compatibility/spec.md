## ADDED Requirements

### Requirement: Contract identity reflects the installed runtime
Core SHALL publish integration metadata derived from its actual runtime constants and callable machine operations. C0 SHALL retain API 1, workflow 7 and instructions 10, advance the integration schema to 5.1, identify engine 1, expose no v2 pieces and include the non-deprecated `specrails-implementation` built-in at version 7. `evaluate` SHALL be an integration operation; `help` SHALL be explicitly classified as presentation.

#### Scenario: Contract drift is detected
- **WHEN** workflow identity, instruction identity, phase order or a machine CLI operation differs from the integration contract
- **THEN** a parity test fails without rewriting runtime constants to match stale metadata

#### Scenario: Capabilities are not yet implemented
- **WHEN** Core has only completed C0
- **THEN** it does not advertise `engineV2`, workflow definitions, fan-out or steering as available

### Requirement: Legacy graph identity remains frozen
Core SHALL preserve the legacy definition's identity, entry, node order, edges, effects, retries and transition budget until C10. A deterministic fingerprint fixture SHALL cover normal and compact-developer definitions.

#### Scenario: An accidental graph edit changes resume identity
- **WHEN** a legacy node's `ends` or transition budget changes during an additive engine block
- **THEN** the fingerprint regression test fails

#### Scenario: Definition extraction is behavior-preserving
- **WHEN** the extracted legacy definition runs with the existing fixture executor
- **THEN** its observable sequence, completion and retained-runtime resume behavior match the prior definition

### Requirement: Engine selection follows the frozen request
Core SHALL choose a run's engine from its frozen request, reject incompatible runtime identity and preserve no-definition legacy CLI behavior throughout the additive phases. The host SHALL use the exact retained runtime for existing runs.

#### Scenario: Older Desktop invokes new Core without a definition
- **WHEN** Desktop invokes the legacy run command against a supported additive Core release
- **THEN** Core runs the preserved built-in and returns compatible JSONL

#### Scenario: A run is resumed with a different package
- **WHEN** the selected package identity differs from the run's frozen runtime identity
- **THEN** Core rejects resume without changing its checkpoint or frozen request

