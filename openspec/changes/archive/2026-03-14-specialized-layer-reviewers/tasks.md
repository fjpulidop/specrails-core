---
change: specialized-layer-reviewers
type: tasks
---

# Tasks: Specialized Layer Reviewers

Tasks are ordered sequentially unless stated otherwise. Each task depends on the one before it unless a different dependency is stated.

---

## T1 — Create `templates/agents/frontend-reviewer.md` skeleton [templates]

**Description:**
Create the file with frontmatter, identity statement, inputs section, and section headings for the three checks (Bundle Size, Accessibility, Render Performance). Do not fill in check logic yet — establish structure only. The skeleton must be a valid Claude Code agent file that can be loaded without errors.

**Files:**
- Create: `templates/agents/frontend-reviewer.md`

**Acceptance criteria:**
- File exists at correct path
- YAML frontmatter present with: `name: frontend-reviewer`, `description`, `model: sonnet`, `color: blue`, `memory: project`
- `description` field instructs orchestrator when to use this agent: "Use when frontend files have been modified. Scan-and-report only."
- Inputs section lists: `FRONTEND_FILES_LIST`, `PIPELINE_CONTEXT`
- Placeholders present and documented: `{{FRONTEND_STACK}}`, `{{MEMORY_PATH}}`
- Section headings present: `## Bundle Size`, `## Accessibility`, `## Render Performance`, `## Output Format`, `## Rules`, `## Persistent Agent Memory`
- File ends with the persistent agent memory section (matching pattern in `security-reviewer.md`)
- No `{{PLACEHOLDER}}` tokens other than `{{FRONTEND_STACK}}` and `{{MEMORY_PATH}}`

**Dependencies:** none

---

## T2 — Implement Bundle Size and Render Performance checks in `frontend-reviewer.md` [templates]

**Description:**
Fill in the `## Bundle Size` and `## Render Performance` sections with specific patterns to detect, as defined in `design.md`. Include a finding severity table for each section.

**Files:**
- Modify: `templates/agents/frontend-reviewer.md`

**Acceptance criteria:**
- `## Bundle Size` section covers all four patterns from `design.md`: dynamic imports without chunk naming, large static assets without compression, heavy library synchronous imports, unused CSS classes
- Each pattern has a stated severity (High or Medium)
- `## Render Performance` section covers all four patterns: render-blocking scripts, synchronous data fetching in useEffect, missing key props on list renders, missing memo/useMemo on hot-path derived values
- Each pattern has a stated severity
- Prose is in second-person imperative: "Look for...", "Flag if...", "Scan..."
- No invented patterns beyond those in `design.md`

**Dependencies:** T1

---

## T3 — Implement Accessibility check in `frontend-reviewer.md` [templates]

**Description:**
Fill in the `## Accessibility` section with the full WCAG 2.1 AA check table from `design.md`. Include file type scope (which file extensions each rule applies to).

**Files:**
- Modify: `templates/agents/frontend-reviewer.md`

**Acceptance criteria:**
- Accessibility section contains a table with columns: Rule | What to look for | File types | Severity
- All seven rules from `design.md` are present: missing alt text, missing form labels, non-semantic interactive elements, missing ARIA roles, low contrast (static), missing landmark regions, missing page title
- File type scope is stated for each rule (e.g., "`.html`, `.jsx`, `.tsx`, `.vue`")
- Severities match `design.md`: missing alt, missing labels, non-semantic interactive = High; rest = Medium
- Low contrast rule is correctly marked as "flag for manual review" (not auto-detectable)

**Dependencies:** T2

---

## T4 — Implement output format and rules in `frontend-reviewer.md` [templates]

**Description:**
Fill in the `## Output Format` section with the exact report structure from `design.md`, and fill in the `## Rules` section. The output format must include the `FRONTEND_REVIEW_STATUS:` terminal line protocol.

**Files:**
- Modify: `templates/agents/frontend-reviewer.md`

**Acceptance criteria:**
- Output format matches `design.md` exactly: three finding tables (Bundle Size, Accessibility, Render Performance) followed by `FRONTEND_REVIEW_STATUS:` line
- `FRONTEND_REVIEW_STATUS: ISSUES_FOUND` condition stated: any High or Medium finding
- `FRONTEND_REVIEW_STATUS: CLEAN` condition stated: no findings
- Rules section states: "Never fix code. Never suggest code changes. Scan and report only."
- Rules section states: "The `FRONTEND_REVIEW_STATUS:` line MUST be the very last line of output. Nothing may follow it."
- Rules section states: "Never ask for clarification. Complete the scan with available information."
- Memory section follows the exact pattern from `security-reviewer.md` (what to save, guidelines)
- What to save in memory: "false positive patterns for this repo's frontend stack", "file paths or naming patterns that commonly trigger false positives"

**Dependencies:** T3

---

