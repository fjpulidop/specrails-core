## ADDED Requirements

### Requirement: Journals live outside repositories, grouped per project
The runtime SHALL store session state only under `~/.specrails/sessions/<scope>/`, where scope is the host-provided project key or `global`, honouring `SPECRAILS_REGISTRY_HOME`, with private file permissions, and SHALL never write session state inside a project repository.

#### Scenario: Project-scoped host
- **WHEN** a host starts with scope `my-project`
- **THEN** all session data MUST be written under `~/.specrails/sessions/my-project/`
- **AND** nothing MUST be written inside the session's working directory by the runtime itself

#### Scenario: Test isolation
- **WHEN** `SPECRAILS_REGISTRY_HOME` is set
- **THEN** the sessions root MUST resolve under that directory instead of the user home

### Requirement: One owner per journal, fenced by epoch
The runtime SHALL allow a single live host per scope through an epoch-fenced lease and SHALL fence stale owners from writing.

#### Scenario: Second host for the same scope
- **WHEN** a host starts for a scope whose lease is held by a live host
- **THEN** it MUST fail initialization with `journal_locked`

#### Scenario: Stale owner recovered
- **WHEN** a host acquires the lease after the previous owner's lease expired
- **THEN** sessions that were running under the previous owner MUST be marked `interrupted` with reason `host_lost`
- **AND** any later write attempted by the previous owner MUST be rejected

### Requirement: Events are committed atomically before effects are observable
The runtime SHALL commit events and their projections in one transaction, SHALL perform no provider I/O inside a transaction, and SHALL publish notifications only for committed events.

#### Scenario: Crash during commit
- **WHEN** the process is killed while committing an event batch
- **THEN** after restart either the whole batch or none of it MUST be visible

### Requirement: Usage baselines persist across processes
The journal SHALL persist the last known cumulative provider totals per provider session reference so that per-turn usage remains correct across process restarts and provider resume.

#### Scenario: Claude resume after retirement
- **WHEN** a Claude session is resumed on a new process and the provider reports a session-cumulative cost
- **THEN** the turn's recorded cost MUST equal the reported value minus the persisted baseline

#### Scenario: Missing provider value
- **WHEN** the provider omits cost or token values
- **THEN** the recorded value MUST be null and the baseline MUST remain unchanged

### Requirement: Schema evolution is forward-only and refuses the unknown
The journal SHALL evolve through ordered forward-only migrations keyed by `PRAGMA user_version`, each in its own immediate transaction, and SHALL refuse to open a journal written by a newer schema.

#### Scenario: Older journal
- **WHEN** a host opens a journal with an older schema version
- **THEN** it MUST apply the pending migrations in order before serving requests

#### Scenario: Newer journal
- **WHEN** a host opens a journal with a newer schema version than it knows
- **THEN** it MUST fail with `store_incompatible` without modifying the file

### Requirement: Retention and storage are bounded
The journal SHALL bound stored output per turn and per sub-agent (see output truncation), SHALL bound the history kept in each session snapshot while counting all of it, and SHALL apply configurable retention to closed sessions.

#### Scenario: Retention sweep
- **WHEN** a closed session is older than the retention window
- **THEN** its record and events MUST be removed
- **AND** open sessions MUST never be removed by retention

#### Scenario: Long conversation
- **WHEN** a session accumulates more turns than the snapshot history bound
- **THEN** the snapshot MUST keep the most recent turns and the total turn count
- **AND** every event MUST remain readable through cursor replay
