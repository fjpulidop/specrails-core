## ADDED Requirements

### Requirement: Sub-agents form a provider-neutral tree
The runtime SHALL expose sub-agents as a tree of nodes with a stable id, parent (agent or sub-agent), kind (foreground or background), description, agent type, phase, timestamps, usage and result summary, independent of the provider's representation.

#### Scenario: Claude background sub-agent
- **WHEN** Claude reports `task_started` for an `Agent` tool use with background execution
- **THEN** the runtime MUST emit `subagent.started` with kind `background`, the description and the parent agent

#### Scenario: Codex child thread
- **WHEN** Codex completes a `spawnAgent` call whose `receiverThreadIds` contains a new thread
- **THEN** the runtime MUST emit `subagent.started` for that thread with the spawning thread as parent
- **AND** attribute every later notification with that thread id to the sub-agent

#### Scenario: Sub-agent output
- **WHEN** the provider emits text or tool activity belonging to a sub-agent
- **THEN** the runtime MUST emit it as sub-agent output, never as the parent agent's output

### Requirement: Sub-agent phase is re-entrant and settlement is explicit
The runtime SHALL allow a sub-agent to return from a completed phase to running when the provider restarts it, and SHALL compute an explicit `settled` state for the tree instead of inferring it from a single empty roster.

#### Scenario: Sub-agent restarted after reporting completion
- **WHEN** a Claude sub-agent reported completion and later the same task id starts again
- **THEN** the runtime MUST move it back to running and keep one node for it

#### Scenario: Roster momentarily empty
- **WHEN** the provider reports an empty roster and a sub-agent starts again within the settle window
- **THEN** the tree MUST NOT be reported as settled

### Requirement: Sub-agent policy is enforced by the provider, never silently ignored
The runtime SHALL translate `policy.subagents` into the provider's native mechanism and SHALL refuse to open a session whose policy cannot be enforced.

#### Scenario: Disabled on Claude
- **WHEN** a Claude session opens with sub-agents disabled
- **THEN** the provider process MUST be started without the Agent and Task tools

#### Scenario: Disabled on Codex
- **WHEN** a Codex session opens with sub-agents disabled
- **THEN** the provider MUST be started with multi-agent tools disabled

#### Scenario: Unenforceable policy
- **WHEN** a session requests sub-agents disabled with a driver that supports sub-agents but cannot disable them
- **THEN** `session.open` MUST fail with `policy_unenforceable`

#### Scenario: Driver without sub-agent support
- **WHEN** a session opens with a driver declaring sub-agents unsupported
- **THEN** opening MUST succeed for either policy value
- **AND** no sub-agent events MUST be emitted

### Requirement: Sub-agents can be stopped selectively
`session.stopSubagents` SHALL stop the listed sub-agents, or all of them, using the most targeted mechanism the driver supports, and SHALL record each affected node as `stopped`.

#### Scenario: Stop all background work
- **WHEN** the host stops all sub-agents of a session with no running turn
- **THEN** every live sub-agent MUST end as `stopped` with reason `host_request`
- **AND** the session MUST remain usable for new input

### Requirement: Sub-agent usage is attributed without inflating totals
The runtime SHALL attribute provider-reported sub-agent usage to its node, SHALL flag derived USD amounts as estimates, and SHALL never add sub-agent usage on top of billed session or turn totals.

#### Scenario: Codex child thread tokens
- **WHEN** Codex reports cumulative token usage for a child thread
- **THEN** the sub-agent node MUST carry that thread's token totals

#### Scenario: Claude sub-agent progress usage
- **WHEN** Claude reports a sub-agent's total tokens in task progress or notification
- **THEN** the node MUST carry those tokens with no USD unless estimated and flagged

### Requirement: Sub-agent output is bounded
The runtime SHALL cap stored output per sub-agent and SHALL record an explicit truncation event when the cap is exceeded.

#### Scenario: Very long sub-agent transcript
- **WHEN** a sub-agent produces output beyond the per-sub-agent cap
- **THEN** further coalescible output MUST be elided with one `output.truncated` event
- **AND** lifecycle and usage events for that sub-agent MUST still be recorded
