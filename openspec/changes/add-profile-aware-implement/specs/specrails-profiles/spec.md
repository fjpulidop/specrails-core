## ADDED Requirements

### Requirement: Profile schema v1
The system SHALL define a JSON schema for agent profiles with `schemaVersion: 1`. A v1 profile SHALL contain `name` (string), `orchestrator.model` (string), `agents` (array of `{id, model, required}`), and `routing` (ordered array of `{tags, agent}` objects with exactly one terminal `{default: true, agent}` entry).

#### Scenario: Valid v1 profile loads
- **WHEN** a profile JSON with `schemaVersion: 1` and all required fields is read by `implement.md`
- **THEN** the pipeline proceeds using the profile's agents, models, and routing rules

#### Scenario: Unknown schemaVersion rejected
- **WHEN** a profile JSON with `schemaVersion: 999` is read by `implement.md`
- **THEN** the pipeline halts with an error message naming the supported schema versions

#### Scenario: Missing required field rejected
- **WHEN** a profile JSON is missing `agents` or `routing`
- **THEN** the pipeline halts with a validation error naming the missing field

### Requirement: Profile resolution order
The system SHALL resolve the active profile in this precedence: (1) `$SPECRAILS_PROFILE_PATH` environment variable, (2) `<cwd>/.specrails/profiles/project-default.json` file, (3) legacy fallback (no profile active).

#### Scenario: Env var takes precedence over file
- **WHEN** both `$SPECRAILS_PROFILE_PATH` is set AND `.specrails/profiles/project-default.json` exists
- **THEN** the pipeline uses the profile referenced by the env var and ignores the file

#### Scenario: File used when env var unset
- **WHEN** `$SPECRAILS_PROFILE_PATH` is unset AND `.specrails/profiles/project-default.json` exists
- **THEN** the pipeline uses the file-based profile

#### Scenario: Legacy fallback when neither present
- **WHEN** `$SPECRAILS_PROFILE_PATH` is unset AND no `.specrails/profiles/project-default.json` exists
- **THEN** the pipeline runs in legacy mode with no behavior change from pre-profile versions

### Requirement: Required baseline agents
The profile schema SHALL enforce that `agents[]` includes the four core agents as baseline members: `sr-architect`, `sr-developer`, `sr-reviewer`, and `sr-merge-resolver`. A profile missing any of these SHALL be rejected at load time. The baseline mirrors `CORE_AGENTS` in the installer — these are the agents the implement pipeline depends on unconditionally.

#### Scenario: Profile without sr-reviewer rejected
- **WHEN** a v1 profile JSON omits `sr-reviewer` from `agents[]`
- **THEN** the pipeline halts with a validation error identifying the missing baseline agent

#### Scenario: Profile without sr-merge-resolver rejected
- **WHEN** a v1 profile JSON omits `sr-merge-resolver` from `agents[]`
- **THEN** the pipeline halts with a validation error identifying the missing baseline agent

### Requirement: Routing rule ordering
Routing rules in a profile SHALL be evaluated in array order. The first rule whose `tags` array intersects the task's tag set wins. Exactly one terminal entry with `default: true` SHALL appear as the last element and SHALL be taken when no earlier rule matches.

#### Scenario: First matching rule wins
- **WHEN** a task has tags `["etl","frontend"]` AND routing has `[{tags:["etl"], agent:"sr-data-engineer"}, {tags:["frontend"], agent:"sr-frontend-developer"}, {default:true, agent:"sr-developer"}]`
- **THEN** the task is routed to `sr-data-engineer`

#### Scenario: Default rule matches when nothing else does
- **WHEN** a task has tags `["misc"]` AND no non-default routing rule intersects
- **THEN** the task is routed to the `default: true` rule's agent

#### Scenario: Missing default rule rejected
- **WHEN** a profile's `routing` array has no entry with `default: true`
- **THEN** the profile is rejected at load time with a validation error

### Requirement: Per-agent model override
When a profile is active, each agent invocation SHALL use the `model` value declared in `profile.agents[id].model`. The agent's `.md` frontmatter `model:` field SHALL NOT be consulted in profile mode.

#### Scenario: Profile model overrides frontmatter
- **WHEN** `.claude/agents/sr-reviewer.md` declares `model: sonnet` AND the active profile declares `{id: "sr-reviewer", model: "opus"}`
- **THEN** `sr-reviewer` is invoked with model `opus`

#### Scenario: Legacy mode uses frontmatter
- **WHEN** no profile is active AND `.claude/agents/sr-reviewer.md` declares `model: sonnet`
- **THEN** `sr-reviewer` is invoked with model `sonnet`

### Requirement: Reserved profiles directory
The `<project>/.specrails/profiles/` directory SHALL be reserved for project-owned and hub-authored profile JSON files. The `update.sh` and `install.sh` scripts SHALL NOT create, modify, or delete any file inside `.specrails/profiles/`. Other paths under `.specrails/` (e.g. `install-config.yaml`, `specrails-version`, `specrails-manifest.json`, `setup-templates/`) remain managed by the installer.

#### Scenario: update.sh preserves .specrails/profiles
- **WHEN** a project containing `.specrails/profiles/project-default.json` and `.specrails/profiles/data-heavy.json` runs `npx specrails-core@latest update`
- **THEN** both JSON files are byte-identical before and after the update

#### Scenario: update.sh still manages other .specrails content
- **WHEN** a project running `update` has `.specrails/specrails-version` pointing at an older version
- **THEN** `update.sh` is free to overwrite `.specrails/specrails-version` with the new version string (non-profile content is not reserved)

### Requirement: Reserved custom agent namespace
Files matching `.claude/agents/custom-*.md` SHALL be reserved for user-authored custom agents. The `update.sh` script SHALL NOT create, modify, or delete any file matching this pattern.

#### Scenario: update.sh preserves custom agents
- **WHEN** a project containing `.claude/agents/custom-pentester.md` runs `npx specrails-core@latest update`
- **THEN** `.claude/agents/custom-pentester.md` is byte-identical before and after the update

### Requirement: Schema publication
specrails-core SHALL publish a JSON schema for profile v1 at `schemas/profile.v1.json` inside the package, referenced from the README. Future breaking schema changes SHALL be published as `schemas/profile.v<N>.json` without modifying prior versions.

#### Scenario: Schema file present in package
- **WHEN** `specrails-core` is installed via npm
- **THEN** the installed package contains `schemas/profile.v1.json` with a valid JSON Schema document