## T5 — Create `templates/agents/backend-reviewer.md` skeleton [templates]

**Description:**
Create the file with frontmatter, identity statement, inputs section, and section headings for the four checks (N+1 Queries, Connection Pool Safety, Pagination Safety, Missing Indexes). Establish structure only — do not fill check logic yet.

**Files:**
- Create: `templates/agents/backend-reviewer.md`

**Acceptance criteria:**
- File exists at correct path
- YAML frontmatter: `name: backend-reviewer`, `description`, `model: sonnet`, `color: purple`, `memory: project`
- `description` instructs orchestrator: "Use when backend files have been modified. Scan-and-report only."
- Inputs section lists: `BACKEND_FILES_LIST`, `PIPELINE_CONTEXT`
- Placeholders documented: `{{BACKEND_STACK}}`, `{{MEMORY_PATH}}`
- Section headings: `## N+1 Queries`, `## Connection Pool Safety`, `## Pagination Safety`, `## Missing Indexes`, `## Output Format`, `## Rules`, `## Persistent Agent Memory`
- No `{{PLACEHOLDER}}` tokens other than `{{BACKEND_STACK}}` and `{{MEMORY_PATH}}`

**Dependencies:** none (can run in parallel with T1)

---

## T6 — Implement N+1 Queries and Connection Pool checks in `backend-reviewer.md` [templates]

**Description:**
Fill in the `## N+1 Queries` and `## Connection Pool Safety` sections with the patterns and severity tables from `design.md`.

**Files:**
- Modify: `templates/agents/backend-reviewer.md`

**Acceptance criteria:**
- N+1 section contains a table: Pattern | Languages | Severity
- All five N+1 patterns from `design.md` are present (ORM inside loop, await inside async loop, sequential SELECTs, missing select_related Django, missing includes Rails)
- Connection Pool section covers all three patterns: connections not released in error paths, connections passed as function arguments, pool size not configured
- Severities match `design.md`
- Prose is second-person imperative

**Dependencies:** T5

---

## T7 — Implement Pagination Safety and Missing Indexes checks in `backend-reviewer.md` [templates]

**Description:**
Fill in the `## Pagination Safety` and `## Missing Indexes` sections from `design.md`.

**Files:**
- Modify: `templates/agents/backend-reviewer.md`

**Acceptance criteria:**
- Pagination section covers all three patterns: unbounded queries without LIMIT, missing total count, offset pagination on large tables without index
- Missing Indexes section covers all three patterns: FK constraints without index, WHERE clause columns without index, unique constraints without explicit unique index
- Each finding has a stated severity
- Missing Indexes section notes to "cross-reference migration files" for WHERE clause pattern

**Dependencies:** T6

---

## T8 — Implement output format and rules in `backend-reviewer.md` [templates]

**Description:**
Fill in `## Output Format` and `## Rules` in the backend-reviewer template. Mirror the status-line protocol from frontend-reviewer and security-reviewer for consistency.

**Files:**
- Modify: `templates/agents/backend-reviewer.md`

**Acceptance criteria:**
- Output format matches `design.md`: four finding tables followed by `BACKEND_REVIEW_STATUS:` line
- `BACKEND_REVIEW_STATUS: ISSUES_FOUND` / `BACKEND_REVIEW_STATUS: CLEAN` conditions stated
- Rules section matches frontend-reviewer rules pattern: never fix, never ask for clarification, status line must be last
- Memory section follows same conventions as other reviewer agents
- What to save in memory: "false positive patterns for this repo's backend stack", "ORM/framework-specific patterns that produce false positives"

**Dependencies:** T7

---

## T9 — Update `templates/agents/reviewer.md` with layer input section [templates]

**Description:**
Add a new section to `reviewer.md` that documents the three layer report inputs the orchestrator injects at runtime. Use a notation that is visually distinct from `/setup`-time `{{PLACEHOLDER}}` tokens to avoid confusion.

The runtime injection convention uses a delimited block at the top of the agent's "What You Receive" context (or a new "Layer Review Findings" section if that section does not exist):

```
## Layer Review Findings (injected at runtime by orchestrator)

The following specialist reports have been completed before you launched.
A value of "SKIPPED" means no files of that layer type were in the changeset.

FRONTEND_REVIEW_REPORT:
[injected]

BACKEND_REVIEW_REPORT:
[injected]

SECURITY_REVIEW_REPORT:
[injected]
```

The bracketed `[injected]` markers are replaced by the actual report text at orchestrator launch time. This notation is explicitly NOT `{{PLACEHOLDER}}` syntax to avoid `/setup` mishandling.

**Files:**
- Modify: `templates/agents/reviewer.md`

