## ADDED Requirements

### Requirement: Drivers declare capabilities and are registered in a closed registry
Every provider driver SHALL declare a frozen descriptor (id, residency, input queue, sub-agent support and disable ability, autonomous continuation, steering, usage semantics) and SHALL be registered in a closed registry that rejects duplicates and invalid descriptors.

#### Scenario: Duplicate driver id
- **WHEN** the registry is constructed with two drivers sharing an id
- **THEN** construction MUST fail

#### Scenario: Host discovers drivers
- **WHEN** a host calls `initialize`
- **THEN** the response MUST list each registered driver with its descriptor and detected CLI version when available

### Requirement: Provider vocabulary stays inside its driver
Driver translators SHALL convert provider wire frames into normalized events with pure functions, and no code outside a driver's folder SHALL depend on that provider's frame types or branch on its id.

#### Scenario: Architecture rule
- **WHEN** application, domain, journal or host code imports from a driver folder or compares a driver id to a provider name
- **THEN** the architecture test MUST fail

#### Scenario: Unknown provider frame
- **WHEN** a driver receives a frame type it does not recognise
- **THEN** it MUST emit a `provider.unknown` diagnostic event
- **AND** MUST NOT fail the turn

### Requirement: Claude driver implements resident sessions with native receipts and sub-agents
The Claude driver SHALL run a resident stream-json process, map `command_lifecycle` to input receipts, delimit turns from `init` to `result`, recognise task-notification results as continuation turns, and map `task_*`, roster and `parent_tool_use_id` frames to the sub-agent tree.

#### Scenario: Replay of captured background run
- **WHEN** the captured `claude-bg-complete` transcript is replayed through the driver
- **THEN** the event stream MUST contain one user turn, two continuation turns with origin `subagent`, and one sub-agent node that re-enters running once before ending completed

### Requirement: Codex driver implements resident app-server sessions with thread sub-agents
The Codex driver SHALL run a resident `app-server`, demultiplex notifications by thread id, map `collabAgentToolCall` spawns to sub-agent nodes, attribute child-thread items and token usage to them, and keep child threads alive across parent turn completion while the process lives.

#### Scenario: Replay of captured spawn without wait
- **WHEN** the captured `codex-spawn-nowait` transcript is replayed through the driver
- **THEN** the sub-agent node MUST remain running after the parent turn completed
- **AND** MUST complete when its thread's turn completes

### Requirement: Existing executors are available as non-resident drivers
Providers without a verified resident protocol SHALL be exposed through an adapter over the existing executor contract, declaring non-resident execution and unsupported sub-agents.

#### Scenario: Gemini session
- **WHEN** a host opens a session with the Gemini driver and sends two inputs
- **THEN** each input MUST run as one executor invocation resuming the provider session when supported
- **AND** the host MUST receive the same turn and usage event vocabulary as for resident drivers

### Requirement: Every driver passes the shared conformance kit
The repository SHALL contain a driver conformance suite and recorded provider fixtures, and every registered driver SHALL pass the suite in CI without invoking a real provider.

#### Scenario: New driver added
- **WHEN** a new driver is registered
- **THEN** the conformance suite MUST run against it automatically
- **AND** fail when the driver violates ordering, close idempotency, policy enforcement or its declared usage semantics

#### Scenario: Live re-capture is opt-in
- **WHEN** the test suite runs without the live-smoke flag
- **THEN** no provider CLI or network endpoint MUST be invoked
