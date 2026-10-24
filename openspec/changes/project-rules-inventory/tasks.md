## 1. Inventory

- [x] 1.1 `src/agent-runtime/project-rules.ts`: gate discovery (scripts, lint/format configs, strict tsconfig, architecture tests, hooks, CI, openspec), rule statement parsing with `file:line` and stable ids, `rules.json` read/write.
- [x] 1.2 Classification: one free provider turn through the executor registry (architect provider), JSON schema, `applyClassification`, cache by rule id, `--reclassify`, offline/unavailable/failed statuses.
- [x] 1.3 `specrails-core rules inventory` in the installer dispatcher and help; `init` runs it offline and snapshots `rules.json` for rollback.

## 2. Runtime

- [x] 2.1 `projectRulesContext` reads `<backlogRoot>` then `<artifactRoot>` `.specrails/rules.json`.
- [x] 2.2 Reviewer section "Project rules that need a human" (into `brief.humanChecks`); architect section "Project gates (default verification)" when the host configured no verification; legacy nodes and engine role turns.

## 3. Contract and docs

- [x] 3.1 `runtime api` capability `rulesInventory: 1`; `agentRuntime.rulesInventory` (schema 5.7, shared bump); contract test.
- [x] 3.2 `docs/agent-runtime.md` "Project rules inventory"; `CLAUDE.md` layout.

## 4. Tests

- [x] 4.1 Unit: gate discovery (scripts, configs, strict tsconfig, architecture tests, hooks, CI folded/literal blocks, openspec), JSONC, rule parsing (lists, continuations, fences, tables, managed blocks), classification filtering.
- [x] 4.2 Inventory: offline, empty, classified with cache and re-classification of changed rules, no/invalid configuration, failed call, non-JSON and fenced replies.
- [x] 4.3 CLI (`rules inventory`, `--json`, usage errors), `init` writes `rules.json`, prompts render both sections only when applicable.
- [x] 4.4 `npm run ci`.
