# Proposal: simplify-core-v5

## Why

specrails-core has accumulated three overlapping installation/configuration mechanisms (full tier + `/specrails:enrich`, quick tier, profiles) and 14 agent templates, of which only three — `sr-architect`, `sr-developer`, `sr-reviewer` — are actually integrated with the OpenSpec workflow that is the product's core value. The enrich wizard alone is ~62K of prompt duplicated across two providers, the full tier stages templates that quick placement already installs directly, and `implement.md` (63K) carries a dual legacy/profile mode plus routing tables for 9 optional agents that either bypass OpenSpec entirely (0 `opsx` references: test-writer, doc-sync, merge-resolver, all extra reviewers) or duplicate what per-layer rules already provide (frontend/backend developers). Every agent is a template maintained across three provider render paths (claude/codex/gemini). This is a large maintenance surface for marginal value, and it obscures the clean story: **three OpenSpec agents that work together, extensible via profiles**.

## What Changes

### Removals (**BREAKING**)

- **Enrich mode, entirely**: `commands/enrich.md` (1,456 lines), `templates/commands/specrails/enrich.md` (62K), `templates/codex-skills/enrich/`, the `enrich` subcommand in `bin/specrails-core.mjs`, the desktop checkpoint protocol (`[checkpoint:phase_*]`), `enrich --update` / `--from-config` / `--quick` sub-modes, and every "run /specrails:enrich" hint in installer output (`init.ts`, `doctor.ts`, `scaffold.ts`, `prereqs.ts` comments).
- **Install tiers**: the `Tier` type (`'full' | 'quick'`), the `tier` field in `.specrails/install-config.yaml`, the `--quick` CLI flag, the tier prompt in `bin/tui-installer.mjs`, the full-tier "stage then run enrich" handoff, and the quick-tier exclusion sets (`QUICK_EXCLUDED_AGENTS`, `QUICK_EXCLUDED_SKILLS`) — no longer needed when the excluded artefacts no longer exist. (`.specrails/setup-templates/` itself STAYS as internal, gitignored staging — it is the source placement copies from and the checksum baseline `update` diffs against; only the enrich/personas staging and the tier branch around it are removed.)
- **VPC ecosystem**: agents `sr-product-manager`, `sr-product-analyst`; `templates/personas/` (`persona.md`, `the-maintainer.md`); commands `vpc-drift.md`, `auto-propose-backlog-specs.md`, `get-backlog-specs.md`, `reconfig.md`; VPC sections in `telemetry.md` and `memory-inspect.md`.
- **9 non-core agents**: `sr-test-writer`, `sr-doc-sync`, `sr-merge-resolver`, `sr-frontend-developer`, `sr-backend-developer`, `sr-frontend-reviewer`, `sr-backend-reviewer`, `sr-security-reviewer`, `sr-performance-reviewer` — plus their per-provider render support (`GEMINI_MODEL_BY_AGENT` entries, codex skills `merge-resolve/`), the `merge-resolve.md` command, `perf-thresholds.yml` settings template, and all routing in `implement.md` (layer-based developer routing in Phase 3b, test-writer Phase 3c, doc-sync Phase 3d, extra reviewer passes Phase 4b, `∈ AVAILABLE_AGENTS` guards).
- **Legacy mode in `implement.md`**: the dual legacy/profile resolution collapses into a single path — `agents = profile ?? baseline-of-3`. Phase -1 keeps profile resolution (env var → `project-default.json`) but the fallback is now the implicit 3-agent baseline, not a hardcoded 12-agent roster with routing tables.

### What stays (unchanged contracts)

- **Profiles system** is the only extension path: `schemas/profile.v1.json`, reserved paths (`.specrails/profiles/**`, `.claude/agents/custom-*.md`), baseline agent validation. A profile can still add `custom-*` agents with routing; the installer still never touches reserved paths.
- **OpenSpec workflow skills** (opsx), per-layer rules, `templates/claude-md/`, settings, the three provider scaffolds (claude/codex/gemini), `implement`/`batch-implement`/`retry`/`doctor`/`why`/`telemetry`/`health-check`/`compat-check`/`explore-spec`/`opsx-diff`/`propose-spec` commands (pruned of dead-agent references where needed).
- **`update` command** absorbs migration: on update of a pre-v5 install it must clean up now-obsolete artefacts (removed agent files it owns via manifest, removed commands, the enrich/personas staging subtrees under `setup-templates/`) without touching reserved paths or user files.

### Result

`npx specrails-core@latest init` becomes mode-less: one direct-placement path installing 3 agents + commands + rules + opsx skills, adapted per provider. No follow-up wizard required. Version bump: **v5.0.0**.

## Capabilities

### New Capabilities

- `modeless-install`: single direct-placement installation path — behavior formerly known as "quick tier" becomes the only path; covers what init installs, per-provider placement, and the absence of staging/tiers.

### Modified Capabilities

- `core-agent-baseline`: the baseline (sr-architect, sr-developer, sr-reviewer) becomes the ONLY shipped agent set; extension exclusively via profiles/custom agents.
- `implement`: single agent-resolution path (`profile ?? baseline`), removal of layer routing, phases 3c/3d, extra reviewer passes 4b, and all optional-agent guards.
- `batch-implement`: drops the sr-merge-resolver dependency; conflict handling is owned by the orchestrator.
- `setup-update-mode`: update flow absorbs pre-v5 migration/cleanup (setup-templates dir, removed agents/commands per manifest); no more enrich `--update`.
- `doctor-command`: remediation hints no longer reference enrich; regeneration hint becomes "re-run init/update".
- `prerequisite-detection`: drops enrich-only checks (JIRA CLI) and enrich-oriented messaging.

### Removed Capabilities

- `quick-start-mode`: superseded by `modeless-install` (the mode distinction disappears).
- `smart-merge-resolver`: agent removed; spec deleted.
- `performance-regression-detector`: agent removed; spec and `perf-thresholds.yml` deleted.

## Impact

- **Code**: `src/installer/phases/scaffold.ts` (largest diff: tier branches, staging, exclusion sets, quick-placement rename to the main path), `install-config.ts` (drop `tier`), `cli.ts`/`init.ts` (drop `--quick`, tier hints), `update.ts` (add v5 migration), `doctor.ts`, `prereqs.ts`, `bin/specrails-core.mjs` (drop `enrich` subcommand), `bin/tui-installer.mjs` (drop tier step, shrink agent multiselect to profiles-note).
- **Templates**: delete 11 agent templates, 7+ command templates, personas dir, enrich codex-skill, merge-resolve codex-skill; prune dead-agent references from `implement.md`, `batch-implement.md`, `retry.md`, `telemetry.md`, `memory-inspect.md`, `merge-resolve.md` (deleted), gemini TOMLs.
- **Tests**: every suite touching tiers/enrich/removed agents (`scaffold.test.ts`, `init.test.ts`, `update.test.ts`, `install-config.test.ts`, `manifest.test.ts`, `reserved-paths.test.ts` — the latter's contract stays but fixtures change).
- **Docs/specs**: README install flow, CLAUDE.md repo docs, OpenSpec main specs listed above.
- **Downstream (BREAKING)**: specrails-desktop — the enrich checkpoint protocol (`CheckpointTracker`, `--from-config` spawning) becomes obsolete; desktop must move to driving `init --from-config` (config-driven install still supported minus `tier`) and profiles. Profiles referencing removed `sr-*` agents (e.g. `sr-frontend-developer`) will no longer resolve to a shipped template — validator behavior must be defined (warn + skip vs. error).
- **Versioning**: major bump to v5.0.0 via conventional commit `feat!:` / release-please.
