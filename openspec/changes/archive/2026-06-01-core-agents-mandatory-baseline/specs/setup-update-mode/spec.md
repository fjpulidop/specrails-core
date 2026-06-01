## MODIFIED Requirements

### Requirement: Selective agent regeneration
In `--update` mode, `/setup` SHALL regenerate only the agents whose source templates have changed according to the manifest. Previously-installed optional agents SHALL be preserved and re-placed using the `agents.selected` list stored in `install-config.yaml`.

#### Scenario: Only changed agents regenerated
- **WHEN** `sr-architect.md` and `sr-developer.md` templates changed but `sr-reviewer.md` did not
- **THEN** only `.claude/agents/sr-architect.md` and `.claude/agents/sr-developer.md` are regenerated; `sr-reviewer.md` is preserved

#### Scenario: Previously installed optional agent preserved on update
- **WHEN** a user originally installed `sr-test-writer` as an opt-in agent
- **AND** `npx specrails-core update` is run
- **THEN** `sr-test-writer.md` is re-placed in `.claude/agents/` using the stored `agents.selected` from `install-config.yaml`

#### Scenario: Optional agent not in install-config not re-added
- **WHEN** a user did not select `sr-doc-sync` during init
- **AND** `npx specrails-core update` is run
- **THEN** `sr-doc-sync.md` is NOT placed in `.claude/agents/`

## ADDED Requirements

### Requirement: install-config stores full agent selection
The `install-config.yaml` file written by the TUI installer SHALL store the complete list of agents selected by the user — including any optional agents chosen during setup — in `agents.selected`.

#### Scenario: Core agents always in selection
- **WHEN** the TUI writes `install-config.yaml`
- **THEN** `agents.selected` always includes `sr-architect`, `sr-developer`, and `sr-reviewer`

#### Scenario: Optional agents written to selection when chosen
- **WHEN** the user selects `sr-test-writer` during the TUI agent picker
- **THEN** `agents.selected` in `install-config.yaml` includes `sr-test-writer`

#### Scenario: Default selection contains only core agents
- **WHEN** the TUI agent picker is presented
- **THEN** only `sr-architect`, `sr-developer`, and `sr-reviewer` are pre-checked by default; all other agents are unchecked
