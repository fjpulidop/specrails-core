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

