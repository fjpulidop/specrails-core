## ADDED Requirements

### Requirement: Core owns full verification
Programmatic developer instructions SHALL reserve complete verification for Core while allowing focused checks during development. Core SHALL continue to execute and validate the full configured plan against the exact candidate.

#### Scenario: Successful development
- **WHEN** the developer finishes its focused checks
- **THEN** Core executes the complete plan and does not accept the developer's summary as a substitute receipt

### Requirement: Efficient scoped tools
API agents SHALL have bounded literal search, line-range reads and workspace diff; only developers SHALL have exact-match patch capability. These tools MUST preserve existing root, metadata, binary-file and symlink restrictions.

#### Scenario: Small edit
- **WHEN** a developer patches one uniquely matching fragment
- **THEN** only that fragment changes atomically without requiring the model to regenerate the file

#### Scenario: Invalid or stale edit
- **WHEN** an edit has ambiguous context, a stale supplied hash, or a protected target
- **THEN** it fails without changing the file

#### Scenario: Bounded inspection
- **WHEN** a search or range/diff exceeds its limits
- **THEN** the response explicitly reports truncation and contains no protected content

### Requirement: Durable efficiency accounting
Core SHALL report per-phase attempts, cost, input/output tokens, optional cache counters, completed provider calls, tool-call counts and wall durations. Failed and repeated calls MUST remain included and unknown values MUST NOT become zero. Reports MUST exclude transcripts and credentials.

#### Scenario: Correction and resume
- **WHEN** a role retries or repairs its output and the run is resumed later
- **THEN** the report includes every recorded invocation once and repeated status reads do not change the totals

#### Scenario: Older checkpoint
- **WHEN** invocation/cache metadata is unavailable
- **THEN** existing status still works and missing detail is represented as unavailable

### Requirement: Desktop efficiency visibility
Desktop SHALL show available runtime efficiency totals and phase details from Core without changing execution controls or requiring the new fields from older Core releases.

#### Scenario: Unknown billing
- **WHEN** a provider has no authoritative dollar cost
- **THEN** the UI shows unavailable cost rather than zero or an estimated saving
