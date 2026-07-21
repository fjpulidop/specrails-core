# Delta Spec: setup-update-mode

## ADDED Requirements

### Requirement: v5 migration cleanup on update
`update` SHALL, before placing v5 artefacts, remove installer-owned obsolete artefacts from pre-v5 installations: (1) every file recorded in `.specrails/specrails-manifest.json` that the v5 template set no longer produces (removed agents, removed commands, enrich/merge-resolve skill directories), and (2) the now-obsolete staging subtrees under `.specrails/setup-templates/` (`personas/`, any enrich staging). `.specrails/setup-templates/` itself is KEPT and refreshed as the v5 checksum baseline. Files not tracked in the manifest, `.specrails/profiles/**`, and `.claude/agents/custom-*.md` SHALL never be touched.

#### Scenario: Update of a v4 full-tier install
- **WHEN** `npx specrails-core update` runs in a repo whose manifest tracks `sr-security-reviewer.md`, `enrich.md`, and whose `.specrails/setup-templates/personas/` exists
- **THEN** those manifest-tracked files and the obsolete staging subtrees are deleted, `setup-templates/` is refreshed with the v5 template set, v5 artefacts are placed, and the manifest is rewritten to reflect only v5 files

#### Scenario: Reserved and untracked files preserved
- **WHEN** the v5 cleanup runs in a repo containing `.claude/agents/custom-auditor.md`, `.specrails/profiles/project-default.json`, and a user file not present in the manifest
- **THEN** none of those files are modified or deleted

#### Scenario: Migration summary printed
- **WHEN** the v5 cleanup removes at least one file
- **THEN** update prints a one-time migration summary listing every removed path and a pointer: `Removed v4 artefacts — agents beyond the core trio now come from profiles (custom-*.md).`

## MODIFIED Requirements

### Requirement: Selective agent regeneration
In update mode, the installer SHALL regenerate only the agents whose source templates have changed according to the manifest, drawn exclusively from the three core agents. There is no optional-agent re-placement: `agents.selected` entries other than the core trio are ignored (with the v5 migration warning) since no other first-party templates exist.

#### Scenario: Only changed agents regenerated
- **WHEN** `sr-architect.md` and `sr-developer.md` templates changed but `sr-reviewer.md` did not
- **THEN** only `.claude/agents/sr-architect.md` and `.claude/agents/sr-developer.md` are regenerated; `sr-reviewer.md` is preserved

#### Scenario: Stale optional selection ignored
- **WHEN** a pre-v5 `install-config.yaml` lists `sr-test-writer` in `agents.selected`
- **AND** `npx specrails-core update` is run
- **THEN** `sr-test-writer.md` is NOT placed; if it was manifest-tracked it is removed by the v5 cleanup

### Requirement: install-config stores full agent selection
The `install-config.yaml` file written by the TUI installer SHALL store the agent selection in `agents.selected`, which in v5 always equals the three core agents. Unknown agent ids present in pre-v5 files SHALL be tolerated on read and ignored.

#### Scenario: Core agents always in selection
- **WHEN** the TUI writes `install-config.yaml`
- **THEN** `agents.selected` contains exactly `sr-architect`, `sr-developer`, `sr-reviewer`

#### Scenario: Pre-v5 selection tolerated
- **WHEN** `init --from-config` reads a config whose `agents.selected` includes `sr-frontend-developer`
- **THEN** the config loads, the unknown agent is skipped with a warning naming it, and the core agents install normally

### Requirement: Command template checksum detection
In update mode, the installer SHALL refresh `.specrails/setup-templates/` from the installed npm package, check command templates against their manifest checksums, and identify changed, new, and obsolete command templates.

#### Scenario: Changed command template detected
- **WHEN** the packaged `implement.md` checksum differs from the manifest entry
- **THEN** `implement.md` is marked as changed and regenerated in `.claude/commands/specrails/`

#### Scenario: Obsolete command removed
- **WHEN** the manifest tracks `.claude/commands/specrails/vpc-drift.md` but no such template ships in v5
- **THEN** the file is deleted as part of the v5 cleanup and dropped from the manifest

## REMOVED Requirements

### Requirement: New agent evaluation
**Reason**: There are no optional first-party agent templates left to evaluate or offer; extension is via user-owned profiles/custom agents which the installer must never manage.
**Migration**: None — the interactive "new agent available, add it?" flow has no v5 equivalent by design.

### Requirement: Workflow command update
**Reason**: Workflow commands no longer gain references to newly added agents, because no first-party agents can be added; profile routing is read at runtime by the implement pipeline, not baked into command files at update time.
**Migration**: Declare custom agents and their routing in the profile JSON; commands pick them up at runtime.

### Requirement: Quick codebase re-analysis
**Reason**: This requirement described enrich's `--update` Phase U flow (silent codebase analysis, skipped persona phases). Enrich is removed; the TypeScript `update` command performs template placement with placeholder substitution and needs no analysis phase model.
**Migration**: `npx specrails-core update` is the single update surface.
