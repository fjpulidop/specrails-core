---
change: agent-confidence-scoring
type: tasks
---

# Tasks: Agent Confidence Scoring & Validation Framework

Tasks are ordered sequentially. Each task depends on the one before it unless stated otherwise.

---

## T1 — Create `templates/settings/confidence-config.json` [templates]

**Description:**
Create the confidence threshold configuration template that `/setup` installs into `.claude/confidence-config.json` in every target repo. This file must be valid JSON with documented fields. It is a static file — no `{{PLACEHOLDER}}` substitution is needed because thresholds are not repo-specific at install time (they are customizable by the user after installation).

**Files:**
- Create: `templates/settings/confidence-config.json`

**Acceptance criteria:**
- File is valid JSON
- Contains all fields from the config schema in `design.md`: `schema_version`, `enabled`, `thresholds.overall`, `thresholds.aspects` (all five aspects), `on_breach`, `override_allowed`
- Default values match the design exactly: `overall: 70`, `security: 75`, all other aspects `60`, `on_breach: "block"`, `override_allowed: true`
- A comment-style note (via a `"_comment"` key or inline in the file preamble) explains each field — since JSON doesn't support comments, use a top-level `"_docs"` key with a brief description string
- File is formatted with 2-space indentation

**Dependencies:** none

---

## T2 — Add confidence scoring section to `templates/agents/reviewer.md` [templates]

**Description:**
Add a new **Confidence Scoring** section to the reviewer agent prompt template. This section must appear after the existing "Rules" and "Critical Warnings" sections and before the "Persistent Agent Memory" section. It instructs the reviewer to self-assess confidence across five aspects and write `confidence-score.json` to `openspec/changes/<name>/`.

The section must specify:
- That scoring is mandatory, not optional
- How to derive the `change` name (from the orchestrator-provided context, or by finding the `openspec/changes/` directory being reviewed)
- All five aspect definitions (copy from design.md aspect table)
- That `notes` must be concrete and specific — not generic boilerplate
- The exact output file path: `openspec/changes/<name>/confidence-score.json`
- That if the change name cannot be determined, write the score with `"change": "unknown"` and `"overall": 0` with explanatory notes
- The full JSON schema (copy from design.md) as a reference example within the prompt

**Files:**
- Modify: `templates/agents/reviewer.md`

**Acceptance criteria:**
- New section titled `## Confidence Scoring` is present
- Section appears after the `## Rules` block and before the `## Persistent Agent Memory` block
- All five aspects are defined with their names and descriptions
- Output file path is explicit: `openspec/changes/<name>/confidence-score.json`
- A complete, valid example JSON block is included in the prompt as a reference
- The `scored_at` field is set to the current timestamp at time of writing
- The `agent` field is hardcoded to `"reviewer"` in the instructions
- Fallback behavior (unknown change name) is defined
- No new `{{PLACEHOLDER}}` tokens are introduced (the existing template already has all needed ones)

**Dependencies:** T1

---

## T3 — Add Phase 4b-conf to `templates/commands/implement.md` [templates]

**Description:**
Insert a new `## Phase 4b-conf: Confidence Gate` section into `templates/commands/implement.md` between the existing `### 4b-sec. Launch Security Reviewer agent` section and `### 4c. Ship` section.

Wait — re-read the design. The confidence gate must run BEFORE the security reviewer (per design.md "Ambiguity 3" resolution). The correct insertion point is: after `### 4b. Launch Reviewer agent` completes and before `### 4b-sec. Launch Security Reviewer agent`.

The section must implement the gate logic from design.md verbatim:
1. Read `confidence-score.json` — handle missing file gracefully
2. Read `confidence-config.json` — handle missing file with built-in defaults and one-time notice
3. Handle `enabled: false` — skip gate
4. Compare scores against thresholds — collect breaches
5. Apply `on_breach` behavior: block or warn
6. Handle `--confidence-override` flag: check `override_allowed`, bypass gate, record reason
7. Set `CONFIDENCE_BLOCKED` variable for downstream use

The `--confidence-override` flag must also be parsed in Phase 0 (Flag Detection) alongside the existing `--dry-run` and `--apply` flags.

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- New `## Phase 4b-conf: Confidence Gate` section is present between `### 4b.` and `### 4b-sec.`
- Phase 0 Flag Detection section documents `--confidence-override "<reason>"` flag parsing and sets `CONFIDENCE_OVERRIDE_REASON` variable
- Gate reads from `openspec/changes/<name>/confidence-score.json` — path is correct
- Missing score file sets `CONFIDENCE_STATUS=MISSING` and is non-blocking
- Missing config file triggers built-in defaults with one-time notice (exact text from design.md)
- `enabled: false` path is handled with skip message
- Breach report format matches design.md exactly (table with Aspect, Score, Threshold, Delta columns)
- `CONFIDENCE_BLOCKED=true` causes pipeline to halt before Phase 4b-sec and Phase 4c
- `--confidence-override` with `override_allowed: true` bypasses the block
- `--confidence-override` with `override_allowed: false` is rejected with printed notice
- `on_breach: "warn"` path continues to Phase 4b-sec despite breach
- In multi-feature mode (worktrees), the gate runs per-feature immediately after each feature's reviewer completes; the section documents this explicitly

