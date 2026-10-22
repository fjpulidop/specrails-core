## Why

External feedback (feedback-2026-10, Phase 4 task 4.4, annex D.5) asked Specrails to start from what a project already enforces: which gates exist, which written rules they cover, and which rules only a human can check. Today Core knows none of it. The reviewer cannot point the merging human at the project's own human-only rules, an architect without host verification guesses commands, and Claude Code installs, unlike Codex, Gemini and Kimi, get no Specrails instruction block.

## What Changes

- **Inventory command.** `specrails-core rules inventory [--root] [--artifact-root] [--offline] [--reclassify] [--json]` writes `.specrails/rules.json`. `init` runs it offline after installing.
- **Deterministic gates.** Package scripts, lint and format configurations, strict `tsconfig.json`, architecture tests, git hooks, check-like CI steps of pull-request/push workflows and `openspec validate` become `gates[{id, kind, command, source}]`.
- **Deterministic rules.** Rule statements of `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md` are parsed with `source: file:line` and a stable id.
- **One classification call.** The architect's provider, read-only and without role instructions, classifies each statement as `enforcedBy` (gate), `automatable` (`proposedCheck`) or `humanOnly`. The model never adds, drops or rewrites a rule; without a provider, offline or on failure, rules stay `unclassified`. Classifications are cached by rule id.
- **Runtime use.** The reviewer receives the `humanOnly` rules and copies the ones the change could break into `brief.humanChecks`. With no host verification configured, the architect is offered the discovered gates as the default verification proposal.
- **Claude instruction block.** The root `CLAUDE.md` gets the sentinel-managed Specrails block the other providers already had (separate commit on the same branch).
- **Contract.** Capability `rulesInventory: 1` in `runtime api` and `agentRuntime.rulesInventory` in `integration-contract.json`. Additive; it rides the branch's single 5.6 → 5.7 bump (unreleased local branch, no extra bump). Role instructions stay at the branch's 17.

## Capabilities

### New Capabilities
- `project-rules-inventory`: gate discovery, rule parsing, classification, `rules.json`, its CLI and `init` hook, and the reviewer/architect use of the inventory.

### Modified Capabilities
<!-- None in a canonical tree: Core has no openspec/specs/. -->

## Impact

- **Code:** `src/agent-runtime/project-rules.ts` (new), `prompts.ts` (two sections), `graph/nodes.ts` and `engine/pieces/role-turn.ts` (read the inventory), `cli.ts` (capability), `installer/cli.ts` (`rules` command), `installer/commands/init.ts` (offline run, rollback surface).
- **Contract:** `integration-contract.json` 5.7 with `agentRuntime.rulesInventory`. Desktop reads `.specrails/rules.json` when `rulesInventory >= 1` (project settings, packet "needs a human eye", one-click spec from `automatable`, default verification plan) and may run `rules inventory` to classify.
- **Compatibility:** additive. A project without `rules.json` gets byte-identical prompts.
- **Out of scope:** Desktop settings, packet and ticket source (Desktop side of task 4.4); enforcing `automatable` rules.
