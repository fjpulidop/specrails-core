# Tasks: simplify-core-v5

## 1. Template deletions

- [x] 1.1 Delete 11 non-core agent templates from `templates/agents/`: `sr-product-manager.md`, `sr-product-analyst.md`, `sr-test-writer.md`, `sr-doc-sync.md`, `sr-merge-resolver.md`, `sr-frontend-developer.md`, `sr-backend-developer.md`, `sr-frontend-reviewer.md`, `sr-backend-reviewer.md`, `sr-security-reviewer.md`, `sr-performance-reviewer.md` (leaving exactly the 3 core agents)
- [x] 1.2 Delete removed command templates: `templates/commands/specrails/enrich.md`, `reconfig.md`, `vpc-drift.md`, `auto-propose-backlog-specs.md`, `get-backlog-specs.md`, `merge-resolve.md`
- [x] 1.3 Delete `templates/personas/` (persona.md, the-maintainer.md), `templates/codex-skills/enrich/`, `templates/codex-skills/merge-resolve/`, `templates/settings/perf-thresholds.yml`, and root `commands/enrich.md`
- [x] 1.4 Prune dead references from surviving templates: `implement.md` (see group 4), `batch-implement.md`, `retry.md`, `telemetry.md`, `memory-inspect.md`, `health-check.md`, `refactor-recommender.md`, `explore-spec.md`, gemini TOMLs (`implement.toml`, `batch-implement.toml`), codex skills (`implement/`, `batch-implement/`, `retry/`, `rails/`), and the 3 core agent bodies (any mention of enrich/VPC/removed agents)
- [x] 1.5 Acceptance sweep: `grep -ri 'enrich\|sr-product\|sr-test-writer\|sr-doc-sync\|sr-merge-resolver\|sr-frontend\|sr-backend\|sr-security-reviewer\|sr-performance-reviewer\|vpc' templates/ commands/` returns zero hits (except deliberate release-note prose, if any)

## 2. Installer: remove tiers and enrich

- [x] 2.1 `scaffold.ts`: delete the tier branch guarding placement, the full-tier enrich hint block, the `personas/` staging dir + codex `skills/enrich` dir creation, `QUICK_EXCLUDED_AGENTS`, `QUICK_EXCLUDED_SKILLS`, and the `tier` field from `ScaffoldInput`; rename `placeQuickTierArtefacts` → `placeArtefacts` and make it the unconditional path. KEEP `.specrails/setup-templates/` as internal staging (placement source + update checksum baseline)
- [x] 2.2 `scaffold.ts`: prune removed agents from provider render support (`GEMINI_MODEL_BY_AGENT` already core-only — verify; codex/gemini skill placement lists; `CORE_AGENTS` untouched)
- [x] 2.3 `install-config.ts`: remove `Tier` type and `tier` from `InstallConfig`; parser ignores an existing `tier` key (tolerated on read, never written); drop tier validation error
- [x] 2.4 `cli.ts` + `commands/init.ts`: remove `--quick` flag handling and `tierHint`; `--quick` now errors with `--quick was removed in v5 — init now installs everything directly`; remove both post-install tier messages, replace with a single mode-less summary
- [x] 2.5 `bin/specrails-core.mjs`: remove `enrich` from the subcommand allowlist and its spawn block; invoking it prints `enrich was removed in v5 — init now installs everything directly` and exits non-zero; update help text
- [x] 2.6 `bin/tui-installer.mjs`: delete Step 2 (tier select), the tier line in the YAML writer, the full-tier "Next: run /specrails:enrich" epilogue; shrink the agent multiselect to the 3 core agents (or remove the step entirely and print a profiles pointer); update `ALL_AGENT_IDS`
- [x] 2.7 `phases/prereqs.ts`: remove the JIRA CLI check (1.8) and enrich-oriented comments/messaging
- [x] 2.8 `commands/doctor.ts`: replace the `/specrails:enrich` remediation hint with `Run npx specrails-core update to regenerate.`

## 3. Installer: update-command v5 migration

- [x] 3.1 `commands/update.ts`: add cleanup pass — delete every manifest-tracked file the v5 template set no longer produces (removed agents, commands, skill dirs) plus the obsolete `setup-templates/personas/` + enrich staging subtrees; KEEP and refresh `setup-templates/` itself; never touch `.specrails/profiles/**`, `custom-*.md`, or untracked files
- [x] 3.2 `commands/update.ts`: print a migration summary listing removed paths + pointer `Removed v4 artefacts — agents beyond the core trio now come from profiles (custom-*.md).` (only when something was removed)
- [x] 3.3 Update refreshes `setup-templates/` from the npm package (existing flow) then places from it; obsolete manifest command entries (removed commands) are deleted from live dirs and dropped from the manifest
- [x] 3.4 Tolerate pre-v5 `install-config.yaml`: unknown agents in `agents.selected` are skipped with a warning naming them; `tier` key ignored

