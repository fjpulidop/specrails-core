## ADDED Requirements

### Requirement: Roles declare enforceable permissions
Core SHALL resolve built-in and declared roles through explicit descriptors containing access and artifact permissions. Provider invocation and OpenSpec write permissions SHALL enforce these descriptors independently of prompt text. Configurations without custom roles SHALL retain built-in behavior and argv snapshots.

#### Scenario: A custom read-only role requests a write
- **WHEN** a declared read-only role invokes provider tools or OpenSpec artifacts outside its permissions
- **THEN** the adapter applies read-only access and rejects forbidden artifact writes

#### Scenario: Existing configuration omits roles
- **WHEN** the architect, developer and reviewer run with the legacy configuration
- **THEN** their provider argv remains identical to the accepted baseline snapshots

### Requirement: Free prompts and native commands preserve provider contracts
The `prompt` piece SHALL execute without role instructions, render supported native commands using the provider strategy, classify transport errors for bounded retry and maintain a session only when its frozen identity matches. Capture, verification sentinel and blocked sentinel behavior SHALL follow shared contract section 4.1.

#### Scenario: A provider does not support a native command
- **WHEN** the node requests an unsupported command
- **THEN** it fails with `native_command_unsupported` before executing a different command

#### Scenario: Verification text omits a sentinel
- **WHEN** a verification-sentinel prompt ends without a PASS or FAIL marker
- **THEN** it routes to fail with `missing_sentinel`

### Requirement: Verification evidence tracks the current candidate
The `verify` piece SHALL produce deterministic receipts using existing verification semantics and bind a passing receipt to the candidate. Later write effects SHALL invalidate that verification. A required-verification terminal SHALL not report verified completion with stale or absent evidence.

#### Scenario: Code changes after a passing verify
- **WHEN** a later write piece completes
- **THEN** verified state is cleared and a required-verification success terminal returns `completion.ok: false` with `unverified`

### Requirement: Infrastructure errors and business verdicts remain distinct
Pieces SHALL use the outcome labels and error classification in shared contract section 4. A reviewer rejection or exhausted business correction SHALL complete the run successfully with `completion.ok: false`; execution failures SHALL use failed status and exit 1.

#### Scenario: Implementation is rejected after allowed corrections
- **WHEN** the implementation subgraph reaches a valid negative verdict
- **THEN** the CLI exits 0 with succeeded status and false completion

### Requirement: Reusable components and fan-out are bounded
Core SHALL implement components, implementation subgraphs and map/join through supported LangGraph primitives proven by C1. Concurrency SHALL be shared across AI pieces, default to one and respect the schema maximum of eight; transitions and budgets SHALL cover branches and nested nodes.

#### Scenario: Two mapped tickets share concurrency one
- **WHEN** both branches are ready to invoke AI
- **THEN** at most one AI invocation runs and join evaluates the selected collect/all-ok/any-ok policy after its branches settle

### Requirement: Piece behavior is versioned
The published catalog SHALL enumerate each implemented piece's parameter schema, effects, outcomes and executor. A behavior change SHALL increment `nodeKindsVersion`, and retained runs SHALL continue with their frozen package semantics.

#### Scenario: A new piece is added
- **WHEN** the implementation becomes available
- **THEN** registry, catalog, integration contract, parameter validation, tests and documentation agree on its descriptor


### Requirement: Blocked decisions retain their human continuation
A decider SHALL recognize an explicit structured blocked verdict or a LOOP_BLOCKED question without treating that question as malformed output. It SHALL persist the read-only decision before interrupting and resume its continue outcome with the human answer recorded, without another provider invocation for that decision. Other malformed responses SHALL retain the bounded single-repair policy.

#### Scenario: A decider asks which repository to inspect
- **WHEN** the run is reopened and the pending question is answered
- **THEN** the saved decision is reused, the next step receives the answer in history and physical invocation usage is not counted twice

#### Scenario: A human pause follows a no-progress observation
- **WHEN** the decider waits for a human response
- **THEN** the prior candidate identity and no-progress count are preserved without advancing them or certifying completion

### Requirement: Scoped workflow assignments are explicit and bounded
Core SHALL provide a non-AI assign piece that returns one atomic update to scoped workflow variables. It SHALL support setting JSON values and incrementing existing safe integers without executable expressions, provider calls or external side effects. Invalid names, overlapping operations, noninteger counters and overflow SHALL fail before any variable is changed.

#### Scenario: A retry allowance survives a human pause
- **WHEN** a workflow increments a phase counter, pauses and resumes
- **THEN** its committed counter remains available and is not incremented again by replay of that completed assignment

#### Scenario: One counter in an assignment is invalid
- **WHEN** a multi-variable update includes an absent or invalid counter
- **THEN** no partial variable update is committed

#### Scenario: Parallel branches use the same variable name
- **WHEN** scoped branches assign their own counters
- **THEN** neither branch mutates another branch's input state

### Requirement: Required work prevents a premature decision stop
A decider SHALL accept an optional bounded continueWhen expression over scoped state. When it evaluates true, a valid stop proposal SHALL become a continue decision before no-progress accounting. The provider invocation SHALL still occur and its proposal SHALL remain identifiable in output. Publication SHALL reject invalid expressions. A blocked human decision SHALL retain its existing pause and continuation behavior.

#### Scenario: A required phase has failed
- **WHEN** continueWhen observes the retained failure flag and the provider proposes stop
- **THEN** the workflow continues without erasing the obligation and unchanged candidates still reach the no-progress limit

#### Scenario: The failed obligation is repaired
- **WHEN** a later visit observes a cleared failure flag
- **THEN** the decider may accept a valid stop proposal

### Requirement: Historical OpenSpec targets are explicit compatibility skips
OpenSpec validation and archive pieces SHALL accept optional allowArchived. When enabled, an absent active target with an exact real archived directory inside the frozen artifact root SHALL produce an explicit skipped result without claiming validation or verification evidence. An active target SHALL always take precedence, and symlink paths SHALL remain forbidden. An optional repositoryId assertion SHALL reject a different artifact repository before running a command.

#### Scenario: A converted lifecycle encounters its already archived target
- **WHEN** allowArchived is enabled and the exact target is already archived
- **THEN** the piece proceeds without recreating or archiving it again, and successful delivery still requires current host verification

#### Scenario: An active target shares an archived name
- **WHEN** an active change exists
- **THEN** the normal pinned OpenSpec operation runs instead of trusting the historical directory
