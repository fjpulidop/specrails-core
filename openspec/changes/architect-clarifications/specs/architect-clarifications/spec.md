## ADDED Requirements

### Requirement: The architect lists clarifications before planning

`ARCHITECT_OUTPUT_SCHEMA` SHALL accept an optional `clarifications` array of at most five `{question, impact, default}` entries, where `impact` is `high`, `medium` or `low` and `default` is a string or `null` when no safe default exists. The architect instructions SHALL ask for the list before planning and SHALL state that a clear ticket has none.

#### Scenario: Clear ticket

- **WHEN** the architect reply has no clarifications
- **THEN** the run proceeds exactly as before and records an empty clarification list

#### Scenario: Malformed list

- **WHEN** a clarification has an unknown impact
- **THEN** Core spends the architect's single repair turn with an `Invalid architect clarifications` error

### Requirement: A high-impact question without a safe default pauses the run

Under `architect.clarifications: ask-on-high` (default), Core SHALL pause the run with the existing question interrupt when at least one `high` clarification has `default: null`, and SHALL feed the answer back to the architect as authoritative. Under `always-proceed` Core SHALL never pause for clarifications.

#### Scenario: High-impact question

- **WHEN** the architect reports a high-impact clarification without a default
- **THEN** the run pauses with that question as `pendingQuestion` before any artifact is required
- **AND** `resume --answer` re-runs the architect with the answer

#### Scenario: Always proceed

- **WHEN** the policy is `always-proceed`
- **THEN** the run continues and the architect records its defaults under Assumptions

### Requirement: Designs state their non-goals and assumptions

When the architect proceeds, Core SHALL require the change's `design.md` to contain a Non-Goals section with at least one line of content, and an Assumptions section when clarifications were listed. A missing section SHALL spend the architect's repair turn.

#### Scenario: Missing Non-Goals

- **WHEN** design.md has no Non-Goals content
- **THEN** the architect is asked in the same session to add it
- **AND** the run fails if the repaired design still lacks it

### Requirement: Hosts read clarifications from a run record

Core SHALL write `<backlogRoot>/.specrails/pipeline/<runId>/clarifications.json` when the architect pauses and when it proceeds, SHALL return it as `runtime-result.clarifications`, and SHALL announce `architectClarifications: 1` in `runtime api` and the integration contract.

#### Scenario: Proceeding with assumptions

- **WHEN** the architect proceeds on low-impact clarifications
- **THEN** the record has status `proceeded` and copies the Assumptions lines of design.md
