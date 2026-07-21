# Implementation Tasks

## 1. Test-execution economy — Claude templates
- [x] 1.1 `templates/agents/sr-developer.md`: scoped TDD runs (RED/GREEN/REFACTOR per test file), new "Test-Execution Economy" section (scoped-only inside task cycles, full suite once at gate, ≤50-line failure excerpts, loop detection, re-read discipline)
- [x] 1.2 `templates/agents/sr-developer.md` Phase 4: replace unbounded "re-run ALL tests / no maximum number of attempts" with one full run → scoped fix re-runs → 2-cycle budget → one final full run → honest HALT listing failing tests
- [x] 1.3 `templates/agents/sr-reviewer.md`: fix re-runs scoped to the failed check/files; full ordered list re-run once at the end; output-economy / re-read / loop-detection rules
- [x] 1.4 `templates/commands/specrails/implement.md` Phase 3b: developer prompts must carry the test-economy reminder (scoped per task, one gate run, reviewer owns the authoritative full run)

## 2. Test-execution economy — codex parity
- [x] 2.1 `templates/codex-skills/rails/sr-developer/SKILL.md`: scoped RED/GREEN/REFACTOR + economy block + bounded validation gate with honest `BLOCKED:` halt
- [x] 2.2 `templates/codex-skills/rails/sr-architect/SKILL.md`: tasks.md template's per-cycle steps say scoped runs, not "ALL tests"

## 3. Design confidence gate
- [x] 3.1 `templates/agents/sr-architect.md`: new Step 7 "Emit Design Confidence" (`design-confidence.json` schema + rubric + never-inflate rule)
- [x] 3.2 `templates/commands/specrails/implement.md`: new Phase 3a.3 gate (missing → warn+proceed; high/medium → proceed; low → halt feature pre-3b with blocking question; override via `--confidence-override`; per-feature in multi-mode; pipeline-state updates; artifacts left as resumable starting point)
- [x] 3.3 `templates/commands/specrails/implement.md` Phase 0: document that `--confidence-override` bypasses both gates
- [x] 3.4 Codex parity: architect skill emits the JSON + 3-line reply; implement orchestrator gates before Phase 2
- [x] 3.5 Gemini parity: `templates/gemini-commands/implement.toml` gate between DESIGN and APPLY

## 4. Validation gate
- [x] 4.1 `npx vitest run` — template/inventory suites pass (2 pre-existing failures in `cli-direct-run.test.ts` belong to unrelated uncommitted WIP on this branch)
- [x] 4.2 `npx tsc --noEmit` passes
