---
change: agent-confidence-scoring
type: delta-spec
---

# Delta Spec: Agent Confidence Scoring & Validation Framework

This document records the precise changes to existing specs and introduces new spec content. It is the authoritative record of what the spec system looks like after this change is applied.

---

## 1. New Spec: `openspec/specs/confidence-scoring.md`

**Action:** Create

This spec does not yet exist. After this change, it defines the confidence scoring contract.

```markdown
# Spec: Confidence Scoring System

Agents in the specrails pipeline MAY emit a structured confidence score alongside their output. The reviewer agent MUST emit a score. Future agents (developer, architect) MAY be extended in later changes.

---

## Score File

Each confidence score is written to:

```
openspec/changes/<name>/confidence-score.json
```

The file MUST conform to the schema defined in `design.md` for the `agent-confidence-scoring` change. It MUST be present after the reviewer agent completes. Its absence is treated as a warning (non-blocking) by the pipeline gate.

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

The pipeline gate (Phase 4b-conf in `/implement`) evaluates scores after the reviewer completes and before git operations begin (Phase 4c).

| `on_breach` value | Behavior |
|-------------------|----------|
| `"block"` (default) | Halts the pipeline. No git operations run. |
| `"warn"` | Prints the breach report but continues. |

The gate can be bypassed per-invocation with `--confidence-override "<reason>"` if `override_allowed: true` in the config.
```

---

## 2. Modified Spec: `openspec/specs/implement.md`

**Action:** Append new section

Add the following section after the existing "Edge Cases" section:

```markdown
---

## Confidence Gate (Phase 4b-conf)

### Position in Pipeline

Phase 4b-conf runs AFTER Phase 4b (reviewer) and BEFORE Phase 4c (git operations).

### Inputs

- `openspec/changes/<name>/confidence-score.json` — written by the reviewer agent
- `.claude/confidence-config.json` — threshold configuration (falls back to built-in defaults if absent)

### Behavior

The gate compares each score in `confidence-score.json` against the corresponding threshold in `confidence-config.json`. If any score falls below its threshold:

- `on_breach: "block"` (default): pipeline halts before Phase 4c. A breach report is printed.
- `on_breach: "warn"`: breach report is printed, pipeline continues.

### Override

If `--confidence-override "<reason>"` is passed to `/implement` and `override_allowed: true` in the config, the gate is bypassed. The override reason is recorded in the Phase 4e report.

### Missing Score File

If `confidence-score.json` does not exist after the reviewer completes, the gate prints a warning and proceeds. `CONFIDENCE_STATUS=MISSING` is recorded in the Phase 4e report.

### Disabled Gate

If `enabled: false` in the config, the gate is skipped entirely.

### Dry-Run Compatibility

When `DRY_RUN=true`, the gate still evaluates scores. If `CONFIDENCE_BLOCKED=true`, it records the block in `.cache-manifest.json` under `skipped_operations`.

### Multi-Feature Mode

In multi-feature mode, each feature's confidence score is evaluated independently after its reviewer completes. A block on one feature does not block other features from proceeding to Phase 4c. Each feature's gate outcome is recorded independently in the Phase 4e report.
```

---

## 3. No Other Spec Files Changed

The following existing specs are unaffected by this change:

- `openspec/specs/batch-implement.md` — no pipeline gate changes required
- `openspec/specs/versioning` — no version bump required; this is additive
- `openspec/specs/update-system` — no changes required
- `openspec/specs/setup-update-mode` — no changes required

---

## 4. Template Inventory After This Change

| Template File | Status | Change |
|--------------|--------|--------|
| `templates/settings/confidence-config.json` | New | Created — threshold config for target repos |
| `templates/agents/reviewer.md` | Modified | Confidence scoring section added |
| `templates/commands/implement.md` | Modified | Phase 4b-conf block added; Phase 4e table column added |
| `templates/agents/architect.md` | Unchanged | Phase 2 |
| `templates/agents/developer.md` | Unchanged | Phase 2 |
