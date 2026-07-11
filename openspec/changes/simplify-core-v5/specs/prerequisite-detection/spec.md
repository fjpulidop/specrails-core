# Delta Spec: prerequisite-detection

## ADDED Requirements

### Requirement: No enrich-oriented prerequisites
The prerequisite gate SHALL check only what the mode-less install path needs (provider CLI, git, npm/Node). Checks and messaging that existed solely for the enrich flow (e.g. the JIRA CLI probe, persona-generation hints) SHALL be removed.

#### Scenario: JIRA CLI absent
- **WHEN** `init` runs on a machine without a JIRA CLI
- **THEN** no JIRA-related check runs, no JIRA warning is printed, and installation proceeds

#### Scenario: Prereq messaging is enrich-free
- **WHEN** the prereqs implementation is searched for `enrich`, `persona`, or `jira`
- **THEN** zero matches are found
