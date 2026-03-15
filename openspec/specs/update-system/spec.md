## ADDED Requirements

### Requirement: Update script exists
specrails SHALL provide an `update.sh` script at the repository root that updates an existing specrails installation in a target repository.

#### Scenario: Script is executable
- **WHEN** a user clones specrails
- **THEN** `update.sh` exists at the root and is executable

### Requirement: Version comparison on start
`update.sh` SHALL compare the installed version (`.specrails-version`) against the available version (`VERSION` file) and exit early if already up to date.

#### Scenario: Already up to date
- **WHEN** `.specrails-version` matches `VERSION`
- **THEN** `update.sh` prints "Already up to date (vX.Y.Z)" and exits with code 0

#### Scenario: Update available
- **WHEN** `.specrails-version` is older than `VERSION`
- **THEN** `update.sh` displays "Installed: vX.Y.Z → Available: vA.B.C" and proceeds

### Requirement: Legacy migration
`update.sh` SHALL handle installations that predate the versioning system (no `.specrails-version` file).

#### Scenario: Legacy installation detected
- **WHEN** `.specrails-version` does not exist AND `.claude/agents/` exists with content
- **THEN** `update.sh` generates `.specrails-version` as `0.1.0` and `.specrails-manifest.json` by checksumming current specrails templates, then proceeds with normal update

#### Scenario: No installation detected
- **WHEN** `.specrails-version` does not exist AND `.claude/agents/` does not exist or is empty
- **THEN** `update.sh` prints "No specrails installation found. Run install.sh first." and exits with code 1

### Requirement: Backup before update
`update.sh` SHALL create a backup of `.claude/` before making any changes.

#### Scenario: Backup creation
- **WHEN** update begins
- **THEN** `.claude/` is copied to `.claude.specrails.backup/` excluding `node_modules/` directories

#### Scenario: Backup cleanup on success
- **WHEN** update completes successfully
- **THEN** `.claude.specrails.backup/` is deleted

#### Scenario: Backup preserved on failure
- **WHEN** update fails at any point
- **THEN** `.claude.specrails.backup/` is preserved and the user is informed of its location

### Requirement: Core artifact overwrite
`update.sh` SHALL silently overwrite non-adapted artifacts: `setup-templates/`, `commands/`, `skills/`.

#### Scenario: Commands updated
- **WHEN** update runs
- **THEN** all files in `.claude/commands/` and `.claude/skills/` are replaced with the latest versions from specrails templates

### Requirement: Web manager install or update
`update.sh` SHALL update the web manager only if it is already installed. It SHALL NOT auto-install web-manager if the directory does not exist.

#### Scenario: Web manager not installed
- **WHEN** `specrails/web-manager/` does not exist
- **THEN** `update.sh` skips web-manager entirely with message "Web manager not installed — skipping (install with install.sh)"

#### Scenario: Web manager already installed
- **WHEN** `specrails/web-manager/` exists
- **THEN** web manager files are overwritten (excluding `node_modules/`) and npm install is re-run if package.json changed

#### Scenario: --only web-manager when not installed
- **WHEN** user runs `update.sh --only web-manager` and `specrails/web-manager/` does not exist
- **THEN** `update.sh` prints "Web manager not installed — skipping" and exits with code 0

### Requirement: Adapted artifact detection
`update.sh` SHALL compare template checksums from `.specrails-manifest.json` against current specrails templates to detect which adapted artifacts (agents, rules) need regeneration.

#### Scenario: Template unchanged
- **WHEN** a template's checksum matches the manifest
- **THEN** the corresponding adapted artifact is not flagged for regeneration

#### Scenario: Template changed
- **WHEN** a template's checksum differs from the manifest
- **THEN** the user is shown which templates changed and asked whether to regenerate

#### Scenario: User skips regeneration
- **WHEN** the user declines agent regeneration
- **THEN** `update.sh` prints a warning that the workflow may break with outdated agents, and continues

#### Scenario: New template available
- **WHEN** a template exists in specrails that has no entry in the manifest
- **THEN** the user is informed that new agent templates are available and will be evaluated during `/setup --update`

### Requirement: Settings merge
`update.sh` SHALL merge `settings.json` and `security-exemptions.yaml` additively — adding new keys/rules without removing or modifying existing user values.

#### Scenario: New setting added
- **WHEN** specrails template has a key not present in the user's settings.json
- **THEN** the key is added with the template's default value

#### Scenario: Existing setting preserved
- **WHEN** the user's settings.json has a key that also exists in the template
- **THEN** the user's value is preserved

### Requirement: Version stamp after update
`update.sh` SHALL update `.specrails-version` and regenerate `.specrails-manifest.json` after a successful update.

#### Scenario: Stamp updated
- **WHEN** update completes successfully
- **THEN** `.specrails-version` contains the new version and `.specrails-manifest.json` reflects the new checksums

### Requirement: Selective update with --only
`update.sh` SHALL support a `--only <component>` flag to update specific components.

#### Scenario: --only web-manager
- **WHEN** user runs `update.sh --only web-manager`
- **THEN** only the web manager is updated, all other artifacts are untouched

#### Scenario: --only commands
- **WHEN** user runs `update.sh --only commands`
- **THEN** only commands/ and skills/ are updated

#### Scenario: --only agents
- **WHEN** user runs `update.sh --only agents`
- **THEN** agent regeneration is triggered regardless of template changes

#### Scenario: --only core
- **WHEN** user runs `update.sh --only core`
- **THEN** commands, skills, and setup-templates are updated (no agents)

#### Scenario: No --only flag
- **WHEN** user runs `update.sh` without `--only`
- **THEN** all components are updated (equivalent to `--only all`)

### Requirement: --root-dir support
`update.sh` SHALL support the same `--root-dir <path>` argument as `install.sh` for monorepo installations.

#### Scenario: Monorepo update
- **WHEN** user runs `update.sh --root-dir ./packages/my-app`
- **THEN** the update targets the specified directory instead of the git root