**Dependencies:** T2

---

## T4 — Extend Phase 4e report table in `templates/commands/implement.md` [templates]

**Description:**
Update the Phase 4e (Report) section in `templates/commands/implement.md` to add a `Confidence` column to the final pipeline status table.

The existing table header is:
```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Security | CI | Status |
```

It becomes:
```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Confidence | Security | CI | Status |
```

Document the six possible Confidence column values from design.md:
- `PASS (82)` — gate passed, score shown
- `WARN (62)` — gate warned
- `BLOCKED (62)` — gate blocked
- `OVERRIDE (62)` — bypassed by override
- `MISSING` — score file not found
- `DISABLED` — gate disabled in config

Also update the Dry-Run Preview Report format (Phase 4e, `DRY_RUN=true` path) to include a Confidence section showing scores and gate outcome.

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 4e standard table header includes `Confidence` column between `Reviewer` and `Security`
- All six column value formats are documented in the section prose
- Dry-Run Preview Report includes a `### Confidence` subsection showing the score file path and gate outcome
- If `CONFIDENCE_OVERRIDE_REASON` is set, it appears in the Phase 4e report under a `### Confidence Override` heading with the reason

**Dependencies:** T3

---

## T5 — Create `openspec/specs/confidence-scoring.md` [core]

**Description:**
Create the new spec file documenting the confidence scoring system as a first-class specrails spec. This spec is the reference document for any future agent or pipeline extension that touches confidence scoring.

Copy the spec content verbatim from the delta-spec.md `## 1. New Spec` section in this change directory.

**Files:**
- Create: `openspec/specs/confidence-scoring.md`

**Acceptance criteria:**
- File exists at `openspec/specs/confidence-scoring.md`
- Contains all sections from the delta-spec: Score File, Aspects table, Configuration, Gate Behavior
- Aspect table matches design.md exactly (same five aspects, same definitions)
- Default thresholds table matches design.md exactly
- Gate behavior table covers both `on_breach` values
- Override and dry-run behavior are documented

**Dependencies:** T1

---

## T6 — Append confidence gate section to `openspec/specs/implement.md` [core]

**Description:**
Append the new "Confidence Gate (Phase 4b-conf)" section to `openspec/specs/implement.md`. This extends the existing spec for the `/implement` command with the confidence gate contract.

Copy the section verbatim from the delta-spec.md `## 2. Modified Spec` section in this change directory.

**Files:**
- Modify: `openspec/specs/implement.md`

**Acceptance criteria:**
- New section `## Confidence Gate (Phase 4b-conf)` is appended after the existing `## Edge Cases` section (or at the end of the file)
- All subsections present: Position in Pipeline, Inputs, Behavior, Override, Missing Score File, Disabled Gate, Dry-Run Compatibility, Multi-Feature Mode
- Multi-feature behavior is documented: per-feature evaluation, independent blocking
- No existing content in `implement.md` is modified — append only

**Dependencies:** T5

---

## T7 — Verify template integrity: no broken placeholders [core]

**Description:**
After all template modifications are complete, verify that no `{{PLACEHOLDER}}` tokens were accidentally introduced into generated-path files (`.claude/agents/`, `.claude/commands/`) or left unresolved in templates. Also verify the new `confidence-config.json` template is valid JSON.

Run the verification commands from CLAUDE.md:

```bash
# Check for broken placeholders in generated files
grep -r '{{[A-Z_]*}}' .claude/agents/ .claude/commands/ 2>/dev/null || echo "No broken placeholders found"

# Validate the new JSON template
python3 -m json.tool templates/settings/confidence-config.json > /dev/null && echo "Valid JSON" || echo "INVALID JSON"

# Confirm new template files exist
ls templates/settings/confidence-config.json
ls openspec/specs/confidence-scoring.md
```

This task is verification-only — no files should need to be created or modified. If issues are found, fix them before marking this task complete.

**Files:**
- No files created or modified (verification only)

**Acceptance criteria:**
- `grep` command returns no results (no broken placeholders in generated files)
- `python3 -m json.tool` exits 0 for `confidence-config.json`
- All five new/modified files exist: `templates/settings/confidence-config.json`, `openspec/specs/confidence-scoring.md`, modified `templates/agents/reviewer.md`, modified `templates/commands/implement.md`, modified `openspec/specs/implement.md`
- A manual read of each modified file confirms the sections were inserted at the correct positions

**Dependencies:** T2, T3, T4, T5, T6
