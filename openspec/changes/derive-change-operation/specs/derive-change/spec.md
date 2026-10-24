## ADDED Requirements

### Requirement: Derive an OpenSpec change from an existing diff

The engine SHALL provide a `derive-change` piece with outcomes `pass` and `fail`, effect `write` and `requiresAI`. Its closed parameters SHALL be `change` (required, the run's frozen change name), `summaryPath` (optional), `feedback` (optional) and the invocation timers. It SHALL measure the change set from each repository's base to its working tree and run the `deriver` engine role with that change set, the base commits and the summary.

#### Scenario: Fully explained diff archives

- **WHEN** a worktree reserved at `baseSha` has five changed files and the deriver names all five in design.md's Blast radius with all tasks checked
- **THEN** the piece returns `pass` with `derivation.files` 5 and `explained` 5, and the reference definition verifies, reviews, archives the change and verifies again with valid receipts

#### Scenario: Empty diff

- **WHEN** no file differs from the base
- **THEN** the node fails with error code `empty_change_set` and no provider is called

### Requirement: Core measures coverage deterministically

The piece SHALL compute coverage itself: every changed path SHALL appear in design.md's `## Blast radius` section as a whole path, or it SHALL be listed in `unexplainedFiles`. It SHALL write `derivation.json` with `base`, `head`, `files`, `explained`, `unexplainedFiles`, `tasks`, `requirementsAdded`, `requirementsModified`, `confidence` and `transcriptTurnsUsed` to its artifact directory and return the same report and its path in its output. Unexplained files SHALL NOT fail the node.

#### Scenario: One unexplained file

- **WHEN** design.md's Blast radius omits one of five changed files
- **THEN** the piece returns `pass` with `explained` 4 and that file in `unexplainedFiles`

### Requirement: Invalid derivations are repaired once

The piece SHALL return `fail` with a history note and a repair note when a task is unchecked, an artifact is missing, `openspec validate --strict` fails or the archive preflight fails. The next visit SHALL send the repair note to the deriver.

#### Scenario: Validation fails then is repaired

- **WHEN** the first derivation has a requirement without a scenario and an unchecked task
- **THEN** the piece returns `fail`, and the second visit's prompt contains the rejection, and a valid second derivation passes

### Requirement: The summary stays inside the run directory

`summaryPath` SHALL resolve inside `.specrails/pipeline/<runId>/` without `..` segments, absolute paths or symlinks, and the file SHALL be at most 32 KB. An absent parameter, a missing file or an empty file SHALL mean deriving from the diff alone.

#### Scenario: Escaping path rejected

- **WHEN** `summaryPath` is `../secrets.txt`
- **THEN** the definition is rejected at validation, and the runtime check rejects it as well

### Requirement: The reviewer treats unexplained files as issues

A reviewer role turn in a run with a committed derivation SHALL receive the coverage report, and its instructions SHALL require one issue per unexplained file. The approval gate SHALL be unchanged.

#### Scenario: Reviewer sees the gap

- **WHEN** the derivation has an unexplained file
- **THEN** the reviewer prompt lists it under the derivation coverage rule

### Requirement: The deriver's verification proposals bind the host plan

The piece SHALL return the deriver's verification proposals (architect schema, at most 20) as `output.structured.verification`, so a `verify` node with `additionalCommandsFrom` naming the derive node runs them.

#### Scenario: Proposed check runs

- **WHEN** no check is configured and the deriver proposes one
- **THEN** both verify nodes of the reference definition run it

### Requirement: A correction round is re-derived in place

When `feedback` is non-blank, the deriver task SHALL contain a `## Re-derivation after a correction round` section after the conversation summary and before any repair note. It SHALL require updating the existing change in place, describing every behaviour the code now implements without reverting code, keeping design.md consistent with the code and listing the new work as checked tasks. Coverage, tasks and validation SHALL be recomputed from the updated files.

#### Scenario: Findings reach the re-derivation

- **WHEN** a correction round changed the code and `derive` runs again with the reviewer's findings as `feedback`
- **THEN** the deriver prompt contains the re-derivation section with the findings, and the second derivation reports the task the deriver added to the existing change

#### Scenario: Blank feedback

- **WHEN** `feedback` is empty or whitespace
- **THEN** the deriver task has no re-derivation section

### Requirement: Correction findings are bounded untrusted data

The findings SHALL be rendered inside a `text` fence they cannot close, bounded to 8,000 characters.

#### Scenario: Oversized findings with a fence

- **WHEN** the findings contain a triple backtick and exceed 8,000 characters
- **THEN** the backticks are escaped and the fenced text ends with the truncation marker

### Requirement: A role turn can take the fixer stance

`role-turn` SHALL accept an optional `stance` whose only value is `fixer`, and SHALL reject it for a role without write access: at publication with `invalid_role_access`, at execution with `invalid_arguments`. Without `stance` the turn SHALL be unchanged.

#### Scenario: Read role rejected

- **WHEN** a definition gives `stance: fixer` to a configured read role
- **THEN** validation fails with `invalid_role_access` at `/params/stance`, and executing such a turn throws before any provider call

### Requirement: The developer corrects as the fixer

A fixer-stance turn of the built-in `developer` SHALL use the FIXER instructions with the host-editable fixer definition and the configured fixer engine, if any, in a fresh session. Any other write role SHALL keep its instructions and engine and only carry the `fixer` label on its request and events.

#### Scenario: Configured fixer engine

- **WHEN** the runtime config defines a fixer engine and a fixer definition
- **THEN** the correction round runs on that engine with that definition and resumes no developer session

### Requirement: The reference definition repairs a rejected change

The `flow-spec` reference definition SHALL route a rejected review or a failing `check` to at most two correction rounds of a fixer `developer` turn followed by re-derivation, `check` and review. A round SHALL continue only when the fixer changed the candidate. A fixer turn that changes nothing, or an exhausted budget, SHALL end the run at the failure end node `changes-requested`, whose reason names the number of correction rounds and the latest findings.

#### Scenario: One round resolves the review

- **WHEN** the reviewer rejects once and the fixer adds the requested test
- **THEN** the change is re-derived, checked, approved and archived, and the run succeeds with valid receipts

#### Scenario: The reviewer keeps rejecting

- **WHEN** every review rejects the change
- **THEN** the roles run deriver, reviewer, developer, deriver, reviewer, developer, deriver, reviewer and the run fails with the changes-requested reason and the latest findings

#### Scenario: The fixer changes nothing

- **WHEN** the fixer turn leaves the candidate unchanged
- **THEN** the run ends at `changes-requested` after that single fixer turn

#### Scenario: A failing check reaches the fixer

- **WHEN** the host verification of the derived change fails
- **THEN** the fixer receives the host verification findings, and the corrected code is re-derived, checked, reviewed and archived
