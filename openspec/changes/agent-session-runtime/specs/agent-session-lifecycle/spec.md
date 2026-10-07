## ADDED Requirements

### Requirement: Sessions, turns and inputs follow explicit state machines
The runtime SHALL model sessions, turns and inputs as explicit state machines and SHALL reject illegal transitions instead of applying them.

#### Scenario: Illegal transition from a driver
- **WHEN** a driver reports a turn completion for a turn that is not running
- **THEN** the runtime MUST NOT change the turn state
- **AND** MUST record a diagnostic event

#### Scenario: Live state equals replayed state
- **WHEN** a session's committed events are folded from the start
- **THEN** the resulting snapshot MUST equal the snapshot maintained live

### Requirement: Resident sessions keep one provider process across turns
For drivers declaring `resident`, the runtime SHALL run every turn of a session on one provider process and SHALL NOT terminate that process at the end of a turn.

#### Scenario: Second turn
- **WHEN** a second input is sent after the first turn completed
- **THEN** it MUST be delivered to the same provider process

#### Scenario: Non-resident driver
- **WHEN** a session uses a driver that does not declare `resident`
- **THEN** each turn MUST run as its own provider invocation, resuming the provider session when supported
- **AND** the session MUST expose the same event vocabulary to the host

### Requirement: Input delivery is acknowledged and never replayed automatically
The runtime SHALL commit each accepted input before writing it to the provider, SHALL report provider receipts (`queued`, `started`, `completed`) as events, and SHALL never automatically resend an input whose delivery is uncertain.

#### Scenario: Input while a turn runs
- **WHEN** an input with delivery `queue` arrives during a running turn on a driver with a native input queue
- **THEN** it MUST be written to the provider and reported `queued` until the provider starts it

#### Scenario: Crash between commit and provider write
- **WHEN** the host stops after committing an input and before the provider acknowledged it
- **THEN** after restart the input MUST be reported `interrupted`
- **AND** it MUST NOT be sent again unless the host submits it again

### Requirement: Agent-initiated continuation turns are first-class
The runtime SHALL represent turns started by the provider or by policy after sub-agent activity as turns with origin `subagent` or `system`, with their own streaming, completion and usage.

#### Scenario: Provider resumes on its own
- **WHEN** a Claude session produces a turn whose result is marked as a task notification
- **THEN** the runtime MUST emit `turn.started` and `turn.completed` with origin `subagent`
- **AND** record that turn's usage separately

#### Scenario: Policy resumes the agent
- **WHEN** a Codex session's sub-agent tree settles, the parent is idle and policy `onSubagentsSettled` is `resume-agent`
- **THEN** the runtime MUST start a turn with origin `system` asking the agent to collect results
- **AND** MUST stop doing so after the configured maximum number of handoffs

### Requirement: Supervision limits are explicit and reasoned
The runtime SHALL retire resident processes according to idle, stall, background-maximum, turn-inactivity and resident-cap limits taken from the session policy, and SHALL record a reason for every retirement.

#### Scenario: Idle retirement
- **WHEN** a session stays idle longer than its idle limit
- **THEN** its process MUST be retired gracefully
- **AND** the next input MUST resume the provider session on a new process

#### Scenario: Background stall
- **WHEN** a session in the background phase receives no provider frame for longer than its stall limit
- **THEN** its process MUST be retired
- **AND** live sub-agents MUST be marked `interrupted` with reason `stalled`

#### Scenario: Resident cap
- **WHEN** the number of resident processes exceeds the cap
- **THEN** the least-recently-used idle session MUST be retired
- **AND** sessions with a running turn or live sub-agents MUST NOT be retired for this reason

#### Scenario: Sub-agent activity during a turn
- **WHEN** only sub-agent frames arrive during a running turn
- **THEN** they MUST count as activity for the turn inactivity limit

### Requirement: Interruptions are explicit and never cause silent relaunch
After any interruption, stop or retirement that affected running work, the runtime SHALL record it, SHALL NOT restart that work by itself, and SHALL prefix the next user input with a one-time notice listing the affected work.

#### Scenario: Next input after interruption
- **WHEN** the host sends the first input after sub-agents were interrupted
- **THEN** the provider MUST receive a notice naming those sub-agents, their status and reason, and asking not to relaunch them unless requested
- **AND** later inputs MUST NOT repeat that notice

#### Scenario: Host restart
- **WHEN** a host starts and finds running turns or sub-agents in the journal
- **THEN** it MUST mark them `interrupted` with reason `restart`
- **AND** MUST NOT start provider processes until a client opens the session

### Requirement: Configuration changes apply at a safe boundary
`session.update` SHALL apply model, effort or policy changes when no turn is running and no sub-agent is live, and SHALL otherwise report the change as deferred.

#### Scenario: Update while sub-agents run
- **WHEN** `session.update` changes the model while sub-agents are live
- **THEN** the response MUST be `deferred`
- **AND** the change MUST apply automatically once the session becomes idle
