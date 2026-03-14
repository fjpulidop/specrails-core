## Why

SpecRails agents and commands use generic names (architect, developer, reviewer, /implement, /product-backlog) that collide with community agent collections like VoltAgent's awesome-claude-code-subagents. Users who install both systems get silent overwrites — a generic `architect.md` replaces specrails' pipeline-aware architect, breaking `/implement` without any error. Adding an `sr-` prefix to agents and `sr:` namespace to commands makes specrails coexist safely with any other agent ecosystem.

## What Changes

- **BREAKING**: All 12 agent files renamed from `<name>.md` to `sr-<name>.md` (e.g., `architect.md` → `sr-architect.md`)
- **BREAKING**: All 8 command files moved from `.claude/commands/<name>.md` to `.claude/commands/sr/<name>.md`, changing slash commands from `/<name>` to `/sr:<name>` (e.g., `/implement` → `/sr:implement`)
- **BREAKING**: Persona files renamed to `sr-<name>.md`
- **BREAKING**: Agent memory directories renamed to match new agent names (e.g., `agent-memory/architect/` → `agent-memory/sr-architect/`)
- All `subagent_type` references in commands updated to match new filenames
- All cross-references between agents and commands updated
- `update.sh` gains a `do_migrate_sr_prefix()` function to auto-migrate existing installations
- `setup.md` updated with new filenames and paths
- OpenSpec skill names (`opsx:*`) remain unchanged — already namespaciable and no collision detected
- Documentation updated across specrails and specrails-web

## Capabilities

### New Capabilities
- `sr-prefix-migration`: Automatic detection and migration of legacy (unprefixed) installations to sr-prefixed naming during `update.sh` runs

### Modified Capabilities
- `implement`: All agent references (`subagent_type` values, memory paths, prose) updated to sr-prefixed names; command becomes `/sr:implement`
- `batch-implement`: References to `/implement` become `/sr:implement`; command becomes `/sr:batch-implement`
- `setup-update-mode`: Template filenames, agent discovery, and manifest paths updated to sr-prefixed names; migration function added to update flow
- `confidence-scoring`: Reviewer agent references updated to `sr-reviewer`
- `compat-check`: Agent name surface entries updated to sr-prefixed names; command becomes `/sr:compat-check`

## Impact

- **All specrails templates**: 12 agent files + 8 command files renamed/moved
- **install.sh**: No hardcoded names (dynamic discovery), but setup.md it installs needs updating
- **update.sh**: New migration function + updated template paths in setup.md
- **openspec/specs/**: 5 spec files need delta updates for new naming
- **specrails-web**: docs (6 files), components (3 TSX files), manifest, and embedded specrails copy all need updating
- **Existing installations**: Require one `update.sh` run to migrate — the migration function handles renaming files, directories, and regenerating manifests
- **User muscle memory**: `/implement` becomes `/sr:implement` — breaking change for existing users
