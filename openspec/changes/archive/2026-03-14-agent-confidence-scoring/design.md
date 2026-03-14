---
change: agent-confidence-scoring
type: design
---

# Design: Agent Confidence Scoring & Validation Framework

## Architecture Overview

The confidence scoring system has three components:

1. **Schema** — a JSON structure that agents emit, versioned and self-describing
2. **Agent extension** — additions to the reviewer agent prompt that instruct it to produce a score
3. **Pipeline gate** — a new phase in `/implement` that reads the score and blocks if thresholds are breached
4. **Configuration** — a template-generated `confidence-config.json` that controls thresholds per target repo

The system is deliberately simple. Confidence scores live as files on disk (not in memory, not in a database), which keeps them readable, diffable, and auditable. The pipeline gate is a conditional block in the existing `/implement` markdown command — no new scripts, no new processes.

---

## Confidence Score JSON Schema

Every agent that emits a confidence score writes a file named `confidence-score.json` in `openspec/changes/<name>/`. This co-locates the score with the rest of the OpenSpec change artifacts, making it easy to audit and archive together.

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
    "type_correctness": "All function signatures match the existing codebase style.",
    "pattern_adherence": "One deviation from the established error-handling pattern in utils/parser.ts — flagged but not blocking.",
    "test_coverage": "Integration tests are missing for the cache invalidation path. Unit coverage looks adequate.",
    "security": "No new attack surface. Input validation follows existing patterns.",
    "architectural_alignment": "The new module respects layer boundaries. One circular import risk noted in the design — mitigated by the developer's approach."
  },
  "flags": []
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema_version` | string | yes | Always `"1"` for this version of the schema |
| `change` | string | yes | Kebab-case change name matching the `openspec/changes/<name>/` directory |
| `agent` | string | yes | Which agent produced the score: `"reviewer"`, `"developer"`, `"architect"` |
| `scored_at` | string | yes | ISO 8601 timestamp of when the score was produced |
| `overall` | integer | yes | 0–100. The agent's aggregate confidence in the quality of its output |
| `aspects` | object | yes | Five named aspect scores, each 0–100 |
| `aspects.type_correctness` | integer | yes | Confidence that types, signatures, and interfaces are correct |
| `aspects.pattern_adherence` | integer | yes | Confidence that implementation follows existing codebase patterns |
| `aspects.test_coverage` | integer | yes | Confidence that test coverage is adequate for the changes |
| `aspects.security` | integer | yes | Confidence that no security regressions or new attack surface was introduced |
| `aspects.architectural_alignment` | integer | yes | Confidence that the implementation respects architectural boundaries and design intent |
| `notes` | object | yes | One required note per aspect explaining the score. Must be non-empty strings. |
| `flags` | array | yes | Optional list of strings. Each string names a concern the agent wants to surface explicitly (e.g., `"missing-integration-test"`, `"unresolved-merge-conflict"`). Empty array if none. |

### Score Semantics

- **90–100**: High confidence. The agent believes this aspect is solid.
- **70–89**: Moderate confidence. Worth a quick review but not alarming.
- **50–69**: Low confidence. The agent recommends human review of this aspect.
- **0–49**: Very low confidence. The agent believes there is a real problem here.

These semantics are informational — the pipeline gate uses the configured thresholds, not these bands.

---

## Configuration Schema: `confidence-config.json`

Installed into `.claude/confidence-config.json` in every target repo via `/setup`. The template lives at `templates/settings/confidence-config.json`.

```json
{
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

### Field Definitions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `schema_version` | string | `"1"` | Config schema version |
| `enabled` | boolean | `true` | Set to `false` to disable the gate entirely without removing the file |
| `thresholds.overall` | integer | `70` | Minimum required overall score |
| `thresholds.aspects.*` | integer | `60` (security: `75`) | Minimum required score per aspect |
| `on_breach` | string | `"block"` | `"block"` halts Phase 4c. `"warn"` prints but continues. |
| `override_allowed` | boolean | `true` | If `true`, the user can unblock a breached gate by providing an override reason in the pipeline prompt |

### Built-in Defaults (fallback when config file is absent)

If `.claude/confidence-config.json` does not exist, the pipeline uses these defaults and prints a one-time notice:

```
[confidence] No confidence-config.json found. Using built-in defaults.
[confidence] To customize thresholds, create .claude/confidence-config.json.
```

Built-in defaults match the config schema defaults above.

---

## File Changes

### New Files

| File | Layer | Purpose |
|------|-------|---------|
| `templates/settings/confidence-config.json` | templates | Template for per-repo confidence threshold config, installed by `/setup` |

### Modified Files

| File | Layer | Change |
|------|-------|--------|
| `templates/agents/reviewer.md` | templates | Add confidence scoring section: instructions to produce `confidence-score.json` after completing the review |
| `templates/commands/implement.md` | templates | Add Phase 4b-conf: read confidence score, compare against thresholds, block Phase 4c if breach detected |

---

## Data Flow

```
Phase 4b (reviewer agent runs)
    ↓
reviewer writes openspec/changes/<name>/confidence-score.json
    ↓
Phase 4b-conf (pipeline reads score)
    ↓ reads .claude/confidence-config.json (or built-in defaults)
    ↓ compares each aspect score against threshold
    ↓
    ├── All scores >= thresholds → proceed to Phase 4c
    └── Any score < threshold →
            if on_breach=block → print breach report, halt before Phase 4c
            if on_breach=warn  → print breach report, continue to Phase 4c
```

---

## Reviewer Agent Extension

The reviewer agent prompt (`templates/agents/reviewer.md`) gains a new section at the end: **Confidence Scoring**.

The section instructs the reviewer to:

1. After completing all CI checks and fixes, self-assess confidence across the five aspects.
2. Write `openspec/changes/<name>/confidence-score.json` with the schema above.
3. Derive `change` from the context provided by the orchestrator (the change name passed in the agent's invocation prompt). If the change name is unavailable, derive it from the `openspec/changes/` directory that was active during the review.
4. Set `scored_at` to the current ISO 8601 timestamp.
5. Set `agent` to `"reviewer"`.
6. Populate `notes` with concrete, specific observations — not generic statements.
7. Populate `flags` with any named concerns not already captured in notes.

The scoring instruction is non-optional. The reviewer MUST produce the file. If it cannot (e.g., the change name is unclear), it sets `overall: 0` and writes a note in every aspect explaining the failure.

---

## Pipeline Gate: Phase 4b-conf

Added between Phase 4b (reviewer completes) and Phase 4c (git operations) in `templates/commands/implement.md`.

### Gate Logic (in prose for the command template)

```
## Phase 4b-conf: Confidence Gate

After the reviewer agent completes:

1. Read `openspec/changes/<name>/confidence-score.json`.
   - If the file does not exist: print a warning and proceed (non-blocking — reviewer may have
     failed to write it). Record `CONFIDENCE_STATUS=MISSING` in the Phase 4e report.

2. Read `.claude/confidence-config.json`.
   - If the file does not exist: use built-in defaults and print the one-time notice.
   - If `enabled: false`: print `[confidence] Gate disabled. Skipping.` and proceed.

3. Compare scores:
   - Check `overall` against `thresholds.overall`.
   - Check each aspect in `aspects` against `thresholds.aspects.<aspect>`.
   - Collect all breaches as a list: `{aspect, actual, threshold}`.

4. If `breaches` is non-empty and `on_breach = "block"`:
   - Print the Breach Report (see format below).
   - Set `CONFIDENCE_BLOCKED=true`.
   - Halt: do not proceed to Phase 4c.

5. If `breaches` is non-empty and `on_breach = "warn"`:
   - Print the Breach Report.
   - Set `CONFIDENCE_BLOCKED=false`.
   - Continue to Phase 4c.

6. If no breaches:
   - Print: `[confidence] All scores meet thresholds. Proceeding.`
   - Set `CONFIDENCE_BLOCKED=false`.
   - Continue to Phase 4c.
```

### Breach Report Format

```
## Confidence Gate: BLOCKED

The reviewer's confidence scores do not meet configured thresholds.

| Aspect | Score | Threshold | Delta |
|--------|-------|-----------|-------|
| overall | 62 | 70 | -8 |
| test_coverage | 55 | 60 | -5 |

### Reviewer Notes on Low-Scoring Aspects

**test_coverage (55):** Integration tests are missing for the cache invalidation path.

### Flags

- missing-integration-test

### Next Steps

1. Address the concerns above and re-run `/implement`.
2. Or, if you have reviewed the concerns and accept the risk, re-run with an override:
   `/implement #N --confidence-override "reason"`

Pipeline halted. No git operations have been performed.
```

### Override Flag

If `override_allowed: true` in the config and the user passes `--confidence-override "<reason>"` in the `/implement` invocation:

- Skip the blocking behavior.
- Print: `[confidence] Override accepted. Reason: <reason>. Proceeding with gate bypassed.`
- Record the override reason in the Phase 4e report.
- Continue to Phase 4c normally.

If `override_allowed: false` in the config, the `--confidence-override` flag is ignored and a note is printed: `[confidence] Override is disabled in confidence-config.json.`

---

## Dry-Run Behavior

When `DRY_RUN=true`:

- The reviewer still writes `confidence-score.json` (it is an OpenSpec artifact, not a git artifact).
- Phase 4b-conf still runs and evaluates the score.
- If `CONFIDENCE_BLOCKED=true`: record `skipped_operations: ["confidence-gate: blocked — Phase 4c skipped"]` in `.cache-manifest.json`.
- The Dry-Run Preview Report (Phase 4e) includes a Confidence section showing scores and gate outcome.

---

## Phase 4e Report Extension

The final report table gains a `Confidence` column:

```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Confidence | Security | CI | Status |
```

Confidence column values:
- `PASS (82)` — gate passed, overall score shown
- `WARN (62)` — gate warned, scores below threshold
- `BLOCKED (62)` — gate blocked, scores below threshold
- `OVERRIDE (62)` — gate bypassed by explicit override
- `MISSING` — score file not found
- `DISABLED` — gate disabled in config

---

## Ambiguities and Resolutions

**Ambiguity 1:** The issue says "could start with reviewer" — should architect and developer scoring be stubbed or completely deferred?

**Resolution:** Completely deferred. No stub placeholders are added to architect or developer templates. Adding empty stubs would create misleading `confidence-score.json` files with no actual assessment. Phase 2 will add full scoring to those agents when the design is ready.

**Ambiguity 2:** Where should `confidence-score.json` live when multiple features run in parallel?

**Resolution:** Each feature has its own `openspec/changes/<name>/` directory, so each gets its own `confidence-score.json`. The pipeline gate runs once per feature after its reviewer completes. No conflict risk.

**Ambiguity 3:** Should the gate block before or after the security reviewer?

**Resolution:** Before. The sequence is: reviewer → confidence gate → security reviewer → Phase 4c. If the confidence gate blocks, security review is also skipped (there's no point reviewing code we've already decided not to ship). This simplifies the state machine and avoids wasted work.
