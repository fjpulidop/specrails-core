## ADDED Requirements

### Requirement: Gates are discovered deterministically

`specrails-core rules inventory` SHALL list, without any provider call, the gates the repository already has (package scripts, lint and format configurations, strict TypeScript, architecture tests, git hooks, check-like CI steps and OpenSpec validation), each with an id, a kind, a command runnable from the repository root and its source file.

#### Scenario: Script and config

- **WHEN** `package.json` has a `lint` script and the repository also has an ESLint configuration
- **THEN** the inventory lists one lint gate whose command runs the script, with source `package.json`

#### Scenario: Strict TypeScript

- **WHEN** `tsconfig.json` sets `compilerOptions.strict` to true and no typecheck script exists
- **THEN** the inventory lists a typecheck gate `npx tsc --noEmit` with source `tsconfig.json`

### Requirement: Rule statements are parsed with their source

The inventory SHALL parse the rule statements of `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md` (also under `.github/` and `docs/`) outside code fences, tables and Specrails-managed blocks, recording each statement's text and `source` as `<file>:<line>` and an id derived from the file and the statement.

#### Scenario: Wrapped list item

- **WHEN** a list item under a rules heading continues on the next line
- **THEN** the inventory records one rule with the joined text and the line of the item

#### Scenario: Managed block

- **WHEN** a rule appears inside `<!-- specrails-managed:start -->` … `<!-- specrails-managed:end -->`
- **THEN** the inventory does not record it

### Requirement: The model only classifies

The inventory SHALL classify rules in one provider call made with the architect's provider from `.specrails/agent-runtime.json`, read-only and without role instructions, accepting only `enforcedBy` (with the enforcing gate or test), `automatable` (with a proposed check) or `humanOnly` for ids it sent, and SHALL keep every rule's text and source from the parser.

#### Scenario: Unknown id and invalid status

- **WHEN** the reply contains an id that was not sent and a status outside the three values
- **THEN** the unknown id is ignored and the rule with the invalid status stays `unclassified`

#### Scenario: Cached classification

- **WHEN** the inventory runs again and a rule's statement did not change
- **THEN** the rule keeps its classification and is not sent to the provider

### Requirement: Classification never blocks the inventory

Without a runtime configuration, with `--offline`, during `init`, on a failed provider call or on a reply without JSON, the inventory SHALL still write `.specrails/rules.json` with the gates and the rules as `unclassified`, and SHALL record why in `classification.status` and `classification.reason`.

#### Scenario: Init

- **WHEN** `specrails-core init` installs a project
- **THEN** `.specrails/rules.json` exists and no provider was called

### Requirement: The runtime uses the inventory

When `.specrails/rules.json` exists, Core SHALL list its `humanOnly` rules to the reviewer as candidates for `brief.humanChecks`, and, when the host configured no verification command, SHALL offer the discovered gates to the architect as the default verification proposal. Without the file, role prompts SHALL be unchanged.

#### Scenario: Human checks

- **WHEN** the inventory has a `humanOnly` rule
- **THEN** the reviewer prompt contains a "Project rules that need a human" section listing it with its source

#### Scenario: Host verification configured

- **WHEN** the host configured a verification command
- **THEN** the architect prompt has no project gates section

### Requirement: Claude Code receives a managed instruction block

The installer SHALL upsert a Specrails-managed block into the root `CLAUDE.md` of a Claude Code installation, preserving content outside the sentinels and replacing a stale block in place.

#### Scenario: User-authored CLAUDE.md

- **WHEN** `CLAUDE.md` exists with user content
- **THEN** after installation it keeps that content and contains exactly one managed block
