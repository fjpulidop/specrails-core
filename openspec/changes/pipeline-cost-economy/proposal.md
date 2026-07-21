# Proposal: Pipeline cost economy — scoped test execution + design confidence gate

## Why

Profiling real `/specrails:implement` runs (58-minute run, 2026-07-19) showed the dominant cost driver is redundant full-suite test execution: the developer's TDD cycle ran the entire project suite per task step and looped unbounded at its validation gate ("there is no maximum number of attempts"), and the reviewer re-ran the full ordered CI list after every individual fix — 12+ full-suite executions in one run. Separately, implementation (the expensive phase) always runs even when the architect's design rests on unresolved ambiguity, paying full implementation cost for work a reviewer then rejects.

Cost of an agentic run ≈ Σ per turn (accumulated context × input price) + outputs. Both problems inflate the turn count and the context (full runner logs re-entering the window) of the costliest phase.

## What Changes

Two bundled specs, both prompt/template-only (no installer or CLI code changes):

1. **Test-execution economy** (`implement` capability): per-task TDD runs are SCOPED to the test file(s) the task touches; the full suite runs exactly once at the developer's validation gate (with a 2-fix-cycle budget and an honest-halt rule) and once as the reviewer's authoritative run (fix re-runs scoped, one final full confirmation). Runner output entering agent reasoning is capped at the failing tests + ≤50-line excerpt. Loop-detection and file re-read discipline added to both agents.

2. **Design confidence gate** (`implement` + `confidence-scoring` capabilities): the architect emits `design-confidence.json` (`high`/`medium`/`low` + `reason` + `blocking_question`); the orchestrator halts a feature BEFORE Phase 3b on `low`, relaying the single blocking question to the human. `--confidence-override` bypasses both this gate and the existing post-review gate. Missing file = proceed (backward compatible).

Parity: applied to the Claude templates (`templates/agents/sr-{architect,developer,reviewer}.md`, `templates/commands/specrails/implement.md`), the codex rail skills (`templates/codex-skills/rails/sr-{architect,developer}/SKILL.md`, `templates/codex-skills/implement/SKILL.md`), and the gemini orchestrator (`templates/gemini-commands/implement.toml`). Gemini/kimi agent definitions derive from `templates/agents/` at install time, so they inherit automatically.

## Impact

- Affected specs: `implement`, `confidence-scoring`
- Affected code: templates only (listed above). No breaking surface changes: `design-confidence.json` is a new additive artifact; absence preserves pre-change behaviour byte-for-byte.
