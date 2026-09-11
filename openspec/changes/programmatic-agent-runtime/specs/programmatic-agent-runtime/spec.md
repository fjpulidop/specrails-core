## ADDED Requirements

### Requirement: Explicit shared workflow
The runtime SHALL use LangGraph to execute bounded typed steps with durable state and events, without invoking a complete implementation coordinator inside a role.

#### Scenario: Phase execution
- **WHEN** a configured run starts
- **THEN** architecture, development, deterministic verification and review execute as individually observable steps and successful delivery remains gated by Core evidence

### Requirement: Durable and scoped recovery
The runtime SHALL preserve completed outputs, workflow identity and input fingerprint and SHALL reject incompatible or concurrent resumes and ambiguous interrupted writes without explicit recovery.

#### Scenario: Restart after completed phase
- **WHEN** the process restarts after development completed and its evidence remains valid
- **THEN** resume does not repeat valid architecture or development

#### Scenario: Interrupted mutation
- **WHEN** a persisted running write step is recovered after process death
- **THEN** the run requires an explicit recovery decision before repeating it

### Requirement: Extensible providers and local models
The runtime SHALL provide Claude, Codex, Gemini and Kimi CLI executors, configurable OpenAI-compatible endpoints and programmatic executor registration.

#### Scenario: Local provider
- **WHEN** a provider points to a local OpenAI-compatible endpoint without a key
- **THEN** the selected model can use scoped coding tools without a mandatory hosted gateway

### Requirement: Bounds and tool policy
The runtime SHALL enforce finite transitions, turns, timeouts, cancellation, allowed file roots and read-only role capabilities, and SHALL preserve unknown usage as unknown.

#### Scenario: Exhausted tool loop
- **WHEN** an agent exhausts maxTurns without completing
- **THEN** the attempt fails instead of certifying the task complete

#### Scenario: Scope violation
- **WHEN** a tool requests traversal or a symlink escaping the configured roots
- **THEN** access is rejected

### Requirement: Portable deployment
The runtime SHALL support the existing Node minimum on macOS and Windows and SHALL package all required runtime dependencies without depending on a paid orchestration service.

#### Scenario: Windows path
- **WHEN** a provider runs in a Windows workspace whose path includes spaces
- **THEN** arguments retain their identity and cancellation terminates the owned process tree

### Requirement: Configuration and credentials
The runtime SHALL validate configuration before executing tools and SHALL store credential environment names rather than secret values in configuration and checkpoints.

#### Scenario: Invalid provider reference
- **WHEN** an agent refers to an unregistered provider
- **THEN** validation reports the offending field before any invocation starts
