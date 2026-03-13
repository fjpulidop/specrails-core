## ADDED Requirements

### Requirement: VERSION file in specrails root
The specrails repository SHALL contain a `VERSION` file at the root containing the current version string in semver format (e.g., `0.1.0`). This file is the single source of truth for the specrails version.

#### Scenario: VERSION file exists and is valid
- **WHEN** a user clones or downloads specrails
- **THEN** a `VERSION` file exists at the repository root containing a valid semver string with no trailing whitespace or newline

### Requirement: Version stamp on install
`install.sh` SHALL write a `.specrails-version` file in the target repository root containing the version string from the specrails `VERSION` file.

#### Scenario: Fresh install creates version stamp
- **WHEN** a user runs `install.sh` on a repo without specrails
- **THEN** `.specrails-version` is created containing the current specrails version

#### Scenario: Re-install overwrites version stamp
- **WHEN** a user runs `install.sh` on a repo that already has `.specrails-version`
- **THEN** `.specrails-version` is overwritten with the current specrails version

### Requirement: Manifest generation on install
`install.sh` SHALL generate a `.specrails-manifest.json` file in the target repository root containing SHA-256 checksums of all template files that were installed.

#### Scenario: Manifest structure
- **WHEN** `install.sh` completes successfully
- **THEN** `.specrails-manifest.json` contains a JSON object with:
  - `version`: the installed version string
  - `installed_at`: ISO-8601 timestamp
  - `artifacts`: object mapping relative template paths to their SHA-256 checksums

#### Scenario: Manifest covers all templates
- **WHEN** `install.sh` installs templates from `templates/agents/`, `templates/commands/`, `templates/rules/`, `templates/personas/`, `templates/settings/`, `templates/claude-md/`, and `templates/web-manager/`
- **THEN** every installed template file has a corresponding entry in `artifacts`

### Requirement: Semver versioning scheme
specrails SHALL follow semantic versioning: major for breaking changes (incompatible agent templates), minor for new features (new agents, web manager), patch for fixes.

#### Scenario: Version bump for new feature
- **WHEN** a new feature is added (e.g., update system)
- **THEN** the minor version is incremented (e.g., `0.1.0` → `0.2.0`)
