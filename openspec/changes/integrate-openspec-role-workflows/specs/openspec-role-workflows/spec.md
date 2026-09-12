## ADDED Requirements

### Requirement: Roles execute official OpenSpec workflows
The runtime SHALL load the pinned framework's actual workflow skill for each role and expose its required scoped operations using the selected provider's supported mechanism.

#### Scenario: Architect prepares a change
- **WHEN** an architect runs fast-forward
- **THEN** it obtains real OpenSpec instructions and writes the requested artifacts itself
- **AND** Core does not substitute document JSON for those operations

#### Scenario: Developer executes apply itself
- **WHEN** a developer implements the approved change
- **THEN** it executes the official openspec-apply-change skill and obtains the real apply instructions
- **AND** host-side readiness checks cannot substitute for the developer's workflow execution
- **AND** a developer that omits that workflow cannot advance to review

#### Scenario: Reviewer omits the official skill
- **WHEN** the reviewer returns a result without executing its assigned OpenSpec workflow
- **THEN** the runtime requests one bounded correction in the same role, reusing the provider session when available
- **AND** the reviewer must execute the workflow before its result is accepted
- **AND** a repeated omission blocks completion without rerunning valid implementation phases

#### Scenario: Loading a role includes its mandatory planning queries
- **WHEN** a developer or reviewer calls load_skill for the admitted change
- **THEN** the tool executes real OpenSpec status and instructions apply and returns their outputs with the unmodified official skill
- **AND** successful queries are recorded as originating from that role tool request, without counting host validation as participation
- **AND** failures do not record successful skill loading
- **AND** the role must still read the context files and perform its implementation or review

### Requirement: Role capabilities preserve scope
The runtime SHALL confine architect writes to the admitted change and prevent reviewer artifact mutations.

#### Scenario: Unauthorized artifact destination
- **WHEN** a role requests a write outside its allowed artifact scope
- **THEN** the tool rejects it without changing the destination

### Requirement: Framework checks supplement implementation evidence
The runtime SHALL require real OpenSpec state and validation alongside Specrails verification and acceptance evidence.

#### Scenario: Empty files appear complete
- **WHEN** OpenSpec status reports complete but required artifacts are empty or apply is blocked
- **THEN** the runtime refuses to advance to implementation

### Requirement: Archive and recovery preserve external semantics
The runtime SHALL synchronize deltas using OpenSpec and bind resumable runs to the framework and skill identities used at admission.

#### Scenario: Resume under changed skills
- **WHEN** a saved execution is resumed with incompatible framework or skill identities
- **THEN** execution fails before another paid role invocation

#### Scenario: Delta updates one requirement
- **WHEN** a verified change is archived
- **THEN** OpenSpec merges its deltas while preserving unaffected requirements

### Requirement: Continuations preserve repository access and pending work
The runtime SHALL preserve the admitted role access to all selected repositories on provider session continuation and SHALL resume unfinished corrections before invalidated later phases.

#### Scenario: Resume a blocked multi-repository correction
- **WHEN** developer work remains blocked and a later verification or review receipt is stale
- **THEN** continuation resumes the developer with all admitted writable roots
- **AND** a previous incorrectly selected reviewer does not strand the saved execution

### Requirement: Blockers and repository context are visible
The runtime SHALL provide bounded repository facts to every provider and report concrete incomplete-task reasons.

#### Scenario: Developer cannot make progress
- **WHEN** the developer reports incomplete tasks without changed source or tests
- **THEN** the workflow blocks with those reasons instead of spending automatic correction attempts

#### Scenario: Repository has no instruction file
- **WHEN** a role starts in a repository without agent instructions
- **THEN** it receives available manifest commands and project reference paths without fabricated conventions
- **AND** obsolete Specrails bootstrap advice cannot request nested implementation orchestration
