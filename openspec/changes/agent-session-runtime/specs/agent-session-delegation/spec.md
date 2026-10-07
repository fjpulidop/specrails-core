## ADDED Requirements

### Requirement: The sub-agent runtime is native or delegated
A session policy SHALL optionally carry a sub-agent runtime: `native` (the provider launches sub-agents with its own tool, optionally with a model and effort) or `delegated` (Core launches each sub-agent as a child session on a given driver, model and effort). Without it, sub-agents are native with the provider's defaults.

#### Scenario: Native with overrides
- **WHEN** a session opens with `subagentRuntime: { mode: 'native', model, effort }` on a driver that declares both capabilities
- **THEN** the provider MUST be started so that its own sub-agents use that model and effort

#### Scenario: Unsupported override
- **WHEN** a native override asks for something the driver cannot apply (e.g. an effort for Claude sub-agents)
- **THEN** `session.open` or `session.update` MUST fail with `policy_unenforceable`

#### Scenario: Delegated mode disables the native tool
- **WHEN** a session runs with `subagentRuntime.mode = 'delegated'`
- **THEN** the provider's own sub-agent tool MUST be disabled
- **AND** any native sub-agent the provider starts anyway MUST be stopped with reason `policy`

### Requirement: Delegated sub-agents are child sessions in the parent's tree
`session.delegate` SHALL launch a child session on the delegated driver and represent it as a sub-agent of the parent session.

#### Scenario: Delegate
- **WHEN** a host calls `session.delegate` with a description and a prompt
- **THEN** Core MUST return a sub-agent id immediately
- **AND** open a child session with the parent's cwd, permissions and MCP servers, sub-agents disabled, on the delegated driver, model and effort
- **AND** journal `subagent.started` in the parent with the child's description and type

#### Scenario: Child activity and result
- **WHEN** the child produces text and tool activity and completes its turn
- **THEN** the parent MUST journal it as `subagent.output`, then `subagent.result` with the child's final answer and `subagent.phase` `idle`

#### Scenario: Concurrency limit
- **WHEN** a delegation would exceed the policy's `maxConcurrent`
- **THEN** `session.delegate` MUST fail with `limit_reached`

#### Scenario: Parent restart
- **WHEN** the parent's provider process restarts while a delegated child runs
- **THEN** the child MUST keep running and its result MUST still reach the parent

### Requirement: Delegated results reach the parent agent
Because the parent cannot observe delegated output natively, Core SHALL deliver delegated results to it, either through an explicit wait or through a continuation turn.

#### Scenario: Wait
- **WHEN** a host calls `session.waitSubagents` and the awaited children finish before the timeout
- **THEN** it MUST resolve with each child's description and result, and those results MUST NOT be injected again

#### Scenario: Continuation
- **WHEN** delegated children finish without being awaited and the parent is idle
- **THEN** Core MUST start a `system`-origin parent turn whose input carries each finished child's description and result, bounded by `maxSettleHandoffs`

#### Scenario: Stop
- **WHEN** the host stops a delegated sub-agent
- **THEN** its child session MUST be interrupted and closed, and the sub-agent MUST end as `stopped`

### Requirement: Delegated spend is billed separately
Delegated children SHALL report their usage as separate spend so hosts add it to totals, while native sub-agent usage stays a breakdown of the parent's.

#### Scenario: Usage billing
- **WHEN** a delegated child completes a turn
- **THEN** its `subagent.usage` MUST carry the child's own usage with `billing: 'separate'`
- **AND** native sub-agent usage MUST carry `billing: 'included'`