## 4. implement.md: single path

- [x] 4.1 Phase -1: collapse legacy/profile dual-mode into `AVAILABLE_AGENTS = profile ?? baseline`; baseline is the implicit in-command default `{sr-architect, sr-developer, sr-reviewer}` with standard models; remove the terms "legacy mode"/"profile mode" and all per-mode branches
- [x] 4.2 Profile validation: non-baseline agent missing on disk → warn `[warn] profile references agent '<id>' but no agent file exists — skipping (removed in v5; use a custom-* agent)` and continue; baseline agent missing → hard error `[error] Core agent <name> not found. Run npx specrails-core update to reinstall.`
- [x] 4.3 Delete layer-based developer routing (Phase 3b routing table + `DEVELOPER_ROUTING`), Phase 3c (test-writer), Phase 3d (doc-sync), extra reviewer passes in 4b (frontend/backend/security/performance), and every `∈ AVAILABLE_AGENTS` guard for removed agents; keep profile-declared `custom-*` routing hooks
- [x] 4.4 Phase 4a multi-feature merge: remove the sr-merge-resolver delegation branch; built-in section-aware/patch merge is the only path; unresolvable conflicts go to "Requires Manual Resolution" in the report
- [x] 4.5 Update the agent table (lines ~231-240), status JSON template (test-writer/doc-sync keys), and pipeline diagrams to the 3-agent + custom-* reality
- [x] 4.6 Mirror 4.1–4.5 in `templates/gemini-commands/implement.toml` and the codex `implement` skill
- [x] 4.7 `batch-implement.md` (+ gemini TOML + codex skill): remove sr-merge-resolver dependency per the batch-implement delta (orchestrator-owned conflict resolution, wave halt on unresolvable conflicts)

## 5. Tests

- [x] 5.1 `scaffold.test.ts` + `__tests__/scaffold.test.ts`: remove tier-branch cases; assert direct placement is unconditional (no tier input), agent set is exactly the core trio across all 3 providers; `setup-templates/` still staged but with no `personas/` subtree
- [x] 5.2 `install-config.test.ts`: remove tier validation cases; add case `tier: full` in YAML is ignored without error
- [x] 5.3 `init.test.ts` + `cli` arg-parser tests: `--quick` errors; no enrich hint in output; summary is mode-less
- [x] 5.4 `update.test.ts` + `v5-migration.test.ts`: migration cases — removed agent/command files deleted, obsolete `setup-templates/personas/` removed, `setup-templates/` itself kept, reserved paths (`profiles/**`, `custom-*.md`) and untracked files untouched, migration summary printed
- [x] 5.5 `manifest.test.ts`: manifest rewrite drops obsolete entries after cleanup
- [x] 5.6 `reserved-paths.test.ts`: contract unchanged — update fixtures that referenced removed agents/tiers; audit still passes
- [x] 5.7 Add template-inventory test: `templates/agents/` contains exactly 3 files; no removed command/persona template exists under `templates/` (the modeless-install audit scenario)
- [x] 5.8 Full suite green: `npm test` (typecheck + build + vitest) on the local platform; verify CI matrix on the PR

## 6. Docs and specs

- [ ] 6.1 README: rewrite install flow (single `npx specrails-core@latest init`), remove tier/enrich sections, document the 3-agent baseline + profiles extension path, add v5 migration notes (update cleanup, custom-* migration recipe for removed agents)
- [ ] 6.2 CLAUDE.md (repo): update repo-layout tree (no personas/, no enrich command), Architecture line (drop sr-product-manager stage), Profiles section (single resolution path wording), dogfood grep example if it references removed agents
- [ ] 6.3 Delete legacy flat spec files superseded/removed: `openspec/specs/quick-start-mode.md`, `smart-merge-resolver.md`, `performance-regression-detector/` (dir) — at archive time via `/opsx:archive` sync; verify the delta specs land in `openspec/specs/`
- [ ] 6.4 Release notes / CHANGELOG guidance: document BREAKING changes (enrich removed, tiers removed, 11 agents removed, desktop protocol obsolete) and the migration recipes; commit as `feat!:` so release-please cuts v5.0.0
- [ ] 6.5 Repo-wide acceptance sweep: `grep -ri 'enrich\|tier\|quick' src/ bin/ templates/ commands/ README.md CLAUDE.md` — remaining hits are only deliberate (error messages naming the removal, release notes, unrelated words); zero references to any removed agent name outside release notes

## 7. Downstream coordination (tracking only, outside this repo)

- [ ] 7.1 File a specrails-desktop issue: migrate from `enrich --from-config` + `[checkpoint:phase_*]` parsing to `init --from-config` + profiles; desktop pins `specrails-core@^4` until adapted
- [ ] 7.2 Verify `schemas/profile.v1.json` needs no change (baseline validation already matches the v5 trio; custom-* support unchanged) — confirm and note in the PR description
