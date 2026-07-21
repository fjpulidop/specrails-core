# Delta Spec: modeless-install

## ADDED Requirements

### Requirement: Single direct-placement installation path
`init` SHALL install all artefacts by direct template placement in a single pass, with no install tiers and no mode selection. The concepts `full`, `quick`, and `Tier` SHALL NOT exist anywhere in the installer code, CLI flags, TUI, or generated configuration. Placement runs unconditionally — there is no "stage then run a follow-up wizard" branch. (`.specrails/setup-templates/` remains as internal, gitignored staging that placement copies from and `update` diffs against; it is an implementation detail, not a user-facing mode.)

#### Scenario: Fresh init on a claude project
- **WHEN** `npx specrails-core init` runs on a repository with Claude Code detected
- **THEN** `.claude/agents/` contains exactly `sr-architect.md`, `sr-developer.md`, `sr-reviewer.md`; `.claude/commands/specrails/` contains the v5 command set; `.claude/rules/` contains the layer rules; the opsx skills are placed; and no follow-up wizard step is required

#### Scenario: No follow-up step required
- **WHEN** `init` completes successfully
- **THEN** the summary output contains no instruction to run `/specrails:enrich` or any other completion wizard — the installation is immediately usable

#### Scenario: --quick flag rejected
- **WHEN** `init --quick` is invoked
- **THEN** the CLI exits non-zero with an error naming the removal (e.g. `--quick was removed in v5 — init now installs everything directly`)

### Requirement: enrich subcommand removed
The CLI dispatcher SHALL NOT accept an `enrich` subcommand.

#### Scenario: enrich invocation rejected
- **WHEN** `npx specrails-core enrich` is invoked
- **THEN** the CLI exits non-zero printing `enrich was removed in v5 — init now installs everything directly` and the help text does not list `enrich`

### Requirement: install-config without tier
The `install-config.yaml` contract SHALL NOT include a `tier` field. The parser SHALL ignore an existing `tier` key on read (backward tolerance for pre-v5 files) and the TUI SHALL NOT write one.

#### Scenario: Pre-v5 config file still loads
- **WHEN** `init --from-config` reads an `install-config.yaml` containing `tier: full`
- **THEN** the config loads without error, the `tier` key is ignored, and installation proceeds via the single direct-placement path

#### Scenario: TUI writes tier-free config
- **WHEN** the TUI installer writes `install-config.yaml`
- **THEN** the file contains `provider` and `agents` sections and no `tier` key, and the TUI flow presents no tier selection step

### Requirement: Per-provider placement preserved
Direct placement SHALL support all three providers (claude, codex, gemini) with their existing render transformations (gemini frontmatter + `activate_skill` translation, codex config/skills, claude markdown).

#### Scenario: Gemini placement
- **WHEN** `init` runs against a gemini project
- **THEN** `.gemini/agents/` contains the three core agents with gemini frontmatter (model, tools including `activate_skill`) and `Skill("opsx:*")` calls translated to `activate_skill(name="openspec-*")`

#### Scenario: Codex placement
- **WHEN** `init` runs against a codex project
- **THEN** `.codex/` receives config.toml and the codex skill set for the v5 surface (implement, retry, rails — no enrich, no merge-resolve)

### Requirement: Only v5 template set shipped
The npm package SHALL ship templates for exactly the three core agents and the v5 command set. Templates for removed agents (`sr-product-manager`, `sr-product-analyst`, `sr-test-writer`, `sr-doc-sync`, `sr-merge-resolver`, `sr-frontend-developer`, `sr-backend-developer`, `sr-frontend-reviewer`, `sr-backend-reviewer`, `sr-security-reviewer`, `sr-performance-reviewer`), removed commands (`enrich`, `reconfig`, `vpc-drift`, `auto-propose-backlog-specs`, `get-backlog-specs`, `merge-resolve`), and `templates/personas/` SHALL NOT exist in the package.

#### Scenario: Template inventory audit
- **WHEN** the template directories are enumerated in CI
- **THEN** `templates/agents/` contains exactly 3 files and no removed command/persona template is present anywhere under `templates/`
