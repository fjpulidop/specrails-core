## ADDED Requirements

### Requirement: Planning and implementation gates are explicit
Both paired OpenSpec changes SHALL pass strict validation before implementation begins. C0, C1 and D0 SHALL use separate branches and reviewable PRs. Local pairing SHALL not count as C0 publication or D0 release acceptance.

#### Scenario: D0 is prepared before C0 publication
- **WHEN** paired local tests pass
- **THEN** its PR records implementation evidence and keeps published-Core acceptance pending

### Requirement: C1 decisions require three-platform evidence
C1 SHALL define exit criteria before experiments and report measured SQLite/packaging, subgraph and stream results on macOS arm64, Windows x64 and Linux x64. The SQLite candidate SHALL pass the 200-node crash/recovery test, WAL, permission policy, package/assembly checks and mean put latency below 5 ms. C3 SHALL not start while these decisions or evidence remain unresolved.

#### Scenario: Only local macOS evidence exists
- **WHEN** a spike report is produced
- **THEN** Linux and Windows acceptance remain pending and C1 is not declared complete

### Requirement: Robustness is a release gate
From C3, affected engine changes SHALL pass the cross-platform matrix covering crash boundaries, interrupted writes, competing leases, budgets, recursion, fail-fast, nested interrupts, immutable fork, identity mismatch, large output and cancellation. Tests SHALL use fixture providers and preserve existing coverage thresholds and legacy suites.

#### Scenario: A new engine feature passes happy-path tests only
- **WHEN** its robustness or required platform checks have not passed
- **THEN** the block remains incomplete and the PR records the missing evidence

### Requirement: Legacy retirement requires measured parity
C10 SHALL require published Desktop D8, demonstrated migration parity and two releases of telemetry with zero legacy launches. Earlier blocks SHALL preserve legacy code and tests, and retained original packages SHALL remain available for old runs.

#### Scenario: No legacy launches were observed in only one release
- **WHEN** retirement is considered
- **THEN** C10 remains gated and no legacy implementation is removed

### Requirement: Documentation matches shipped capabilities
Each block SHALL update its narrow Core documentation and contract, record dated decisions and validation evidence, and coordinate relevant Desktop/Web documentation. Final integrated implementation SHALL update all three repositories without presenting planned features as available before release.

#### Scenario: C0 documentation is published
- **WHEN** users read runtime capabilities
- **THEN** they see corrected current metadata and clearly staged v2 work, not a claim that the new engine already executes definitions

