## ADDED Requirements

### Requirement: Transport capabilities govern context reuse
Core SHALL determine continuation and effort support for the actual provider transport and SHALL preserve full role context when continuation is unknown or unsupported. A session identifier alone MUST NOT establish support. A supported adapter MUST prevent a follow-up packet from silently running as a fresh session and report inability to resume before inference.

#### Scenario: Transport cannot guarantee restored history
- **WHEN** a CLI can accept resume arguments while silently starting a new session
- **THEN** Core classifies continuation as unknown/unsupported and sends full context

#### Scenario: Desktop queries installed transport support
- **WHEN** runtime capabilities is called for configured roles
- **THEN** Core returns the versioned provider/model/transport capability response from contracts.md without inference or mutation
- **AND** unknown effort support is not inferred from a generic provider catalog

#### Scenario: A sessionless provider returns an identifier
- **WHEN** an API or Kimi ACP invocation returns a session ID without confirmed continuation capability
- **THEN** its next invocation receives full current role instructions, repository context and handoff
- **AND** metrics identify full context rather than a resumed session

#### Scenario: Confirmed continuation receives a correction
- **WHEN** the role session identity matches and the adapter confirms continuation
- **THEN** Core sends the correction, current acceptance obligations and changed context entries without repeating unchanged repository context
- **AND** official OpenSpec skill execution and required source reads remain mandatory

### Requirement: Repository context is bounded and explicit
Core SHALL persist a versioned repository context snapshot, revalidate source identities before reuse, and allocate its 20,000-character body fairly across admitted repositories with explicit omissions and readable source references.

#### Scenario: Multiple repositories exceed the context budget
- **WHEN** repository facts exceed the shared context budget
- **THEN** every admitted repository retains its identity and references
- **AND** omitted content is explicitly marked instead of silently dropping later repositories

#### Scenario: Repository instructions change
- **WHEN** a context source changes between invocations
- **THEN** its identity and packet are updated before invoking the agent
- **AND** the session receives the changed information or a full replacement when compatibility is uncertain

#### Scenario: Repository guidance is removed
- **WHEN** a previously included AGENTS.md or referenced source is deleted
- **THEN** the replacement repository entry identifies removed sources and revokes obsolete facts in the next packet

### Requirement: Session fallback is classified and bounded
Core SHALL allow at most one fresh-session fallback per role invocation for confirmed missing, expired or unsupported sessions, within existing budgets. Model, effort, scope, transport, role, prompt or OpenSpec identity changes SHALL start a fresh compatible session.

#### Scenario: Authentication fails on a resumed call
- **WHEN** the provider reports an authentication or access failure
- **THEN** Core reports the failure without a second paid invocation or model escalation

#### Scenario: Saved session has expired
- **WHEN** a continuation returns a classified session-expired result and budget remains
- **THEN** Core invokes once with full current context and records a session-fallback invocation
- **AND** another failure does not recursively retry

### Requirement: Incremental review recertifies the complete candidate
Core SHALL persist rejected and approved review manifests and session identities, compare against the previous reviewed candidate, and require a fresh complete acceptance response for each candidate. It MUST NOT inherit prior met criteria as current evidence.

#### Scenario: Developer fixes a rejected candidate
- **WHEN** compatible manifests and a reviewer session exist after a correction
- **THEN** the reviewer receives the changes since its prior review, unresolved findings and current verification evidence
- **AND** the reviewer evaluates every current acceptance criterion

#### Scenario: A shared contract changes within permitted scope
- **WHEN** permitted public-contract, lockfile, build/security changes or incomplete manifests invalidate incremental assumptions
- **THEN** Core supplies full review context while retaining prior findings and unchanged acceptance floors

#### Scenario: Frozen scope is modified
- **WHEN** an unauthorized scope or frozen-artifact change is detected
- **THEN** existing integrity gates block or invalidate the run before context-mode selection
- **AND** full context cannot substitute for authorization or restore validity

### Requirement: Planning remains official and proportional
Core SHALL support optional bounded focused/full planning metadata without an additional classification invocation. Missing metadata or cross-repository, security, migration or public-contract risks SHALL select full planning. Both modes MUST produce the official OpenSpec artifacts and preserve all acceptance requirements.

#### Scenario: Small local feature follows an existing pattern
- **WHEN** the architect identifies a verified local reference pattern and no full-planning trigger
- **THEN** it can produce concise focused artifacts using official OpenSpec procedures
- **AND** the developer still executes OpenSpec apply

### Requirement: Escalation is explicit and deterministic
Core SHALL accept an optional single same-provider escalation tier with explicit base/higher model IDs and transport-supported effort. Route decisions SHALL be persisted before invocation and remain monotonic across resume. Escalation MUST NOT add attempts or relax limits.

#### Scenario: Third allowed attempt escalates after two failed candidates
- **WHEN** initial candidate and first correction fail verification or review and maxAttempts is three
- **THEN** the next invocation uses the configured higher tier with fresh session context
- **AND** cost, time and attempt accounting include every tier and failure

#### Scenario: Attempt budget leaves no escalation slot
- **WHEN** two candidate attempts fail and maxAttempts is two
- **THEN** Core stops without creating another invocation to escalate

#### Scenario: Architect needs deeper analysis
- **WHEN** the existing low-confidence deepen is allowed and an escalation tier is configured
- **THEN** that existing deepen uses the higher tier without creating another planning call

#### Scenario: Reviewer rejects correctable implementation work
- **WHEN** the reviewer returns a valid rejection
- **THEN** the rejection is delivered to the developer without escalating the reviewer

#### Scenario: Reviewer output is malformed
- **WHEN** the existing single protocol repair is allowed and escalation is configured
- **THEN** the higher tier replaces that repair invocation
- **AND** no additional repair is granted

#### Scenario: A sessionless role needs its allowed repair or deepen
- **WHEN** the logical one-repair or one-deepen limit and workflow budget permit another invocation
- **THEN** Core supplies full instructions, bounded prior response, diagnosis and current handoff
- **AND** eligibility does not depend on sessionId and logical repair/deepen limits remain one

#### Scenario: Requested effort is unsupported
- **WHEN** the selected transport cannot enforce the requested effort or required limits
- **THEN** admission fails with a precise configuration reason before paid invocation
- **AND** an omitted effort remains provider default with observed effort unknown unless reported

### Requirement: Saved runs retain compatible runtime semantics
Core SHALL advertise versioned optional API1 capabilities, freeze runtime/configuration identity at admission, and use workflow5/instructions7 only for new compatible jobs. It MUST NOT rewrite legacy frozen requests or checksums to resume them.

#### Scenario: A legacy v4 run has its original runtime available
- **WHEN** Desktop resolves proven original package identity for a saved v4 request
- **THEN** continuation uses that original runtime and preserves its saved semantics

#### Scenario: Original runtime provenance is unavailable
- **WHEN** an old request lacks package identity and no trustworthy original-runtime resolution exists
- **THEN** the run remains inspectable and continuation reports how to restore the original runtime
- **AND** no incompatible paid attempt starts
