## 1. Versioning Foundation

- [x] 1.1 Create `VERSION` file at specrails root containing `0.1.0`
- [x] 1.2 Modify `install.sh` to generate `.specrails-version` in target repo (read from `VERSION`)
- [x] 1.3 Modify `install.sh` to generate `.specrails-manifest.json` with SHA-256 checksums of all installed template files
- [x] 1.4 Add `.specrails-version` and `.specrails-manifest.json` to the installer summary output

## 2. update.sh — Core Script

- [x] 2.1 Create `update.sh` with argument parsing (`--only <component>`, `--root-dir <path>`)
- [x] 2.2 Implement version comparison (read `.specrails-version` vs `VERSION`, exit if up to date)
- [x] 2.3 Implement legacy migration (no `.specrails-version` → generate manifest as v0.1.0)
- [x] 2.4 Implement backup: copy `.claude/` to `.claude.specrails.backup/` excluding `node_modules/`
- [x] 2.5 Implement cleanup: delete backup on success, preserve on failure (trap handler)

## 3. update.sh — Update Components

- [x] 3.1 Implement core overwrite: replace `setup-templates/`, `commands/`, `skills/` from specrails templates
- [x] 3.2 Implement web manager install/update (install if missing, overwrite files excluding node_modules if present, run npm install)
- [x] 3.3 Implement adapted artifact detection: compare manifest checksums against current templates, list changed/new templates
- [x] 3.4 Implement user prompt for agent regeneration (show changed templates, ask y/N, warn on skip)
- [x] 3.5 Implement settings merge: additive merge for `settings.json` and `security-exemptions.yaml`
- [x] 3.6 Implement `--only` routing: dispatch to appropriate update functions based on component flag
- [x] 3.7 Implement version stamp: update `.specrails-version` and regenerate `.specrails-manifest.json` on success

## 4. update.sh — Output and UX

- [x] 4.1 Add colored header with version transition display (matching install.sh style)
- [x] 4.2 Add phase-by-phase progress output with ✓/⚠/✗ indicators
- [x] 4.3 Add final summary with next steps (point to `/setup --update` if agents need regeneration)

## 5. /setup --update Mode

- [x] 5.1 Modify `commands/setup.md` to accept `--update` argument and branch to update mode
- [x] 5.2 Implement quick codebase re-analysis (Phase 1 only, skip personas/product discovery)
- [x] 5.3 Implement selective agent regeneration: read manifest, regenerate only changed agents using new templates + codebase analysis
- [x] 5.4 Implement new agent evaluation: detect new templates, match against project stack, prompt user
- [x] 5.5 Implement workflow command update: update `/implement` and other commands to reference newly added agents
- [x] 5.6 Add update summary output (agents regenerated, added, skipped, rules updated)

## 6. Verification

- [x] 6.1 Test fresh install flow: verify VERSION, .specrails-version, and .specrails-manifest.json are created correctly
- [x] 6.2 Test update flow: modify a template, run update.sh, verify detection and prompt
- [x] 6.3 Test legacy migration: remove .specrails-version, run update.sh, verify auto-migration
- [x] 6.4 Test --only flag: verify each component updates independently
- [x] 6.5 Test backup/restore: simulate failure, verify backup is preserved
- [x] 6.6 Validate with shellcheck: `shellcheck update.sh` (bash -n syntax check passed; shellcheck not installed)
