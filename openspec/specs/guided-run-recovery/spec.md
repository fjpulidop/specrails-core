# guided-run-recovery Specification

## Purpose
Allow operators to inspect and minimally repair preserved failed workflow runs using their original saved engine state and worktrees, without bypassing execution safety or fabricating completion evidence.

## Requirements

### Requirement: Engine-aware saved run detection
Recovery SHALL derive the engine from saved store presence without a request flag or persisted discriminator. V2 run.sqlite SHALL take precedence over a legacy checkpoint when both exist. The message 'Recovery requires an existing saved run' SHALL be returned only when neither store exists.

#### Scenario: V2 saved run
- **WHEN** a failed run has run.sqlite in its agent-workflow directory and no checkpoint.json
- **THEN** recovery reads its saved v2 state and does not report that no saved run exists

#### Scenario: Legacy saved run
- **WHEN** a run has only its legacy checkpoint.json
- **THEN** recovery retains the existing legacy behavior and validates the original envelope

#### Scenario: Missing stores
- **WHEN** neither store exists
- **THEN** recovery returns 'Recovery requires an existing saved run'

#### Scenario: Both stores or unreadable v2 store
- **WHEN** run.sqlite exists alongside a legacy checkpoint but its state cannot be safely read
- **THEN** recovery fails with an actionable recovery_unsupported_engine error for the requested action instead of falling back to legacy state or reporting a missing run

### Requirement: Inspect original run evidence
On a failed v2 implementation run with authoritative saved journal evidence, inspect SHALL return repositories, status, next step, registered saved checks, current verification validity with reasons, and recent recovery attempts. Recovery SHALL validate the supplied context against saved scope. History SHALL retain its existing pagination and record shape across engines.

#### Scenario: Inspect a failed v2 implementation
- **WHEN** inspect targets a failed v2 run with run.sqlite and its saved implementation journal
- **THEN** it returns the original repositories and saved checks, current validity reasons and up to ten recent recovery attempts without requiring a legacy checkpoint

#### Scenario: Read-only observation
- **WHEN** inspect, history, list_files, read_file or diff runs on an idle v2 run
- **THEN** it does not mutate run.sqlite, change its permissions, migrate its schema or create a checkpoint

#### Scenario: Paginated history
- **WHEN** history is requested with an offset
- **THEN** attempts are returned newest first in pages of twenty with total and nextOffset when needed from the same recovery-history.json location used by legacy runs

#### Scenario: Missing or ambiguous authority
- **WHEN** an action cannot establish its required saved scope, candidate, checks or archive evidence
- **THEN** it fails with recovery_unsupported_engine naming the action and an actionable alternative without fabricating evidence or modifying files

### Requirement: Safe preserved worktree access
Recovery SHALL implement list_files, read_file and diff within the original admitted repository worktrees using the existing portable safePath rules, symlink containment, forbidden-path list and bounded results. It SHALL neither regenerate work nor invoke providers.

#### Scenario: Read and compare original files
- **WHEN** list_files, read_file or diff targets an allowed repository-relative path in the preserved v2 worktree
- **THEN** it returns the existing bounded listing, content with hash, or diff respectively

#### Scenario: Protected or escaping paths
- **WHEN** a file action targets traversal, a platform alias, an escaping symlink, .git, .specrails, node_modules, .env or an .env-prefixed secret variant
- **THEN** recovery refuses access under the same protections as legacy recovery

### Requirement: Guarded idempotent patch
Patch SHALL require expectedHash, exactly one oldText occurrence, an actual replacement, operationId and reason. It SHALL use atomic publication and the existing write-ahead Attempt format in recovery-history.json. An identical operationId SHALL replay the recorded outcome, while a changed request with that ID SHALL fail.

#### Scenario: Patch a failed v2 run
- **WHEN** a safe v2 patch supplies the current hash and exactly-once oldText
- **THEN** it atomically updates the original file and durably records before/after hashes and the outcome

#### Scenario: Patch replay and uncertain publication
- **WHEN** an identical operationId is retried after completion or an uncertain publication
- **THEN** the recorded outcome is replayed, a pending patch is reconciled by its after-hash, and the replacement is never blindly applied twice

#### Scenario: Invalid patch
- **WHEN** expectedHash is stale, oldText is missing or repeated, the replacement changes nothing, or the target is a frozen plan or instruction file
- **THEN** the file is unchanged and the patch is refused

### Requirement: Bounded saved checks and retry guard
Check SHALL execute only OpenSpec validation or a saved verification checkId under the existing deadline and output bounds, recording real results in recovery history. Repeated failed, interrupted or pending checks on an unchanged candidate SHALL require changedPrecondition. Checks SHALL never grant acceptance, complete phases or manufacture workflow certification.

#### Scenario: OpenSpec check
- **WHEN** check kind openspec runs on a supported failed v2 run
- **THEN** real validation executes and its report is recorded, with empty or unsuccessful reports treated as failures

#### Scenario: Registered verification check
- **WHEN** check kind verification supplies an inspect-listed saved checkId
- **THEN** only that saved command executes with the existing 45-second deadline and records its real scoped outcome

#### Scenario: Unchanged failed candidate
- **WHEN** a new operationId repeats a failed check against the same current candidate without changedPrecondition
- **THEN** recovery refuses the retry before executing a command

#### Scenario: Check replay and command rejection
- **WHEN** a completed or pending check operationId is retried, or a caller supplies an arbitrary command
- **THEN** recovery respectively replays or marks uncertain outcome interrupted without rerunning, or rejects the invalid request

### Requirement: Engine-compatible write exclusion and lifecycle guards
Patch and check SHALL use the engine's cross-process execution lease and preserve recovery-history serialization. Active executors SHALL exclude recovery mutations regardless of acknowledgeInterrupted. Running or interrupted saved steps SHALL require acknowledgeInterrupted before mutation. Succeeded or archived runs SHALL refuse repair. Missing candidate or archive authority SHALL fail closed.

#### Scenario: Active v2 executor
- **WHEN** another executor owns a live v2 lease and patch or check is requested
- **THEN** recovery refuses mutation even if interrupted writes are acknowledged

#### Scenario: Interrupted v2 run
- **WHEN** a run is saved as running or any current scoped step is running or interrupted and patch or check lacks acknowledgeInterrupted
- **THEN** recovery refuses the mutation; acknowledgement permits it only after all other safety gates and lease admission succeed

#### Scenario: Finished or archived work
- **WHEN** patch or check targets a succeeded or archived run
- **THEN** repair is refused while supported observational actions remain available

#### Scenario: Abort or lost lease
- **WHEN** a repair is cancelled or its lease is lost
- **THEN** no further effects are admitted, owned checks are stopped, uncertain work is recorded honestly, and resources are released after subprocess settlement

### Requirement: Actionable unsupported error across Desktop transport
An unsafe v2 action SHALL produce recovery_unsupported_engine with its action, recommendation and actionable message. Desktop SHALL preserve that code through the retained Core subprocess and return HTTP 409 with error recovery_unsupported_engine and the recommendation in message. Generic blocks SHALL retain runtime_recovery_blocked and Desktop's existing idle gate.

#### Scenario: Unsupported action reaches operator
- **WHEN** Core rejects an action because v2 safety cannot be established
- **THEN** Desktop exposes recovery_unsupported_engine distinctly from runtime_recovery_blocked and includes the requested action and recommended alternative in the message

#### Scenario: Legacy or uncertain transport failure
- **WHEN** Core returns a legacy string error, malformed output, or the subprocess times out without a valid unsupported error
- **THEN** Desktop retains the existing generic block and uncertain-outcome guidance instead of inventing an unsupported classification
