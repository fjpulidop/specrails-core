## ADDED Requirements

### Requirement: Engine v2 verification classifies environment failures before any correction round

The `verify` piece SHALL inspect an invalid verification receipt for host preconditions and environment failures before returning `fail`. A host precondition is a failure only the host can repair (registry credentials or reachability, a missing environment variable a configuration references, git credentials for a dependency, a Playwright browser download that cannot reach its CDN, a failed setup command). An environment failure is a missing tool, module, dependency or Playwright browser build.

#### Scenario: Missing Playwright browser is repaired by the host

- **WHEN** a verification command fails with `browserType.launch: Executable doesn't exist at …/ms-playwright/chromium_headless_shell-1243/…` in a repository whose manifest declares `@playwright/test`
- **AND** the `environment-repair` guardrail is enabled
- **THEN** the piece runs the planned installs for that root, including `npx playwright install chromium` (or the pnpm/yarn equivalent), reports each install through the `verification-output` progress channel prefixed `[environment]`, re-runs the same verification plan once
- **AND** the second receipt decides the outcome and the no-progress fingerprint
- **AND** the output carries `environmentRepair: { attempted: true, installs: [...], reverified: true }`

#### Scenario: Browser download fails offline

- **WHEN** the planned Playwright install exits non-zero with `Failed to download Chrome for Testing …` or a CDN `ENOTFOUND`/`ETIMEDOUT` error
- **THEN** the piece does not start a correction round
- **AND** the output carries `blocker` with `kind: 'network'`, the install command, its cwd relative to the checkout and a `requiredAction` naming the command to run with network access before retrying

#### Scenario: Host precondition on the first run

- **WHEN** a verification command fails with a registry 401/403, `Environment variable not found (NAME)`, a git credential prompt or an unreachable registry
- **THEN** the piece returns the structured `blocker` with the matching `kind` (`credential`, `environment-variable`, `network`) without running installs

#### Scenario: Ordinary test failure is untouched

- **WHEN** a verification command fails with an assertion error and no environment signature
- **THEN** no install runs, no `blocker` is produced and the outcome is `fail` exactly as before this change

#### Scenario: Guardrail switched off

- **WHEN** `guardrails['environment-repair'] === false` and an environment failure occurs
- **THEN** no install runs and the outcome is `fail`; host precondition classification still applies

### Requirement: Host blockers route through an opt-in `blocked` outcome

The `verify` piece SHALL declare the outcome `blocked` only when `params.hostBlockers === true`. Existing definitions without the flag keep the outcomes `pass`, `fail`, `failed`.

#### Scenario: Definition opts in

- **WHEN** a `verify` node sets `hostBlockers: true` and maps `blocked` in its `ends`
- **THEN** a host blocker produces outcome `blocked`, `status: 'blocked'` and `error.code = 'verification_host_precondition'`
- **AND** `output.blocker` carries the structured blocker

#### Scenario: Definition does not opt in

- **WHEN** a `verify` node omits `hostBlockers`
- **THEN** a host blocker produces outcome `fail` with the same `output.blocker`, and the definition validator accepts `ends` with the three legacy outcomes

#### Scenario: Validator rejects an unmapped opt-in outcome

- **WHEN** a `verify` node sets `hostBlockers: true` without mapping `blocked`
- **THEN** definition validation fails with `invalid_outcomes`

### Requirement: Completion exposes the blocker

An `end` piece SHALL accept `blockerFrom: <nodeId>` and copy that node's `output.blocker`, when present, into `completion.blocker`.

#### Scenario: End node copies the blocker

- **WHEN** the run reaches an `end` node with `blockerFrom: 'verify'` after a blocked verification
- **THEN** the durable completion carries `blocker` with the same `kind`, `command`, `cwd` and `requiredAction` as the verify output

### Requirement: Legacy graph keeps its behavior through shared helpers

The legacy `verifyNode` SHALL use the shared repair helpers and keep returning `status: 'blocked'` with the existing host-facing message.

#### Scenario: Existing legacy tests

- **WHEN** the legacy graph test suite runs after the extraction
- **THEN** every existing precondition, environment-repair and lockfile-repair assertion passes unchanged
