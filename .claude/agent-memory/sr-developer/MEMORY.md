# Developer Agent Memory

- [Agent template pattern](agent-template-pattern.md) — how to create new agent templates and generated instances
- [Implement command structure](implement-command-structure.md) — phase ordering and insertion points in the pipeline command
- [install-sh-conventions.md](install-sh-conventions.md) — install.sh uses $REPO_ROOT (not $TARGET); shared dirs added to Phase 3 mkdir block
- [placeholder-false-positives.md](placeholder-false-positives.md) — prose `{{PLACEHOLDER}}` in backtick code spans is documentation, not an unresolved token
- [Generated instance gaps](generated-instance-gaps.md) — known differences between templates and generated instances (e.g., missing CLAUDE.md bullet in developer.md)

## SPEA-743 phase-2 notes (2026-04-11)

- `/specrails:setup` → `/specrails:enrich` rename: setup.md files kept during transition; new enrich.md files created alongside them
- `integration-contract.json` at repo root — machine-readable contract for hub/TUI to know command names, args, tier flags, model presets
- `commands/enrich.md` vs `templates/commands/specrails/enrich.md`: template version has extra agents.yaml content (agents config section, Phase 2.5, model resolution in Phase 4.1)
- `Lite Mode` renamed to `Quick Mode`; `--from-config` is the new mode for config-driven installs

## feature-proposal-modal decisions (2026-03-17)

- `ProposalManager` is a standalone class, not a subclass of `ChatManager` — see explanations/2026-03-17-developer-proposal-manager-not-chatmanager.md
- `useProposal` uses a `useRef` to avoid WS race condition when proposalId arrives before re-render — see explanations/2026-03-17-developer-proposalid-ref-ws-race.md
- Proposal route tests inject fake context directly into registry `_contexts` — see explanations/2026-03-17-developer-proposal-routes-test-pattern.md
- `resolveCommand` extracted from `QueueManager._resolveCommand` into `server/command-resolver.ts` — both ProposalManager and QueueManager use it
- DB migration 5 adds `proposals` table; orphan sweep cancels `exploring`/`refining` rows on server restart