**Acceptance criteria:**
- New `## Layer Review Findings` section added to `reviewer.md`
- Section explains that `[injected]` is replaced by the orchestrator at runtime
- Section clearly states: "These are NOT `/setup` placeholders. They use `[injected]` notation, not `{{...}}` notation."
- Three named slots present: `FRONTEND_REVIEW_REPORT`, `BACKEND_REVIEW_REPORT`, `SECURITY_REVIEW_REPORT`
- Existing content of `reviewer.md` is preserved unchanged
- Placement: immediately after the existing `## CI/CD Pipeline Equivalence` section, before `## Review Checklist`

**Dependencies:** T4, T8 (both new agents must be designed before documenting their output slots)

---

## T10 — Update `templates/agents/reviewer.md` output format and rules [templates]

**Description:**
Add the "Layer Review Summary" table to the output format section, and add the layer-finding rule to the Rules section.

**Files:**
- Modify: `templates/agents/reviewer.md`

**Acceptance criteria:**
- Output format section now includes `### Layer Review Summary` table after `### Issues Fixed`:
  - Columns: Layer | Status | Finding Count | Notable Issues
  - Rows: Frontend, Backend, Security
  - Status values documented: CLEAN, ISSUES_FOUND, SKIPPED (and for Security: CLEAN, WARNINGS, BLOCKED, SKIPPED)
- Rules section gains one new rule: "If a layer reviewer reports High severity findings, include them in your Issues Fixed or Issues Found section. Attempt to fix High-severity layer findings that are straightforward. Flag Critical or architecturally complex findings for human review — do NOT attempt to fix them automatically."
- All other rules in the existing Rules section are preserved

**Dependencies:** T9

---

## T11 — Update `templates/commands/implement.md` Phase 4b: layer classification [templates]

**Description:**
Rewrite Phase 4b in `templates/commands/implement.md` to add Step 1 (layer classification) before the reviewer launch. Classification logic must exactly match the normative rules in `delta-spec.md`.

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 4b now begins with `### Step 1: Layer Classification` before any agent launch
- Frontend classification rules enumerated exactly as in `delta-spec.md` section 4
- Backend classification rules enumerated exactly as in `delta-spec.md` section 4
- Overlap rule stated: a file can appear in both lists
- Empty list behavior stated: "if `FRONTEND_FILES` is empty, set `FRONTEND_REVIEW_REPORT = "SKIPPED"` and skip frontend-reviewer launch"
- Same empty list rule for backend

**Dependencies:** T10

---

## T12 — Update `templates/commands/implement.md` Phase 4b: parallel layer launch [templates]

**Description:**
Add Step 2 to Phase 4b: parallel launch of all applicable layer reviewers (including security-reviewer, which moves here from Phase 4b-sec). Document the status line parsing for each reviewer.

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- Step 2 explicitly states: "Launch all applicable layer reviewers in parallel (`run_in_background: true`)"
- frontend-reviewer launch: passes `FRONTEND_FILES_LIST` and `PIPELINE_CONTEXT`
- backend-reviewer launch: passes `BACKEND_FILES_LIST` and `PIPELINE_CONTEXT`
- security-reviewer launch: passes `MODIFIED_FILES_LIST`, `PIPELINE_CONTEXT`, exemptions path (unchanged from current Phase 4b-sec spec)
- "Wait for all layer reviewers to complete before proceeding to Step 3" stated
- Status line parsing specified for each:
  - `FRONTEND_REVIEW_STATUS: ISSUES_FOUND` or `CLEAN` → set `FRONTEND_STATUS`
  - `BACKEND_REVIEW_STATUS: ISSUES_FOUND` or `CLEAN` → set `BACKEND_STATUS`
  - `SECURITY_STATUS: BLOCKED | WARNINGS | CLEAN` → set `SECURITY_BLOCKED` (true if BLOCKED)
- Phase 4b-sec heading is removed (or explicitly marked as "Removed — see Phase 4b Step 2")

**Dependencies:** T11

---

## T13 — Update `templates/commands/implement.md` Phase 4b: generalist reviewer launch [templates]

**Description:**
Add Step 3 to Phase 4b: launch the generalist reviewer with layer reports injected. Document how each layer report is passed in the prompt construction.

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- Step 3 states: "Construct the generalist reviewer's invocation prompt with layer reports injected"
- Prompt construction shows how `FRONTEND_REVIEW_REPORT`, `BACKEND_REVIEW_REPORT`, and `SECURITY_REVIEW_REPORT` are set (full report text or "SKIPPED")
- Reviewer launch is foreground (no `run_in_background`)
- `SECURITY_BLOCKED` gate logic: moved from Phase 4b-sec to Phase 4c. A comment or note in Phase 4b Step 3 states: "The security gate (blocking ship on SECURITY_STATUS: BLOCKED) is enforced in Phase 4c."
- Note about prompt length: "If total layer report length exceeds reasonable prompt size, truncate each layer report to its findings tables only (omit skipped-file logs)"

**Dependencies:** T12

