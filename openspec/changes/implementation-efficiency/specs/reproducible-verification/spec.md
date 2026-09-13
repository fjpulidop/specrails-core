## ADDED Requirements

### Requirement: Verification remains deterministic execution
Core SHALL retain verify between developer and reviewer, execute admitted commands without an additional AI verifier, and keep semantic acceptance review with the reviewer. Required failed checks MUST return to the developer before reviewer invocation.

#### Scenario: A required test fails
- **WHEN** verification returns a failed required check
- **THEN** Core preserves its evidence and schedules the allowed developer correction
- **AND** no reviewer invocation is purchased for that candidate

### Requirement: Developer checks are additive and validated
Core SHALL accept optional flat structured verificationChecks, validate the complete response before materialization, preserve mandatory host/architect baseline checks and persist accepted additions across corrections. It MUST NOT execute prose, ignore malformed present checks, or accept agent-supplied reuse/independence/pass guarantees.

#### Scenario: A later correction omits an accepted check
- **WHEN** the developer returns no new proposals
- **THEN** the previously accepted checks remain in the effective plan

#### Scenario: A proposal changes an existing harness
- **WHEN** the same developer key has a different semantic definition
- **THEN** Core creates an immutable revision and invalidates prior evidence for that definition
- **AND** only the new revision remains active/required while the old revision is historical
- **AND** the host/architect baseline cannot be overwritten

#### Scenario: A proposal is malformed or escapes its scope
- **WHEN** a proposal contains invalid fields, paths, runner arguments or exceeds the limits in contracts.md
- **THEN** role acceptance returns a bounded protocol error before any harness write or command spawn

#### Scenario: Two origins propose the same normalized check
- **WHEN** semantic command, repository, environment, timeout and harness identities match
- **THEN** one execution satisfies that check while evidence retains every origin
- **AND** conflicting host policies combine restrictively and developer duplicates cannot add reuse/independence guarantees

### Requirement: Harness source survives the agent invocation
Core SHALL materialize admitted bounded UTF-8 harness sources in immutable run-state storage outside delivery, with a validated entrypoint and structured runner arguments. Agents MUST NOT receive write access to the state journal. Existing verification authority and cancellation controls SHALL apply to harness execution.

#### Scenario: A project has no package manifest
- **WHEN** the developer proposes an admitted standalone harness for static application logic
- **THEN** Core stores source, hashes and an execution record and runs it with SPECRAILS_CHECK_REPO_ROOT pointing to the admitted repository
- **AND** the reviewer can retrieve the harness and its evidence even if temporary application files are removed

#### Scenario: Materialization fails partway
- **WHEN** a source write fails before the manifest is atomically activated
- **THEN** no partial plan is executable and recovery preserves the previous valid plan

### Requirement: Evidence binds the current complete plan
Core SHALL persist versioned plans and receipts binding normalized checks, origins, policies, scope, candidate, harnesses, environment and required input/toolchain identities. Any effective plan change SHALL invalidate verification, acceptance, review and archive approval as specified in the design.

#### Scenario: A command changes without application edits
- **WHEN** command arguments, timeout, environment, harness or scheduling/reuse policy changes
- **THEN** the plan identity changes and old acceptance cannot complete or archive the candidate

#### Scenario: A later scoped check fails
- **WHEN** a scoped failure follows an earlier successful full verification
- **THEN** the earlier success cannot authorize completion or satisfy a new full receipt

#### Scenario: Output exceeds storage limits
- **WHEN** check stdout or stderr exceeds its persisted 1 MiB cap
- **THEN** evidence exposes digests, counts, retained output and explicit truncation
- **AND** the bounded reviewer tail is not represented as the complete log

### Requirement: Reuse requires explicit complete identity
Core SHALL default reuse to never. Only a host-declared snapshot-local deterministic read-only check with complete bounded input/dependency/toolchain identities and the current noninvalidated successful receipt SHALL be eligible. Unknown identity MUST cause execution with a stated reason.

#### Scenario: Dependency contents change with an unchanged lockfile
- **WHEN** node_modules or another declared ignored input changes
- **THEN** prior evidence is ineligible even if tracked source and lockfiles match

#### Scenario: Check relies on a mutable external service
- **WHEN** the service state cannot be captured as an admitted immutable input
- **THEN** Core reruns the check and records reuse-ineligible

#### Scenario: A current result is reusable
- **WHEN** plan, source, inputs, toolchain and environment identities match before reuse and completion
- **THEN** Core records a reuse event referring to the original successful execution
- **AND** it does not replay original duration or turn that event into a fictitious subprocess

#### Scenario: A nonterminal workflow resumes after verify completed
- **WHEN** pending reviewer/archive work relies on a saved verify checkpoint with reuse never
- **THEN** the new invocation reruns required nonreusable checks and recertifies downstream authorization
- **AND** checkpoint completion cannot bypass the reuse policy

#### Scenario: User reads an already archived result
- **WHEN** status or historical evidence is requested for a terminal workflow
- **THEN** no test or archive action executes again

### Requirement: Parallelism is bounded and declared
Core SHALL default check concurrency to one and cap it at four. Only contiguous host-declared independent checks sharing a nonempty group in distinct admitted repositories without overlapping resource keys SHALL overlap, with at most one active check per repository. Developer-only and undeclared checks SHALL be serial. Missing resources SHALL mean unknown independence; explicit empty resources SHALL mean no declared shared resources. Serial entries, group changes and conflicts MUST act as barriers without reordering.

#### Scenario: Two independent repositories have checks
- **WHEN** their host policies establish independence and available concurrency permits
- **THEN** both can execute with repository/check-attributed output and the same final verdict as serial execution

#### Scenario: One concurrent check fails or the run is cancelled
- **WHEN** a failure or cancellation occurs
- **THEN** Core stops scheduling, terminates and awaits active process trees, records individual outcomes and does not publish a successful full receipt

#### Scenario: Check timeout exceeds remaining workflow time
- **WHEN** a check is scheduled close to the workflow deadline
- **THEN** execution is capped at the remaining deadline and process settlement is awaited before any next agent phase

### Requirement: Evidence retrieval is scoped and durable
Core SHALL expose the bounded schema1 evidence CLI in contracts.md using opaque run-local evidence/source IDs and bound cursors. It MUST NOT accept file paths as retrieval authority or require a live worktree to read historical persisted evidence.

#### Scenario: API and CLI reviewers inspect a saved harness
- **WHEN** a reviewer uses the scoped read_verification_evidence tool through an API adapter or CLI MCP binding
- **THEN** it can discover multi-file source IDs and retrieve source plus a second stdout page using the same resolver as the CLI
- **AND** generic filesystem tools still cannot access the state journal

#### Scenario: Worktree has been cleaned up
- **WHEN** retained run state contains verification evidence
- **THEN** read-only historical evidence retrieval succeeds and labels the original candidate
- **AND** it makes no claim about validity against an unavailable current candidate

#### Scenario: A caller supplies a cross-run source or cursor
- **WHEN** an ID or cursor does not belong to the requested evidence scope
- **THEN** retrieval fails without arbitrary file access or command execution
