## ADDED Requirements

### Requirement: Definitions are validated before effects
Core SHALL validate definition shape, canonical hash, piece parameters and all semantic rules in shared contract section 2 before starting any provider or command. Validation SHALL reject unknown or reserved nodes, invalid labeled exits, missing terminal paths, journal mismatch, undeclared roles, invalid map/join relationships, component cycles and depth over three.

#### Scenario: A graph references an unknown target
- **WHEN** an `ends` target is absent from its containing graph
- **THEN** validation returns a structured error identifying the node and no executor starts

#### Scenario: A definition was edited after hashing
- **WHEN** the supplied version differs from the canonical content hash excluding `version`
- **THEN** Core rejects it with `definition_hash_mismatch`

### Requirement: Core owns all new graph traversal
Core SHALL execute every node in a definition through its closed registry and LangGraph compiler. It SHALL preserve labeled routing, bounded transitions, conditional edges and business retry cycles without delegating a step or successor decision to Desktop or accepting executable user code.

#### Scenario: A conditional graph runs through the CLI
- **WHEN** a condition selects its false outcome
- **THEN** Core schedules only the declared false target and emits the resulting node events

#### Scenario: A loop exceeds its transition limit
- **WHEN** visits across the complete graph reach the definition's transition bound
- **THEN** execution stops with a readable `recursion_limit` reason rather than continuing unbounded

### Requirement: Definitions and configuration are immutable per run
The runtime SHALL bind definition, config, context and runtime identity to one run and persist the definition used for later resume. Host-written launch files SHALL use exclusive creation and private permissions. `resume` SHALL reject a replacement definition or config.

#### Scenario: An existing launch file has different content
- **WHEN** the host attempts to freeze a different definition under the same run ID
- **THEN** the launch fails and the original file remains unchanged

### Requirement: Interpolation respects the host boundary
Desktop SHALL resolve spec, constant and command tokens before launch; Core SHALL resolve only declared `run` variables immediately before each node and honor the contract's literal escape. Core SHALL not invoke a provider when a required run variable is missing.

#### Scenario: A captured variable is missing
- **WHEN** a node references an absent `run.changeId`
- **THEN** the node fails with `run_var_missing` before any provider or shell effect

