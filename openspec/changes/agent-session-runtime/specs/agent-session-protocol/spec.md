## ADDED Requirements

### Requirement: Long-lived session host over stdio
Core SHALL provide a `runtime host --stdio --scope <projectKey|global>` operation that serves many agent sessions of one scope over JSON-RPC 2.0 framed as newline-delimited JSON, writing only protocol messages to stdout.

#### Scenario: Host starts and negotiates
- **WHEN** a host process receives `initialize` with a list of supported protocol versions
- **THEN** it MUST answer with the highest mutually supported `protocolVersion`, its runtime identity, its capabilities and the registered drivers with their descriptors

#### Scenario: No common protocol version
- **WHEN** `initialize` lists no version the host supports
- **THEN** the host MUST answer with error `protocol_mismatch` listing its supported versions
- **AND** MUST NOT open any session

#### Scenario: Diagnostics stay off the protocol channel
- **WHEN** the runtime logs diagnostics
- **THEN** they MUST be written to stderr only

### Requirement: Sessions capability is advertised and contract-tested
The `runtime api` output SHALL advertise `sessions: 1`, and `integration-contract.json` SHALL describe the session protocol version, CLI operation, journal root and event types, kept in sync by a contract test.

#### Scenario: Host checks support
- **WHEN** a host runs `runtime api` against a Core that implements this change
- **THEN** the capabilities map MUST contain `sessions` with a positive integer value

#### Scenario: Contract drift
- **WHEN** the protocol version, CLI operations or event types change without updating `integration-contract.json`
- **THEN** the contract test MUST fail

### Requirement: Methods are validated, idempotent where retried, and map to stable errors
Each protocol method SHALL validate its parameters against a closed schema, delegate to one application use case, and return stable error codes with a `retryable` flag.

#### Scenario: Invalid parameters
- **WHEN** a method receives parameters that violate its schema
- **THEN** the host MUST answer with a JSON-RPC invalid-params error naming the offending field
- **AND** MUST NOT change any session state

#### Scenario: Retried input
- **WHEN** `session.send` is received twice with the same `inputId`
- **THEN** the input MUST be delivered to the provider at most once
- **AND** both calls MUST report the same acceptance outcome

#### Scenario: Oversized frame
- **WHEN** a request line exceeds the framing limit
- **THEN** the host MUST answer `payload_too_large` and keep serving other requests

### Requirement: Notifications follow durable commit and can be replayed
The host SHALL publish `session.event` notifications only after the event is committed to the journal, numbered with a gap-free per-session sequence, and SHALL serve `session.events` to replay events after a given sequence.

#### Scenario: Host reconnects
- **WHEN** a client reconnects and calls `session.events` with the last sequence it processed
- **THEN** the host MUST return every later committed event in order
- **AND** a client that applies events idempotently by sequence MUST reach the same state as a client that never disconnected

#### Scenario: Notification consumer is slow
- **WHEN** the outbound notification queue is full
- **THEN** only coalescible streaming deltas MAY be merged
- **AND** lifecycle, receipt, usage and sub-agent status events MUST NOT be dropped

### Requirement: Graceful host shutdown
The host SHALL handle `host.shutdown` and termination signals by retiring every resident provider process within a grace period and recording the resulting state before exiting.

#### Scenario: Shutdown with live work
- **WHEN** `host.shutdown` is received while sessions have running turns or sub-agents
- **THEN** the host MUST terminate their provider process trees
- **AND** commit `interrupted` outcomes with reason `shutdown`
- **AND** exit only after those commits
