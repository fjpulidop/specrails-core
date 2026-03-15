## MODIFIED Requirements

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