---

## T14 — Update `templates/commands/implement.md` Phase 4e report table [templates]

**Description:**
Update the Phase 4e report table to include the two new layer review columns (Frontend and Backend). Update column documentation.

**Files:**
- Modify: `templates/commands/implement.md`

**Acceptance criteria:**
- Phase 4e table header updated to: `| ... | Reviewer | Frontend | Backend | Security | CI | Status |`
- Column value legend updated: Frontend and Backend columns show `CLEAN`, `ISSUES`, or `SKIPPED`
- No other changes to Phase 4e

**Dependencies:** T13

---

## T15 — Sync `.claude/commands/implement.md` with template changes [core]

**Description:**
The specrails repo maintains its own resolved copy of `implement.md` at `.claude/commands/implement.md`. Apply the same Phase 4b, Phase 4b-sec, and Phase 4e changes made to the template in T11–T14 to the resolved copy. This is the version specrails uses to develop itself.

**Files:**
- Modify: `.claude/commands/implement.md`

**Acceptance criteria:**
- `.claude/commands/implement.md` contains the same Phase 4b restructuring as `templates/commands/implement.md`
- Phase 4b-sec is removed
- Phase 4e table includes Frontend and Backend columns
- No `/setup` placeholder tokens remain unresolved (this file is already resolved)
- Diff between resolved and template is only the expected placeholder substitutions (no structural divergence)

**Dependencies:** T14

---

## T16 — Manual verification: frontend-reviewer in specrails repo [templates]

**Description:**
Verify the frontend-reviewer agent template works by running it manually against a sample set of frontend files. Since specrails itself has minimal frontend code, create a small test fixture with intentional issues and scan it.

**Verification steps:**
1. Create `test-fixtures/frontend-sample/Button.jsx` with: a missing `alt` attribute on an `<img>`, a `<div onClick={...}>` without `role`, and a `moment` import
2. Launch the `frontend-reviewer` agent (via Claude Code) with `FRONTEND_FILES_LIST` pointing to the fixture file
3. Verify the report includes: one High accessibility finding (missing alt), one High accessibility finding (non-semantic interactive), one Medium bundle size finding (moment import)
4. Verify the last line of output is `FRONTEND_REVIEW_STATUS: ISSUES_FOUND`
5. Delete test fixtures

**Files:**
- Create (temporary): `test-fixtures/frontend-sample/Button.jsx`

**Acceptance criteria:**
- All three findings detected (2 High accessibility, 1 Medium bundle)
- `FRONTEND_REVIEW_STATUS: ISSUES_FOUND` is the last line
- No `{{PLACEHOLDER}}` tokens appear in agent output (stack description is filled in)
- Agent does not attempt to fix the code

**Dependencies:** T4

---

## T17 — Manual verification: backend-reviewer in specrails repo [templates]

**Description:**
Verify the backend-reviewer agent template works by running it against a test fixture with intentional N+1 and pagination issues.

**Verification steps:**
1. Create `test-fixtures/backend-sample/users.js` with: a `for` loop containing `await db.query('SELECT ...')`, and a `findAll()` call without `LIMIT`
2. Launch the `backend-reviewer` agent with `BACKEND_FILES_LIST` pointing to the fixture
3. Verify report includes: one High N+1 finding, one High pagination finding
4. Verify last line is `BACKEND_REVIEW_STATUS: ISSUES_FOUND`
5. Delete test fixtures

**Files:**
- Create (temporary): `test-fixtures/backend-sample/users.js`

**Acceptance criteria:**
- Both findings detected
- `BACKEND_REVIEW_STATUS: ISSUES_FOUND` is the last line
- Agent does not fix the code

**Dependencies:** T8

---

## T18 — Manual verification: full Phase 4b pipeline integration [core]

**Description:**
Verify the updated `/implement` pipeline correctly dispatches layer reviewers in parallel and injects their reports into the generalist reviewer.

**Verification steps:**
1. Run `/implement` with a dry-run on a test feature that touches both a `.jsx` file and a `.js` file in an `api/` path
2. Confirm Phase 4b Step 1 log shows both `FRONTEND_FILES` and `BACKEND_FILES` non-empty
3. Confirm Phase 4b Step 2 shows three agents launched in parallel
4. Confirm Phase 4b Step 3 shows generalist reviewer launched with layer reports in its prompt
5. Confirm Phase 4e report table includes Frontend and Backend columns with correct values

**Files:** none (verification only)

**Acceptance criteria:**
- All three layer reviewers appear in pipeline output as parallel launches
- Generalist reviewer prompt contains layer report content (visible in agent output)
- Phase 4e table has 5 review columns (Reviewer, Frontend, Backend, Security, CI)
- `SECURITY_BLOCKED` gate still works: a BLOCKED security finding prevents Phase 4c

**Dependencies:** T15, T16, T17
