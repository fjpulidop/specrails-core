## ADDED Requirements

### Requirement: Interrupt delivery cuts the running turn and runs the input next
`session.send` SHALL accept `delivery: 'interrupt'`. When a turn is running, the runtime SHALL end that turn and start a new turn whose first input is the interrupting input. Inputs queued before it SHALL run after it, in their original order.

#### Scenario: Correction during a turn
- **WHEN** a turn is running and the host sends an input with `delivery: 'interrupt'`
- **THEN** the journal MUST record `input.accepted { delivery: 'interrupt' }`, then `turn.completed { status: 'interrupted' }` for the running turn, then `turn.started` whose `inputIds` contain the interrupting input

#### Scenario: Queued inputs keep their order behind the correction
- **WHEN** inputs A and B were sent with `delivery: 'queue'` while a turn runs, and then input C is sent with `delivery: 'interrupt'`
- **THEN** C MUST start before A and B
- **AND** A MUST start before B

#### Scenario: Interrupt while idle
- **WHEN** no turn is running and the host sends an input with `delivery: 'interrupt'`
- **THEN** the input MUST be delivered exactly as with `delivery: 'queue'`
- **AND** no stop request MUST reach the provider

#### Scenario: Interrupt while a previous interrupt is pending
- **WHEN** a second `'interrupt'` input arrives before the first interrupting input has started
- **THEN** the runtime MUST NOT stop the turn the first input starts
- **AND** the second input MUST run after the first and before earlier queued inputs

### Requirement: Drivers use the provider primitive when one exists
Each driver SHALL declare `capabilities.interrupt` as `native` when the provider can stop a turn and keep its session, or `emulated` otherwise. Claude SHALL use `control_request interrupt` followed by the user frame with `priority: 'now'`. Codex SHALL use `turn/interrupt` followed by `turn/start`. Emulated drivers SHALL stop the turn as `session.interrupt` does and run the input as the next turn.

#### Scenario: Capability is advertised
- **WHEN** a host calls `initialize`
- **THEN** each driver descriptor MUST carry `capabilities.interrupt` with `native` or `emulated`

### Requirement: The interrupting input is never lost and never replayed
The runtime SHALL deliver an accepted interrupting input exactly once, including when the provider does not stop in time, and SHALL NOT re-run an interrupted turn after a host restart.

#### Scenario: Provider ignores the stop
- **WHEN** the cut turn has not ended after the interrupt grace period
- **THEN** the provider process MUST be retired with the turn recorded `interrupted`
- **AND** the interrupting input MUST be delivered to a new provider process

#### Scenario: Ambiguous receipt
- **WHEN** the provider reports the cut turn's input as cancelled after the turn ended
- **THEN** that input MUST keep its terminal state and no warning diagnostic MUST be journaled

#### Scenario: Host restart
- **WHEN** the host restarts after a turn was interrupted by an interrupting input
- **THEN** the interrupted turn MUST stay `interrupted` with its partial text
- **AND** an interrupting input that had not started MUST be recorded `interrupted` and MUST NOT be sent to the provider again

### Requirement: Interrupt delivery is advertised in the contract
`runtime api` SHALL advertise `flowSessions: 1`, and `integration-contract.json` SHALL list the session deliveries in `agentRuntime.sessions.deliveries`, kept in sync with the protocol schema by the contract test.

#### Scenario: Host checks support
- **WHEN** a host runs `runtime api`
- **THEN** the capabilities map MUST contain `flowSessions` with a positive integer value
