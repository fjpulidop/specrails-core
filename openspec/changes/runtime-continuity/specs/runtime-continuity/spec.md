## ADDED Requirements

### Requirement: Bounded activity-aware calls
The runtime SHALL enforce a finite total deadline separately from an inactivity deadline, preserve explicit total limits, and identify the deadline that terminated the call.

#### Scenario: Active agent reaches old cutoff
- **WHEN** an agent emits activity beyond 15 minutes with default settings
- **THEN** activity prevents inactivity termination while the 60 minute total limit remains in force

### Requirement: Recover interrupted provider sessions
The runtime SHALL preserve validated session identity during execution and SHALL require explicit recovery for timed-out or cancelled writes. Supported identity-matched recovery SHALL request provider continuation; incompatible or unsupported contexts SHALL use a bounded fresh invocation.

#### Scenario: Developer times out after writing
- **WHEN** its process tree has stopped and the user explicitly recovers
- **THEN** prior files, progress and matching session identity remain available without rerunning completed phases

### Requirement: Bounded advisory progress and instructions
The runtime SHALL expose scoped, size-bounded progress read/write operations and return saved progress through the official skill binding. Large repository instructions SHALL be indexed for selective reads. Progress SHALL NOT count as verification or permission to modify frozen artifacts.

#### Scenario: Fresh fallback after interruption
- **WHEN** native session continuation is unavailable
- **THEN** the developer receives its saved next actions and blockers and a bounded instruction index, while checking current worktree state
