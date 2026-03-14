---
change: agent-confidence-scoring
type: context-bundle
---

# Context Bundle: Agent Confidence Scoring & Validation Framework

This document aggregates everything a developer needs to implement this change without reading other files. It is authoritative within this change directory — if it contradicts another file, flag it.

---

## What You Are Building

A confidence scoring system for the specrails agent pipeline. Specifically:

1. A JSON config template (`templates/settings/confidence-config.json`) that controls score thresholds per target repo.
2. An extension to the reviewer agent prompt (`templates/agents/reviewer.md`) that instructs it to self-assess and write a `confidence-score.json` file.
3. A new pipeline gate phase (`Phase 4b-conf`) in the `/implement` command (`templates/commands/implement.md`) that reads the score and optionally blocks shipping.
4. Two new/updated spec files (`openspec/specs/confidence-scoring.md`, `openspec/specs/implement.md`).

This is a **template-only change**. You are editing Markdown prompt templates and a JSON config template. No bash scripts, no build steps, no package dependencies.

---

## Repository Layout (Relevant Paths Only)

```
specrails/
├── templates/
│   ├── agents/
│   │   └── reviewer.md          ← MODIFY: add confidence scoring section
│   ├── commands/
│   │   └── implement.md         ← MODIFY: add Phase 4b-conf and update Phase 4e table
│   └── settings/
│       └── confidence-config.json  ← CREATE: new threshold config template
├── openspec/
│   └── specs/
│       ├── confidence-scoring.md   ← CREATE: new spec
│       └── implement.md            ← MODIFY: append confidence gate section
└── .claude/
    ├── agents/                  ← generated from templates/agents/ — do NOT edit directly
    └── commands/                ← generated from templates/commands/ — do NOT edit directly
```

**Critical rule:** Never edit files under `.claude/agents/` or `.claude/commands/` directly. Those are generated outputs. All changes go into `templates/`.

---

## System Conventions

- **Template placeholders:** `{{UPPER_SNAKE_CASE}}` — only use existing, already-documented placeholders. Do not invent new ones in this change.
- **File naming:** kebab-case everywhere.
- **JSON:** 2-space indentation. No trailing commas. Comments are not valid JSON — use a `"_docs"` key instead.
- **Markdown:** consistent heading levels, no trailing whitespace. Commands use `##` for phases, `###` for sub-phases.

---

## Confidence Score JSON Schema (exact)

Write this to `openspec/changes/<name>/confidence-score.json`:

```json
{
  "schema_version": "1",
  "change": "<change-name>",
  "agent": "reviewer",
  "scored_at": "<ISO 8601 timestamp>",
  "overall": 82,
  "aspects": {
    "type_correctness": 90,
    "pattern_adherence": 85,
    "test_coverage": 70,
    "security": 88,
    "architectural_alignment": 78
  },
  "notes": {
    "type_correctness": "Concrete observation here.",
    "pattern_adherence": "Concrete observation here.",
    "test_coverage": "Concrete observation here.",
    "security": "Concrete observation here.",
    "architectural_alignment": "Concrete observation here."
  },
  "flags": []
}
```

All fields are required. `notes` values must be non-empty strings. `flags` is an empty array when no named concerns exist.

---

## Confidence Config JSON Schema (exact)

Write to `templates/settings/confidence-config.json`:

```json
{
  "_docs": "specrails confidence gate configuration. Installed to .claude/confidence-config.json by /setup.",
  "schema_version": "1",
  "enabled": true,
  "thresholds": {
    "overall": 70,
    "aspects": {
      "type_correctness": 60,
      "pattern_adherence": 60,
      "test_coverage": 60,
      "security": 75,
      "architectural_alignment": 60
    }
  },
  "on_breach": "block",
  "override_allowed": true
}
```

---

## Aspect Definitions (for reviewer prompt)

| Aspect | What the reviewer should assess |
|--------|--------------------------------|
| `type_correctness` | Types, signatures, and interfaces are correct and consistent with the codebase |
| `pattern_adherence` | Implementation follows established patterns and conventions |
| `test_coverage` | Test coverage is adequate for the scope of changes |
| `security` | No security regressions or new attack surface introduced |
| `architectural_alignment` | Implementation respects architectural boundaries and design intent |

---

## Insertion Points in `templates/agents/reviewer.md`

The current file structure (relevant sections, in order):

1. YAML frontmatter
2. `## Your Mission`
3. `## CI/CD Pipeline Equivalence`
4. `## Review Checklist`
5. `## Workflow`
6. `## Output Format`
7. `## Rules`
8. `## Critical Warnings`
9. `# Persistent Agent Memory`

**Insert `## Confidence Scoring` between `## Critical Warnings` and `# Persistent Agent Memory`.**

The section title must use `##` (not `###`), consistent with the surrounding sections.

---

## Insertion Points in `templates/commands/implement.md`

Current Phase 4 structure (in order):

- `### 4a. Merge worktree changes to main repo`
- `### 4b. Launch Reviewer agent`
- `### 4b-sec. Launch Security Reviewer agent`
- `### 4c. Ship — Git & backlog updates`
- `### 4d. Monitor CI`
- `### 4e. Report`

**Insert `### 4b-conf. Confidence Gate` between `### 4b.` and `### 4b-sec.`**

Also update Phase 0 Flag Detection (currently covers `--dry-run` and `--apply`). Add `--confidence-override "<reason>"` flag detection after the existing flags, setting `CONFIDENCE_OVERRIDE_REASON` variable (empty string if not present).

