## ADDED Requirements

### Requirement: Checkpoint and terminal evidence commit atomically
Each v2 run SHALL persist checkpoints and ledger in one `run.sqlite` database with WAL, FULL synchronous writes, foreign keys and busy timeout. A node's committed checkpoint and terminal attempt/evidence/usage updates SHALL share an atomic transaction; a durable completed node SHALL not replay after a process crash.

#### Scenario: Crash occurs between checkpoint and ledger writes
- **WHEN** the process is killed at a tested boundary between those writes
- **THEN** recovery observes both committed records or neither and never contradictory completion

### Requirement: A run has one execution lease
Core SHALL reject a second execution owner while the existing lease is valid, renew ownership every 15 seconds and allow recovery after the 60-second expiry while recording that recovery.

#### Scenario: Concurrent resume is attempted
- **WHEN** two processes try to resume the same run while its lease is live
- **THEN** one executes and the other returns `lease_held` without replaying work

#### Scenario: The lease owner died
- **WHEN** a new invocation acquires an expired lease
- **THEN** it records `lease_recovered` and proceeds through the normal recovery checks

### Requirement: Interrupted writes require explicit recovery
Core SHALL distinguish interrupted read and write attempts. An unresolved write attempt SHALL block automatic resume with `recover_required` until the caller explicitly identifies the affected node path.

#### Scenario: A write process is killed mid-node
- **WHEN** the caller resumes without the required recovery input
- **THEN** Core reports the interrupted node and leaves the write unapplied by automatic replay

### Requirement: Human interruption and cancellation preserve durability
Approval, question and gate interruptions SHALL finish the CLI invocation with exit 2 and durable pending input. Resume SHALL accept only the appropriate input and continue from the checkpoint. Cancellation SHALL abort active descendants and persist a resumable cancelled state.

#### Scenario: A nested question pauses execution
- **WHEN** a component or map branch requests a question
- **THEN** pending input identifies the nested node, and a subsequent answer resumes it without repeating completed siblings

#### Scenario: Cancellation occurs during fan-out
- **WHEN** the host cancels a run with active child processes
- **THEN** all owned descendants terminate and committed results remain available for recovery

### Requirement: Fork preserves its source
Fork SHALL require an inactive source lease, create a distinct run ID from the checkpoint before the selected node path and record `forkOf`. Optional state updates SHALL be limited to the documented channels, and the source run SHALL remain unchanged.

#### Scenario: Fork selects a nested implementation node
- **WHEN** the caller forks from an available internal checkpoint
- **THEN** the new run links to the source and the original checkpoint history remains byte-equivalent

