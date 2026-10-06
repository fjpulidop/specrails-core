## ADDED Requirements

### Requirement: The agents section of the install configuration is optional
`init --from-config` SHALL accept an install configuration without an `agents` section. When the section is present, `agents.selected` and `agents.excluded` SHALL be validated as lists of safe ids with no overlap and `agents.preset` as a known preset, and the selection SHALL have no effect on the installed artifacts.

#### Scenario: Configuration without agents
- **WHEN** an install configuration with `version`, `provider` and no `agents` key is applied
- **THEN** the installation succeeds and no error mentions `agents`

#### Scenario: Legacy configuration with a selection
- **WHEN** an install configuration lists `agents.selected: [sr-architect]`
- **THEN** the installation succeeds, logs one deprecation warning that agent selection is ignored, and places no role file

#### Scenario: Malformed agents section
- **WHEN** `agents.selected` is not a list or overlaps `agents.excluded`
- **THEN** the configuration is rejected with the existing validation error

### Requirement: The assemble selection flag is accepted and ignored
`assemble --selected-agents <ids>` SHALL be accepted for compatibility, SHALL log a deprecation warning and SHALL NOT change the assembled workspace.

#### Scenario: Flag supplied
- **WHEN** `assemble --selected-agents sr-architect` runs
- **THEN** the workspace matches an assemble without the flag and the log contains the deprecation warning
