## 1. Installer: Establish single core-agent constant

**Layer**: [installer] [core]
**Files**: Modify `src/installer/phases/scaffold.ts`

- [x] 1.1 Export a `CORE_AGENTS` constant (`new Set(['sr-architect', 'sr-developer', 'sr-reviewer'])`) at the top of `scaffold.ts`
- [x] 1.2 Replace the hardcoded `QUICK_REQUIRED_AGENTS` set with `CORE_AGENTS` (remove `sr-merge-resolver` from the set)
- [x] 1.3 Update `CORE_RAIL_AGENTS` inside `placeSkills` to reference `CORE_AGENTS` instead of the inline four-element set
- [x] 1.4 Verify `EXPLANATION_AUTHORS` and `QUICK_EXCLUDED_AGENTS` are unaffected (they are not part of the core baseline and should remain as-is)

**Acceptance criteria**: One grep for `sr-merge-resolver` in `scaffold.ts` shows it only in comments (if any) and not in any required-agent set.

## 2. Installer: Default fresh init to three core agents

**Layer**: [installer] [core]
**Files**: Modify `src/installer/phases/scaffold.ts`

- [x] 2.1 In `placeQuickTierArtefacts`, change the branch that handles `selectedAgents === null` (no install-config) to default to `CORE_AGENTS` rather than placing all non-excluded agents
- [x] 2.2 Confirm the codex `placeSkills` rail path uses the same default: when `selectedAgents` is `null`, default to `CORE_AGENTS` only
- [x] 2.3 Ensure the `QUICK_EXCLUDED_AGENTS` exclusion filter is still applied after the default is applied (VPC agents remain excluded regardless)

**Acceptance criteria**: Running `init` (quick tier) without any `install-config.yaml` places exactly three `sr-*.md` files in `.claude/agents/` — `sr-architect.md`, `sr-developer.md`, `sr-reviewer.md`.

## 3. TUI Installer: Pre-select only core agents by default

**Layer**: [installer]
**Files**: Modify `bin/tui-installer.mjs`

- [x] 3.1 Locate the agent picker step in `tui-installer.mjs` and identify how default selections are set
- [x] 3.2 Change the default pre-checked set to `['sr-architect', 'sr-developer', 'sr-reviewer']` only
- [x] 3.3 Confirm all other agents (including `sr-merge-resolver`) render as unchecked opt-in options
- [x] 3.4 Confirm the TUI writes the full user-selected list (core + any opt-in choices) to `agents.selected` in `install-config.yaml`

**Acceptance criteria**: Running the TUI with no selections changed results in `agents.selected: [sr-architect, sr-developer, sr-reviewer]` written to `install-config.yaml`. Selecting `sr-test-writer` additionally results in it appearing in `agents.selected`.

## 4. Update command: Verify optional-agent preservation

**Layer**: [installer]
**Files**: Read `src/installer/commands/update.ts`; modify only if a gap is found

- [x] 4.1 Trace the `update.ts` path: confirm `loadInstallConfig` is called, `config.agents.selected` is read, and that value is passed as `selectedAgents` to `scaffoldInstallation`
- [x] 4.2 If a gap is found (e.g., `selectedAgents` is not passed or is discarded), close it so previously-selected optional agents are re-placed on update
- [x] 4.3 Add or update a test in `src/installer/__tests__/` that mocks an `install-config.yaml` with an optional agent selected, runs `update`, and asserts the optional agent is re-placed

**Acceptance criteria**: A user who installed with `sr-test-writer` selected sees `sr-test-writer.md` re-placed after `npx specrails-core update`. A user who never selected `sr-doc-sync` does not see it appear after update.

## 5. Implement pipeline: Demote `sr-merge-resolver` to optional

**Layer**: [template]
**Files**: Modify `templates/commands/specrails/implement.md`

- [x] 5.1 In the agent role table (Phase -1, agent discovery section), change `sr-merge-resolver` row from "Core (always present)" to "Optional" with note "required for multi-feature merge conflict resolution"
- [x] 5.2 Confirm the gate rule for `sr-merge-resolver` absence in Phase 4a: the pipeline SHALL skip invoking the agent and fall back to the built-in section-aware merge, printing `"sr-merge-resolver not installed — skipping merge conflict resolution agent"`
- [x] 5.3 Confirm the error message for missing core agents (`sr-architect`, `sr-developer`, `sr-reviewer`) still reads: `[error] Core agent <name> not found. Run /specrails:enrich or reinstall.` — only these three trigger a stop

**Acceptance criteria**: The agent role table in `implement.md` lists exactly three core agents. Phase 4a runs without error when `sr-merge-resolver` is absent.

## 6. Implement pipeline: Harden optional-agent gate rules (both modes)

**Layer**: [template]
**Files**: Modify `templates/commands/specrails/implement.md`

- [x] 6.1 Review Phase 3c (`sr-test-writer`), Phase 3d (`sr-doc-sync`), Phase 4b layer reviewers (`sr-frontend-reviewer`, `sr-backend-reviewer`, `sr-security-reviewer`, `sr-performance-reviewer`) — confirm each has an explicit `if not in AVAILABLE_AGENTS → skip` guard
- [x] 6.2 For legacy mode: confirm each optional agent check uses `[[ -f ".claude/agents/$id.md" ]]` before invoking; add the check where missing
- [x] 6.3 For profile mode: confirm each optional agent check uses `AVAILABLE_AGENTS` (populated from profile `agents[]`); add the check where missing
- [x] 6.4 Confirm the Phase -1 summary table prints counts as `core: 3/3, optional: M` (not `core: 4/4`)

**Acceptance criteria**: Running the pipeline with only `sr-architect`, `sr-developer`, `sr-reviewer` installed (no other agents) completes all phases without errors; optional phases are skipped with informational notes.

## 7. Tests: Assert new default agent set

**Layer**: [installer]
**Files**: Create or modify test in `src/installer/__tests__/scaffold.test.ts` (or equivalent)

- [x] 7.1 Add a test: `placeQuickTierArtefacts` with `selectedAgents: undefined` places exactly the three core agents in the output directory
- [x] 7.2 Add a test: `CORE_AGENTS` constant contains exactly `['sr-architect', 'sr-developer', 'sr-reviewer']` and not `sr-merge-resolver`
- [x] 7.3 Add a test: `placeQuickTierArtefacts` with `selectedAgents: ['sr-test-writer']` places `sr-test-writer` in addition to the three core agents (opt-in works)
- [x] 7.4 Run `npm test` and confirm all tests pass

**Acceptance criteria**: `npm test` passes green with the new test assertions included.

## 8. Compatibility check and documentation

**Layer**: [core]
**Files**: Read `openspec/specs/implement.md` and `openspec/specs/setup-update-mode/spec.md`; update inline comments in changed files if needed

- [x] 8.1 Run a grep across the repo for any hardcoded list of four "core" agents (`sr-architect sr-developer sr-reviewer sr-merge-resolver` together) in non-template, non-test files, and update each occurrence to reference `CORE_AGENTS` or the three-agent list
- [x] 8.2 Verify `schemas/profile.v1.json` baseline requirement already lists exactly the three core agents (no change needed, but confirm)
- [x] 8.3 Add a comment to `CORE_AGENTS` in `scaffold.ts` pointing to `schemas/profile.v1.json` as the authoritative source for why these three are chosen
