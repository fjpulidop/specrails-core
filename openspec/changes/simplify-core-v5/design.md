# Design: simplify-core-v5

## Context

specrails-core today has two install tiers wired through the whole installer:

```
                       init (cli.ts)
                            │
              ┌─────────────┴──────────────┐
              │ tier=full (default)         │ tier=quick (--quick / yaml)
              ▼                             ▼
   scaffold: STAGE templates       scaffold: placeQuickTierArtefacts()
   to .specrails/setup-templates/  → direct copy of agents/commands/
              │                       rules/skills into provider dirs
              ▼                       (minus QUICK_EXCLUDED_* sets)
   user runs /specrails:enrich
   (1,456-line wizard: codebase
   analysis → VPC personas →
   generate agents/commands/rules)
```

On top of that, `implement.md` resolves its agent roster in Phase -1 through a dual mode:

```
Phase -1:  $SPECRAILS_PROFILE_PATH ?  → profile mode (AVAILABLE_AGENTS from JSON)
           .specrails/profiles/project-default.json ? → profile mode
           else → LEGACY mode (hardcoded 12-agent roster + layer routing
                               + phases 3c/3d/4b guards)
```

Only `sr-architect` → `sr-developer` → `sr-reviewer` participate in the OpenSpec lifecycle (`/opsx:ff` → `/opsx:apply` → `/opsx:archive`). The other 11 agents are either VPC-dependent (product-manager, product-analyst), OpenSpec-blind bolt-ons (test-writer, doc-sync, merge-resolver, 4 extra reviewers), or duplications of what per-layer rules provide (frontend/backend developers).

Constraints:

- **Reserved paths contract** (audited by `reserved-paths.test.ts`): the installer must never create/modify/delete `.specrails/profiles/**` or `.claude/agents/custom-*.md`. This contract survives v5 untouched.
- **Three provider render paths** (claude / codex / gemini) in `scaffold.ts` must keep working for the 3 core agents.
- **specrails-desktop** currently spawns enrich with `--from-config` and parses `[checkpoint:phase_*]` markers. It is the main downstream consumer and will need a coordinated release.
- **Manifest system** (`.specrails/specrails-manifest.json`) tracks installer-owned files — this is the mechanism `update` will use to garbage-collect removed artefacts safely.

## Goals / Non-Goals

**Goals:**

- One installation path: `init` places the 3 core agents + commands + rules + opsx skills directly, per provider, with no follow-up step.
- Delete enrich, tiers, VPC ecosystem, and the 9 non-core agents plus every reference to them.
- Collapse `implement.md` to a single agent-resolution path: `agents = profile ?? baseline`.
- `update` migrates pre-v5 installs: removes installer-owned obsolete files, leaves user/reserved files alone.
- Keep the profiles system as the sole extension mechanism, contract unchanged.

**Non-Goals:**

