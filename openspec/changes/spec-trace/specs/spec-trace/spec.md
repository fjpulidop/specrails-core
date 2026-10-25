## ADDED Requirements

### Requirement: Requirements have stable ids

Core SHALL identify every `### Requirement: <name>` in `openspec/specs/<capability>/spec.md` as `<capability>/<slug>`, where the slug is the name after Unicode NFKD decomposition without combining marks, lowercased, with every run of non-alphanumeric characters replaced by one dash and no leading or trailing dash.

#### Scenario: Accents and symbols

- **WHEN** a requirement is named `Pausa con pregunta: ¿qué ocurre?` in capability `runs`
- **THEN** its id is `runs/pausa-con-pregunta-que-ocurre`

### Requirement: Tests claim requirements with tags

The scanner SHALL accept `[spec:<id>]` anywhere in a test file line and a comment `spec: <id>` introduced by `//`, `#`, `--`, `;`, `%` or a block-comment opener, in any language, and SHALL report a tag that matches no requirement as untagged.

#### Scenario: Renamed requirement

- **WHEN** a change renames a requirement and a test still carries the old id
- **THEN** the old tag is reported as untagged and the new requirement as undemonstrated

### Requirement: Demonstration needs a passing receipt

A requirement SHALL be demonstrated only when a test file tagged with its id was reached by a verification command that exited 0. Without a receipt nothing is executed unless the caller states that the tests passed.

#### Scenario: Missing receipt

- **WHEN** the scan has no receipt and no `--tests-passed`
- **THEN** every requirement is undemonstrated with reason `not-executed` or `no-test`

#### Scenario: Two of three

- **WHEN** a project has three requirements and two tagged tests that a passing command ran
- **THEN** the report reads `Requirements demonstrated 2/3`

### Requirement: The check fails on touched requirements only

`pipeline trace` SHALL exit 0 in normal mode, and with `--check` SHALL exit 1 when a requirement the change adds, modifies or renames is not demonstrated.

#### Scenario: Undemonstrated touched requirement

- **WHEN** a change adds a requirement no test tags
- **THEN** `pipeline trace --check` exits 1 and names the requirement

### Requirement: Runs record an advisory trace

After a passing verification the runtime SHALL write `<backlogRoot>/.specrails/pipeline/<runId>/spec-trace.json` bound to the receipt, SHALL show it to the reviewer, and SHALL NOT change the verification or acceptance outcome because of it.

#### Scenario: Untagged change

- **WHEN** the developer tags no test
- **THEN** the run still verifies, the reviewer is told which touched requirements are not demonstrated, and the acceptance status is unchanged
