# Spec: Confidence Scoring System

Agents in the specrails pipeline MAY emit a structured confidence score alongside their output. The sr-reviewer agent MUST emit a score. Future agents (sr-developer, sr-architect) MAY be extended in later changes.

---

## Score File

Each confidence score is written to:

```
openspec/changes/<name>/confidence-score.json
```

The file MUST conform to the schema defined in `design.md` for the `agent-confidence-scoring` change. It MUST be present after the sr-reviewer agent completes. Its absence is treated as a warning (non-blocking) by the pipeline gate.

---

## Aspects

Five aspects are scored, each 0–100:

| Aspect | Definition |
|--------|-----------|
| `type_correctness` | Types, signatures, and interfaces are correct and consistent with the codebase |
| `pattern_adherence` | Implementation follows established patterns and conventions |
| `test_coverage` | Test coverage is adequate for the scope of changes |
| `security` | No security regressions or new attack surface introduced |
| `architectural_alignment` | Implementation respects architectural boundaries and design intent |

---

## Configuration

The pipeline gate is configured via `.claude/confidence-config.json` (installed by `/setup` from `templates/settings/confidence-config.json`).

If the config file is absent, built-in defaults apply:

| Threshold | Default |
|-----------|---------|
| `overall` | 70 |
| `type_correctness` | 60 |
| `pattern_adherence` | 60 |
| `test_coverage` | 60 |
| `security` | 75 |
| `architectural_alignment` | 60 |

---

## Gate Behavior

The pipeline gate (Phase 4b-conf in `/sr:implement`) evaluates scores after the sr-reviewer completes and before git operations begin (Phase 4c).

| `on_breach` value | Behavior |
|-------------------|----------|
| `"block"` (default) | Halts the pipeline. No git operations run. |
| `"warn"` | Prints the breach report but continues. |

The gate can be bypassed per-invocation with `--confidence-override "<reason>"` if `override_allowed: true` in the config.