- No changes to the OpenSpec skill set (opsx:*) or the three core agent personas beyond removing references to deleted agents/VPC.
- No changes to the profile v1 schema (`$id`, baseline validation, custom-agent support all stay). A schema v2 is NOT part of this change.
- No redesign of batch-implement's wave computation — only removal of its sr-merge-resolver dependency.
- No new capabilities for desktop; desktop's adaptation is downstream work outside this repo.
- No retroactive cleanup of target repos that never run `update` (v4 installs keep working as-is; they just won't get v5 templates).

## Decisions

### D1 — Quick-tier placement becomes THE scaffold path (rename, don't rewrite)

`placeQuickTierArtefacts()` already implements exactly the desired behavior (direct placement across providers, agent/skill filtering). The tier branch that guards it is deleted; the function is renamed (e.g. `placeArtefacts`) and runs unconditionally. `QUICK_EXCLUDED_AGENTS` / `QUICK_EXCLUDED_SKILLS` are deleted outright — the artefacts they excluded no longer exist in `templates/`.

**`.specrails/setup-templates/` STAYS.** During investigation it turned out this dir is NOT enrich-specific: the placement pipeline is `scriptDir/templates/ → setup-templates/ → live provider dirs`, and `update` uses `setup-templates/` as its checksum baseline for template diffing. It is internal, gitignored (under `.specrails/`), and load-bearing. Removing it would mean rewiring every placement source path and the update diff for no user-facing gain and real risk (it also backs `installFramework`/`assembleProjectWorkspace` materialization). What IS removed from staging: the `personas/` subdir (VPC gone) and any enrich staging; the tier branch around placement.

*Alternative considered*: fully delete `setup-templates/` and read placement/update straight from `scriptDir/templates/`. Rejected — high blast radius on the framework materializer, no user benefit; the dir is an implementation detail, not a mode.

*Alternative considered*: keeping a hidden `tier` for desktop compat. Rejected — dead flags rot; desktop moves to `init --from-config` (which stays, minus the `tier` key).

### D2 — `tier` in install-config.yaml: tolerated on read, never written

`install-config.ts` drops `tier` from the `InstallConfig` interface and stops validating its value. Pre-v5 YAML files in the wild may still contain `tier: full|quick`; the parser **ignores unknown keys** rather than erroring, so old config files keep loading. The TUI stops writing it.

*Alternative*: hard-error on `tier`. Rejected — it would break `init --from-config` against every config file desktop has already written, for zero benefit.

### D3 — implement.md: baseline is an implicit default, not a generated profile

Phase -1 keeps the two-step profile resolution (env var → project-default.json). When neither exists, `AVAILABLE_AGENTS = {sr-architect, sr-developer, sr-reviewer}` with the standard model defaults — expressed inline in the command, not by writing a profile file. Writing a default profile would violate the reserved-paths contract (`.specrails/profiles/**` is not installer-owned).

Profiles that reference removed `sr-*` agents (e.g. `sr-frontend-developer`): the roster in a profile is validated against *available agent files*, not a hardcoded list — a profile agent whose file is missing produces a **warning + skip** (pipeline continues with remaining agents), except for the three baseline agents which remain **required** (hard error if missing, unchanged from profile v1 semantics).

*Alternative*: hard-error on any unknown agent. Rejected — it would brick every desktop-generated v4 profile after upgrade; warn-and-skip degrades gracefully and the warning tells the user what to fix.

### D4 — Routing/phases removal in implement.md

Deleted from the command template: layer-based developer routing (Phase 3b routing table), test-writer phase (3c), doc-sync phase (3d), extra reviewer passes (4b), and every `∈ AVAILABLE_AGENTS` optional guard for removed agents. What remains: architect → developer(s) → reviewer, with profile-declared `custom-*` agents still routable where the profile declares routing (profile mode capability is unchanged — it simply no longer has 9 first-party agents to route to).

Multi-feature conflict handling in `batch-implement`: with sr-merge-resolver gone, the orchestrator instruction becomes "on merge conflict, resolve directly in the integration step; if unresolvable, stop the wave and report" — no delegation to a specialist agent.

### D5 — `update` performs v5 migration via the manifest

`update.ts` gains a cleanup pass: for every file recorded in `.specrails/specrails-manifest.json` that the v5 template set no longer produces (removed agents, removed commands, enrich skill dirs), delete it; then remove the now-obsolete staging subtrees under `setup-templates/` (`personas/`, any enrich staging) while KEEPING `setup-templates/` itself as the refreshed v5 baseline; then write the new artefacts and refresh the manifest. Reserved paths and files not in the manifest are never touched — a user-modified copy of e.g. `sr-security-reviewer.md` that was manifest-tracked is still removed (it is installer-owned by contract), but `custom-*.md` files never are.

*Alternative*: leave stale files and only add new ones. Rejected — orphaned agents referencing deleted commands/personas produce confusing runtime failures; the manifest exists precisely to make removal safe.

### D6 — Deletion vs. deprecation of the `enrich` subcommand

`bin/specrails-core.mjs` removes `enrich` from the command allowlist. Invoking it prints a clear error: "enrich was removed in v5 — init now installs everything directly" (one line in the unknown-command path, not a preserved stub). Same message strategy for `--quick` (unknown-flag error naming the removal).

### D7 — Spec bookkeeping

Main specs deleted with the change: `quick-start-mode`, `smart-merge-resolver`, `performance-regression-detector`. New spec: `modeless-install`. Modified: `core-agent-baseline`, `implement`, `batch-implement`, `setup-update-mode`, `doctor-command`, `prerequisite-detection`. Flat legacy spec files (`quick-start-mode.md` etc.) are removed at archive time by the sync.

## Risks / Trade-offs

- **[Desktop breakage]** specrails-desktop drives enrich + parses checkpoints → Mitigation: v5 is a major release; `init --from-config` remains the supported programmatic path (config schema minus `tier`, unknown keys ignored). Coordinate a desktop release; until then desktop pins `specrails-core@^4`.
- **[Profiles referencing removed agents]** v4 profiles break silently → Mitigation: D3's warn-and-skip with an explicit warning naming the missing agent and pointing to `custom-*` migration.
- **[Users relying on removed agents]** e.g. teams using sr-security-reviewer → Mitigation: the agent bodies are plain Markdown; the v5 release notes document copying any v4 agent to `.claude/agents/custom-<name>.md` + declaring it in a profile — same behavior, user-owned.
- **[update deleting a file the user customized]** manifest-tracked files are removed even if edited → Mitigation: this is the pre-existing manifest contract (installer-owned files); release notes call it out, and `update` already prints every file it touches.
- **[Scope size]** one big change touching installer + templates + specs + tests → Mitigation: strictly subtractive for 80% of the diff; tests updated in the same tasks as the code they cover; CI matrix (cross-OS) gates the release.
- **[Doc drift]** README/CLAUDE.md mention tiers, enrich, 14 agents in many places → Mitigation: dedicated docs task with a final `grep -ri 'enrich\|tier\|sr-product\|sr-test-writer'` sweep as acceptance check.

## Migration Plan

1. Land the change behind a major version: `feat!: remove enrich/tiers/non-core agents` → release-please cuts v5.0.0.
2. Existing v4 target repos: `npx specrails-core@latest update` runs the D5 cleanup (obsolete manifest-tracked files + `.specrails/setup-templates/`) and installs v5 artefacts.
3. Rollback strategy: none needed in target repos (update is re-runnable; pinning `specrails-core@4` restores the old installer). The npm dist-tags keep v4 available.
4. Desktop: migrates from `enrich --from-config` + checkpoints to `init --from-config` (already supported today), and from selecting the 14-agent roster to profile-based extension.

## Open Questions

- Should `update` from v4 print a one-time migration summary (list of removed files + "profiles are now the extension path" pointer)? Leaning yes — cheap and high-signal. (Resolved during implementation unless objected.)
- `templates/gemini-commands/batch-implement.toml` and codex `batch-implement` skill: verify batch-implement works with the 3-agent baseline on both providers, or descope those providers' batch entry points if they hard-depend on merge-resolver.
