## ADDED Requirements

### Requirement: The reviewer may return an advisory risk brief

`REVIEW_OUTPUT_SCHEMA` SHALL accept an optional `brief` object with optional sections `behaviourChanges`, `invariantsTouched`, `untested`, `risks`, `humanChecks` and `divergences`. The reviewer instructions SHALL ask for the brief after the verdict and SHALL state that every risk names a `file:line` reference, that `untested` lists code paths the diff touches which no test in the verification plan exercises, that `humanChecks` lists what cannot be verified read-only, and that `divergences` is reserved and may be empty.

#### Scenario: Older reviewer reply

- **WHEN** the reviewer reply has no `brief`
- **THEN** the review is evaluated exactly as before and no brief is recorded

#### Scenario: Empty brief

- **WHEN** the reviewer reply carries `"brief": {}`
- **THEN** the brief is accepted and recorded as an empty brief

### Requirement: The brief never changes the approval gate

The approval decision SHALL depend only on the verdict, score, aspects, issues and acceptance evidence. The brief SHALL NOT be read by the review policy.

#### Scenario: High risks on an approval

- **WHEN** an otherwise approving reply carries several `high` risks
- **THEN** the review approves and the run archives

### Requirement: Risks are capped and ordered deterministically

Core SHALL order `risks` by severity (`high`, `medium`, `low`), stable within a severity, keep the first five, and append each remaining risk to `acceptance.findings` as one line naming its severity, area, `whatToLookAt` and `ref`.

#### Scenario: Seven risks

- **WHEN** the reviewer reports seven risks of mixed severity
- **THEN** the brief keeps the five most severe in severity order and the two least severe appear in `acceptance.findings`

### Requirement: A malformed brief is repaired once, then dropped

A brief that is not an object, has a non-array section, an item missing a required field, or a value outside its enum SHALL fail the first reply with `Invalid review brief: …`, spending the reviewer's single structured-output repair turn. When the repaired reply still carries a malformed brief, Core SHALL keep the repaired verdict, drop the brief and record a diagnostic instead of failing the review.

#### Scenario: Repaired brief

- **WHEN** the first reply has a risk with an unknown severity and the repaired reply has a valid brief
- **THEN** the review uses the repaired reply and records its brief

#### Scenario: Still malformed after repair

- **WHEN** both replies carry a malformed brief
- **THEN** the review completes with no brief and `briefDiagnostic` explains why it was dropped

### Requirement: Hosts can read the brief at settle

At every reviewer verdict Core SHALL write `<backlogRoot>/.specrails/pipeline/<runId>/review-brief.json` as `{schemaVersion: 1, change, approved, score, recordedAt, brief | null, diagnostic?}`. The engine 1 `runtime-result` SHALL carry the same record as `reviewBrief` (or `null`). An approved verdict SHALL include the brief in `confidence-score.json`. The reviewer step output SHALL carry `brief` and `briefDiagnostic` when present. `runtime api` SHALL advertise `reviewBrief: 1` and `integration-contract.json` (schema 5.3) SHALL describe these locations under `agentRuntime.reviewBrief`.

#### Scenario: Rejected verdict

- **WHEN** the reviewer rejects with a brief
- **THEN** `review-brief.json` records `approved: false` and the brief
