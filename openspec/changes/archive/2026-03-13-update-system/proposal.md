## Why

Projects that installed specrails have no way to receive new features (e.g., web manager), updated templates, or bug fixes without reinstalling from scratch — which destroys their adapted agents and personas. As specrails evolves, existing users need a safe, incremental update path that preserves their project-specific customizations.

## What Changes

- Introduce a `VERSION` file in specrails root (`0.1.0` for current state)
- `install.sh` now generates `.specrails-version` and `.specrails-manifest.json` in target repos (checksums of all installed template files)
- New `update.sh` script that:
  - Compares installed version vs available version
  - Backs up `.claude/` to `.claude.specrails.backup/` before changes
  - Overwrites core artifacts (commands, skills, setup-templates, web-manager)
  - Detects changed agent/rule templates via manifest checksums and prompts user to regenerate
  - Detects new agent templates and offers to evaluate them for the project
  - Merges settings and security-exemptions (add new keys, preserve existing)
  - Auto-migrates legacy installations (no manifest) to v0.1.0 baseline
  - Supports `--only <component>` for selective updates
  - Cleans up backup on success, preserves on failure
- `/setup --update` mode: re-analyzes codebase and regenerates only the agents/rules whose templates changed, plus evaluates new agent templates for relevance

## Capabilities

### New Capabilities
- `versioning`: Version tracking for specrails installations (VERSION file, .specrails-version, .specrails-manifest.json with checksums)
- `update-system`: Incremental update mechanism (update.sh script, legacy migration, backup/restore, selective updates via --only)
- `setup-update-mode`: Surgical agent regeneration mode for /setup (--update flag, template diff detection, new agent evaluation)

### Modified Capabilities
- `implement`: Update /implement and other commands to reference any new agents added during update

## Impact

- **New files in specrails**: `VERSION`, `update.sh`
- **Modified**: `install.sh` (add manifest generation), `commands/setup.md` (add --update mode)
- **New files in target repos**: `.specrails-version`, `.specrails-manifest.json`
- **Temporary files in target repos**: `.claude.specrails.backup/` (during update only)
