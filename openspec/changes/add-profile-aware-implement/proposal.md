## Why

Today the `implement` pipeline discovers agents via a hardcoded `ls .claude/agents/sr-*.md` glob and routes tasks to specialists via prose baked into `implement.md` (e.g. *"if tags include [frontend] use sr-frontend-developer"*). Per-agent models live in each agent's frontmatter. This makes the pipeline impossible to reconfigure per-invocation: every project, every feature, every developer runs the exact same chain with the exact same models, and every customization (a different model, a custom agent, a new routing rule) requires hand-editing `implement.md` — which `update.sh` silently overwrites on the next upgrade.

specrails-hub needs to expose per-project **agent profiles** (catalogs of named configurations selectable per-rail in batch runs) so users can tune the chain to the work. For this to be possible without forking `implement.md`, the pipeline must become **profile-aware** as a first-class upstream capability, while remaining fully functional for standalone CLI users who have no profiles at all.

## What Changes

- Add a new optional config surface at `<project>/.specrails/profiles/*.json` — a declarative description of which agents to use, which models to run them with, and how tasks route to specialists.
- Modify `implement.md` (Phase -1 discovery, Phase 3b routing) to read `$SPECRAILS_PROFILE_PATH` (env) or `.specrails/profiles/project-default.json` (file) when present, falling back to current hardcoded behavior when absent. **No breakage for standalone users.**
- Extend subagent invocation in `implement.md` to accept a model override from the active profile. Frontmatter `model:` remains the fallback; profile wins when specified. **Additive, non-destructive.**
- Modify `batch-implement.md` to forward a per-rail profile selection (via env var set by the spawning hub or CLI flag) so rails in the same batch can run different profiles simultaneously.
- Publish a versioned JSON schema for profiles (`schemaVersion: 1`) so the hub and the CLI can evolve the contract safely.
- Reserve the `<project>/.specrails/` directory tree for specrails-managed project config. `update.sh` must never touch it. Custom agents live in `.claude/agents/custom-*.md`; `update.sh` must never touch `custom-*` either.
- Document the profile contract in the README and in a new dedicated section of CLAUDE.md so standalone users can author profiles by hand if they wish.

## Capabilities

### New Capabilities
- `specrails-profiles`: declarative per-project agent/model/routing configuration with a versioned JSON schema, resolution order (env var → project default → legacy fallback), and reserved-directory guarantees (`.specrails/` untouched by updates; `.claude/agents/custom-*.md` untouched by updates).

### Modified Capabilities
- `implement`: Phase -1 agent discovery and Phase 3b routing become profile-aware with a legacy fallback path. Subagent invocation accepts a per-agent model override sourced from the active profile.
- `batch-implement`: per-rail profile selection is forwarded to each rail's `/specrails:implement` invocation so concurrent rails in the same batch can use distinct profiles.

## Impact

- **Code**:
  - `templates/commands/specrails/implement.md` — major edits (new Phase -1 branch, new Phase 3b branch, subagent model override mechanism)
  - `templates/commands/specrails/batch-implement.md` — minor edits (per-rail profile forwarding)
  - `install.sh` / `update.sh` — harden to skip `.specrails/` and `.claude/agents/custom-*.md`
  - `bin/tui-installer.mjs` — optional scaffold of `.specrails/profiles/default.json` when initializing (opt-in flag)
  - New `templates/profiles/default.json` shipping the baseline profile
- **APIs / contracts**: New JSON schema published at `schemas/profile.v1.json` (consumed by specrails-hub and by `implement.md`).
- **Docs**: README and CLAUDE.md gain a "Profiles" section. Backwards-compatibility contract documented explicitly.
- **Dependencies**: No new runtime deps. `jq` is used inside `implement.md` (already a standard tool in the target environment; add a preflight check if not).
- **Versioning**: Minor bump (additive, backward compatible). Target release line 4.1.0.
- **Consumers**: specrails-hub will depend on `specrails-core@>=4.1.0` to unlock the profiles feature.
