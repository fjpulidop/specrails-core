## ADDED Requirements

### Requirement: Contract 5.2 carries no role identifiers
`integration-contract.json` SHALL advertise `schemaVersion` `5.2`, SHALL mark `configSchema.agents` as optional and deprecated, SHALL NOT list an `agent_generation` checkpoint, and SHALL NOT contain `sr-*` identifiers (including `modelPresets.*.overrides`).

#### Scenario: Contract inspection
- **WHEN** the contract is parsed
- **THEN** `schemaVersion` is `5.2`, no checkpoint key is `agent_generation`, `modelPresets.max.overrides` is empty and the serialized contract contains no `sr-` identifier

#### Scenario: Runtime identity unchanged
- **WHEN** `runtime api` is queried
- **THEN** it still advertises API 1, engines `[1, 2]` and role instructions version 13
