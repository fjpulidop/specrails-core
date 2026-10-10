## ADDED Requirements

### Requirement: Verification records the candidate files its commands modified

When a verification run ends with a candidate fingerprint different from the one it started with, the receipt SHALL include `selfMutation: { files: Array<{ repositoryId, path, change: 'added' | 'modified' | 'removed' }>, commands: Array<{ repositoryId, label }> }`. The receipt computes the files by diffing the candidate manifest captured before the first command with the one captured after the last command. It uses the same inclusion rules as `candidateManifest`. `commands` lists the commands that executed in the run, and does not list reused ones. The receipt `reason` SHALL name the count and the first paths, for example `Verification commands modified 1 candidate file: apps/web/eslint-config/mappings.js`. The text `Candidate changed during verification` SHALL NOT be the only explanation.

#### Scenario: Lint pre-step regenerates a tracked file

- **WHEN** a verification command exits 0 and rewrites tracked file `eslint-config/styled-component-mappings.js`
- **THEN** the receipt is invalid, `selfMutation.files` contains `{ path: 'eslint-config/styled-component-mappings.js', change: 'modified' }`, and `reason` names that path

#### Scenario: Ignored output is not reported

- **WHEN** a verification command writes only to `coverage/` or to a git-ignored path
- **THEN** the candidate fingerprint is unchanged, the receipt has no `selfMutation`, and it is valid when every command exits 0

#### Scenario: Excluded overlay paths are not reported

- **WHEN** a verification command touches a path the candidate scope excludes
- **THEN** that path does not appear in `selfMutation.files`

### Requirement: Deterministic verification output is adopted into the candidate

When the `verification-output-adoption` guardrail is enabled and a receipt is invalid only because of `selfMutation`, the verify piece SHALL leave the modified files in the worktree as part of the candidate. Only `selfMutation` makes the receipt invalid: every command exited 0 and the run was not aborted or timed out. The piece SHALL then run the same verification request exactly once more. If the second receipt is valid, the verify output SHALL report `adoptedOutputs` with the files from the first receipt, and the outcome SHALL be `pass`. The re-run SHALL NOT count toward the no-progress counter.

#### Scenario: Idempotent generator converges

- **WHEN** the first verification modifies one generated file, and the second run on the mutated candidate changes nothing and exits 0
- **THEN** the verify outcome is `pass`, `output.adoptedOutputs` lists that file, and the verified receipt is the second one

#### Scenario: A failing command is not masked

- **WHEN** a verification command exits non-zero and verification also modified a candidate file
- **THEN** the piece does not re-run for adoption, the failure summary leads with the failing command, `selfMutation` stays on the receipt, and the modified file stays in the worktree

#### Scenario: Adoption disabled

- **WHEN** the `verification-output-adoption` guardrail is `false` and verification modifies a candidate file while every command exits 0
- **THEN** the piece does not re-run and returns the `verification_nondeterministic_output` blocker naming the file

### Requirement: Non-converging verification output is a typed host blocker

If the adoption re-run produces another `selfMutation`, the verify piece SHALL return a blocker with code `verification_nondeterministic_output`. It returns the same blocker when adoption is disabled. The blocker's `reason` SHALL list the files, and its `requiredAction` SHALL tell the operator to commit the generated output on the base branch or to make the generator idempotent. With `hostBlockers` enabled the outcome SHALL be `blocked`. Otherwise the outcome SHALL be `failed` with error code `verification_nondeterministic_output`. The fixer SHALL NOT be scheduled for this cause in either case.

#### Scenario: Generator embeds a timestamp

- **WHEN** both the first run and the adoption re-run modify `generated/build-info.ts`
- **THEN** the piece returns the `verification_nondeterministic_output` blocker naming `generated/build-info.ts`, and no fixer turn runs

### Requirement: Failure descriptions name self-mutation

`describeFailure` SHALL summarize a receipt that has `selfMutation` and no failing command as `verification commands modified N candidate file(s): <first paths>`. Its signature SHALL be derived from the sorted modified paths, so that a repeated self-mutation of the same files is detected as non-convergence.

#### Scenario: Summary for an invalidated green receipt

- **WHEN** a receipt has every command at exit 0 and `selfMutation.files` with one path
- **THEN** the summary starts with `verification commands modified 1 candidate file` and contains the path

### Requirement: Reviewer and fixer respect adopted verification output

When the verify output carries `adoptedOutputs`, the reviewer and fixer instructions SHALL list those paths as host-adopted verification output. The blast-radius rule that treats regenerated generated files as an issue to revert SHALL exempt them. The reviewer MAY still raise an issue about the content of an adopted file, but SHALL NOT ask for it to be reverted to the base version. The fixer SHALL NOT revert an adopted file.

#### Scenario: Reviewer sees the exemption

- **WHEN** the reviewer turn renders after a verification that adopted `eslint-config/styled-component-mappings.js`
- **THEN** its instructions list that path under host-adopted verification output, with the rule not to request its revert

#### Scenario: No adopted output

- **WHEN** the verify output has no `adoptedOutputs`
- **THEN** the reviewer and fixer instructions are unchanged from today

### Requirement: The adoption guardrail is cataloged

`verification-output-adoption` SHALL be a host-phase guardrail in `GUARDRAIL_IDS` and `GUARDRAIL_CATALOG`, enabled unless the settings set it to `false`.

#### Scenario: Default on

- **WHEN** the guardrail settings omit `verification-output-adoption`
- **THEN** `guardrailEnabled(settings, 'verification-output-adoption')` returns true