---

## Phase 4b-conf: Exact Gate Logic

The following prose should appear in the `### 4b-conf. Confidence Gate` section. Adapt for Markdown formatting:

**Step 1 — Read score file:**
- Path: `openspec/changes/<name>/confidence-score.json`
- If missing: set `CONFIDENCE_STATUS=MISSING`, print `[confidence] Warning: confidence-score.json not found. Proceeding without gate.` Continue to Phase 4b-sec.

**Step 2 — Read config:**
- Path: `.claude/confidence-config.json`
- If missing: use built-in defaults. Print: `[confidence] No confidence-config.json found. Using built-in defaults.`
- If `enabled: false`: print `[confidence] Gate disabled. Skipping.` Set `CONFIDENCE_STATUS=DISABLED`. Continue to Phase 4b-sec.

**Step 3 — Compare scores:**
- Check `overall` vs `thresholds.overall`
- Check each of the five aspects vs `thresholds.aspects.<aspect>`
- Collect all breaches: `{aspect, actual_score, threshold, delta}`

**Step 4 — Apply on_breach:**

If no breaches:
- Print: `[confidence] All scores meet thresholds. Proceeding.`
- Set `CONFIDENCE_STATUS=PASS`
- Continue to Phase 4b-sec

If breaches exist and `on_breach=block`:
- Check `--confidence-override`: if present and `override_allowed=true`: set `CONFIDENCE_STATUS=OVERRIDE`, print override acceptance, continue to Phase 4b-sec
- If override not present or `override_allowed=false`: print Breach Report, set `CONFIDENCE_BLOCKED=true`, `CONFIDENCE_STATUS=BLOCKED`, halt before Phase 4b-sec and Phase 4c

If breaches exist and `on_breach=warn`:
- Print Breach Report
- Set `CONFIDENCE_STATUS=WARN`
- Continue to Phase 4b-sec

**Breach Report format (exact):**

```
## Confidence Gate: BLOCKED

The reviewer's confidence scores do not meet configured thresholds.

| Aspect | Score | Threshold | Delta |
|--------|-------|-----------|-------|
| <aspect> | <actual> | <threshold> | <delta (negative)> |

### Reviewer Notes on Low-Scoring Aspects

**<aspect> (<score>):** <note from confidence-score.json>

### Flags

- <flag-1>
- <flag-2>
(omit this section if flags array is empty)

### Next Steps

1. Address the concerns above and re-run `/implement`.
2. Or, if you have reviewed the concerns and accept the risk, re-run with an override:
   `/implement #N --confidence-override "reason"`

Pipeline halted. No git operations have been performed.
```

---

## Phase 4e Table Changes

**Before:**
```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Security | CI | Status |
```

**After:**
```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Confidence | Security | CI | Status |
```

Confidence column values:

| Value | Meaning |
|-------|---------|
| `PASS (82)` | All scores met thresholds; overall score in parens |
| `WARN (62)` | Scores below threshold but `on_breach=warn`; overall score in parens |
| `BLOCKED (62)` | Gate blocked pipeline; overall score in parens |
| `OVERRIDE (62)` | Gate bypassed by `--confidence-override`; overall score in parens |
| `MISSING` | `confidence-score.json` not found after reviewer completed |
| `DISABLED` | Gate disabled via `enabled: false` in config |

---

## Dry-Run Behavior

When `DRY_RUN=true`:
- Reviewer still writes `confidence-score.json` (it is an OpenSpec artifact)
- Phase 4b-conf still evaluates the score
- If `CONFIDENCE_BLOCKED=true`: add to `.cache-manifest.json` under `skipped_operations`: `"confidence-gate: blocked — Phase 4c and 4b-sec skipped"`
- Dry-Run Preview Report (Phase 4e) gains a `### Confidence` subsection:

```markdown
### Confidence

| Score file | openspec/changes/<name>/confidence-score.json |
| Gate result | BLOCKED / PASS / WARN / OVERRIDE / MISSING / DISABLED |
| Overall score | <score> |
```

---

## Multi-Feature Behavior

In multi-feature mode (worktrees), each feature gets its own reviewer agent and its own confidence gate evaluation. The gate for feature A does not affect feature B. Each feature's `CONFIDENCE_STATUS` is recorded independently. The Phase 4e table shows one row per feature.

---

## What NOT to Change

- `templates/agents/architect.md` — confidence scoring for architect is Phase 2
- `templates/agents/developer.md` — confidence scoring for developer is Phase 2
- `install.sh` — no changes needed; the settings template directory is already copied automatically
- Any existing phase logic in `implement.md` except the three specified insertion points (Phase 0 flag parsing, new Phase 4b-conf section, Phase 4e table header)

---

## Exact Changes Summary

| File | Operation | Exact Change |
|------|-----------|-------------|
| `templates/settings/confidence-config.json` | Create | New file: threshold config JSON |
| `templates/agents/reviewer.md` | Modify | Insert `## Confidence Scoring` section before `# Persistent Agent Memory` |
| `templates/commands/implement.md` | Modify (3 locations) | 1) Phase 0: add `--confidence-override` flag; 2) Insert `### 4b-conf.` between 4b and 4b-sec; 3) Phase 4e: add `Confidence` column |
| `openspec/specs/confidence-scoring.md` | Create | New spec file |
| `openspec/specs/implement.md` | Modify | Append `## Confidence Gate (Phase 4b-conf)` section |
