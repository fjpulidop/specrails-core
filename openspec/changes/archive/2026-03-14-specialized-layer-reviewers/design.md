---
change: specialized-layer-reviewers
type: design
---

# Design: Specialized Layer Reviewers

## Overview

Three layer reviewers run in parallel during Phase 4b of the `/implement` pipeline, before the generalist reviewer makes its pass/fail decision. The generalist reviewer receives all layer reports as input and synthesizes them into its final output.

```
Phase 4a: Merge
     |
     v
Phase 4b: Layer Dispatch (parallel)
     ├── frontend-reviewer  (if frontend files detected)
     ├── backend-reviewer   (if backend files detected)
     └── security-reviewer  (always, already exists)
     |
     v
Phase 4b: Generalist Reviewer
     (receives all layer findings, runs CI, produces final report)
     |
     v
Phase 4c: Ship
```

---

## Layer Classification

File classification runs inside the `/implement` pipeline orchestrator at the start of Phase 4b, before any reviewer launches. The orchestrator scans `MODIFIED_FILES_LIST` and partitions it into three sets:

### Frontend Files

A file is classified as frontend if it matches any of:

- Extension: `.jsx`, `.tsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.sass`, `.less`
- Extension: `.html`, `.htm`
- Extension: `.js` or `.ts` AND path contains any of: `components/`, `pages/`, `views/`, `ui/`, `client/`, `frontend/`, `app/`
- Path starts with: `public/`, `static/`, `assets/`

### Backend Files

A file is classified as backend if it matches any of:

- Extension: `.py`, `.go`, `.java`, `.rb`, `.php`, `.rs`, `.cs`
- Extension: `.js` or `.ts` AND path contains any of: `server/`, `api/`, `routes/`, `controllers/`, `services/`, `models/`, `db/`, `backend/`
- SQL files: `.sql`
- ORM/migration files: paths under `migrations/`, `alembic/`, `db/migrate/`

### Classification Rules

- A file can be classified as both frontend AND backend (e.g., a Next.js API route at `pages/api/`).
- Files matching neither category are reviewed only by the generalist and security reviewers.
- If `FRONTEND_FILES` is empty: skip frontend-reviewer, note "No frontend files detected."
- If `BACKEND_FILES` is empty: skip backend-reviewer, note "No backend files detected."

---

## Frontend Reviewer Agent (`templates/agents/frontend-reviewer.md`)

### Identity and Role

The frontend-reviewer is a scan-and-report agent. It never fixes code. It produces a structured findings report with a single-line status code as its last line of output.

### Inputs (injected by orchestrator)

- `FRONTEND_FILES_LIST`: files classified as frontend
- `PIPELINE_CONTEXT`: brief description of what was implemented
- `FRONTEND_STACK`: detected from target repo (placeholder resolved at `/setup` time)

### Checks

**1. Bundle Size**

Look for signals of bundle size regression:
- New dynamic `import()` calls that lack chunk naming hints (`/* webpackChunkName: */`)
- Large static assets (images, fonts) added without compression or lazy loading
- New synchronous imports of heavy libraries (moment.js, lodash without tree-shaking, etc.) in components that are in the critical rendering path
- Presence of unused CSS classes (flag if a class defined in modified CSS is not referenced in modified component files)

Severity: High if a known heavy library is added synchronously; Medium for other signals.

**2. Accessibility (WCAG 2.1 AA)**

Scan all HTML, JSX, TSX, Vue, and Svelte files for:

| Rule | What to look for | Severity |
|------|-----------------|----------|
| Missing alt text | `<img>` without `alt` attribute | High |
| Missing form labels | `<input>` without associated `<label>` or `aria-label` | High |
| Non-semantic interactive elements | `<div>` or `<span>` with `onClick` but no `role` or `tabIndex` | High |
| Missing ARIA roles | Custom interactive patterns without appropriate ARIA attributes | Medium |
| Low contrast (static) | Hard-coded color pairs where contrast ratio is estimably below 4.5:1 (flag for manual review) | Medium |
| Missing landmark regions | Pages without `<main>`, `<nav>`, `<header>` or equivalent ARIA landmarks | Medium |
| Missing page title | `<title>` absent or empty in modified HTML/page-level components | Medium |

**3. Render Performance**

- Render-blocking scripts: `<script>` tags without `async` or `defer` in `<head>`
- Synchronous data fetching in component render paths (e.g., `useEffect` with empty deps that awaits unthrottled API calls)
- Missing `key` props on list renders in React/Vue templates
- Missing `memo`/`useMemo`/`computed` on expensive derived values in hot paths

### Output Format

```
## Frontend Review Results

### Bundle Size
| File | Finding | Severity |
|------|---------|----------|
(rows or "None")

### Accessibility
| File | Line | Rule | Severity |
|------|------|------|----------|
(rows or "None")

### Render Performance
| File | Finding | Severity |
|------|---------|----------|
(rows or "None")

---
FRONTEND_REVIEW_STATUS: ISSUES_FOUND | CLEAN
```

`FRONTEND_REVIEW_STATUS: ISSUES_FOUND` if any High or Medium finding exists.
`FRONTEND_REVIEW_STATUS: CLEAN` if no findings.

The status line MUST be the very last line of output.

### Placeholders

| Placeholder | Resolved at | Description |
|-------------|-------------|-------------|
| `{{FRONTEND_STACK}}` | `/setup` | Detected frontend framework (e.g., "React 18 + TypeScript") |
| `{{MEMORY_PATH}}` | `/setup` | Agent memory directory path |

---

## Backend Reviewer Agent (`templates/agents/backend-reviewer.md`)

### Identity and Role

The backend-reviewer is a scan-and-report agent. It never fixes code. It produces a structured findings report with a single-line status code as its last line of output.

### Inputs (injected by orchestrator)

- `BACKEND_FILES_LIST`: files classified as backend
- `PIPELINE_CONTEXT`: brief description of what was implemented
- `BACKEND_STACK`: detected from target repo (placeholder resolved at `/setup` time)

### Checks

**1. N+1 Query Detection**

Look for patterns where queries are issued inside loops or per-item resolution:

| Pattern | Languages | Severity |
|---------|-----------|----------|
| ORM `.find()`, `.get()`, `.filter()` calls inside `for`/`forEach`/`.map()` | Python/Django, Ruby/Rails, JS/TypeScript | High |
| `await db.query()` or `await Model.find()` inside an async loop | Node.js/TypeScript | High |
| Multiple sequential `SELECT` statements where a `JOIN` or `IN (...)` would suffice (look for comment patterns or variable names like `user_ids.forEach`) | SQL context | High |
| Missing `.select_related()` or `.prefetch_related()` on relationships accessed in a loop (Django) | Python | Medium |
| Missing `.includes()` on relationships accessed in a loop (Rails/ActiveRecord) | Ruby | Medium |

**2. Connection Pool Safety**

- Database connections acquired but not released in error paths (look for `conn = db.connect()` without corresponding `conn.close()` in a finally block)
- Connection objects passed as function arguments (increases risk of holding connections across await boundaries)
- Pool size not configured (flag if a new DB client is instantiated without pool configuration)

**3. Pagination Safety**

- Unbounded queries: `findAll()`, `.all()`, `SELECT *` without `LIMIT`/`OFFSET` or cursor in an API handler
- Missing total count for paginated responses (pagination without telling the client how many pages exist)
- Offset-based pagination on large tables without an index on the sort column

**4. Missing Indexes**

Scan migration files and raw SQL for:
- `FOREIGN KEY` constraints added without a corresponding index on the referencing column
- Columns added to a `WHERE` clause in a new query that lack an index (cross-reference migration files)
- Unique constraints added without a corresponding unique index (flag if DB migration syntax omits it)

### Output Format

```
## Backend Review Results

### N+1 Queries
| File | Line | Pattern | Severity |
|------|------|---------|----------|
(rows or "None")

### Connection Pool Safety
| File | Finding | Severity |
|------|---------|----------|
(rows or "None")

### Pagination Safety
| File | Finding | Severity |
|------|---------|----------|
(rows or "None")

### Missing Indexes
| File | Finding | Severity |
|------|---------|----------|
(rows or "None")

---
BACKEND_REVIEW_STATUS: ISSUES_FOUND | CLEAN
```

`BACKEND_REVIEW_STATUS: ISSUES_FOUND` if any High or Medium finding exists.
`BACKEND_REVIEW_STATUS: CLEAN` if no findings.

The status line MUST be the very last line of output.

### Placeholders

| Placeholder | Resolved at | Description |
|-------------|-------------|-------------|
| `{{BACKEND_STACK}}` | `/setup` | Detected backend stack (e.g., "Node.js + PostgreSQL") |
| `{{MEMORY_PATH}}` | `/setup` | Agent memory directory path |

---

## Generalist Reviewer Changes (`templates/agents/reviewer.md`)

The generalist reviewer receives layer reports as additional input. Two sections are added to the template:

### New Section: Layer Review Inputs

Inserted after the existing "What You Receive" section (if present) or at the top of the workflow:

```
## Layer Review Findings (injected by orchestrator)

The orchestrator runs specialized layer reviewers in parallel before you launch.
Their reports are injected here:

FRONTEND_REVIEW_REPORT:
{{FRONTEND_REVIEW_REPORT}}

BACKEND_REVIEW_REPORT:
{{BACKEND_REVIEW_REPORT}}

SECURITY_REVIEW_REPORT:
{{SECURITY_REVIEW_REPORT}}

A value of "SKIPPED" means no files of that type were modified.
```

These are runtime variables injected by the orchestrator at launch time, not `/setup`-time placeholders. The `{{...}}` syntax is used here as orchestrator substitution tokens, not template placeholders. The developer implementing this must document this distinction clearly in the template.

### New Section: Report Synthesis

Added to the "Output Format" section of reviewer.md, after the existing `### Issues Fixed` table:

```
### Layer Review Summary
| Layer | Status | Finding Count | Notable Issues |
|-------|--------|--------------|----------------|
| Frontend | CLEAN / ISSUES_FOUND / SKIPPED | N | ... |
| Backend  | CLEAN / ISSUES_FOUND / SKIPPED | N | ... |
| Security | CLEAN / WARNINGS / BLOCKED / SKIPPED | N | ... |

[List any High or Critical findings from layer reviews that warrant attention]
```

### Decision Influence

Add a rule to the "Rules" section:

> If a layer reviewer reports High severity findings, include them in the "Issues Fixed" or "Issues Found" section of your report. You may attempt to fix High-severity layer findings if they are straightforward (e.g., adding a missing `alt` attribute, adding a missing `LIMIT` to a query). Flag Critical or complex findings for human review — do NOT attempt to fix them automatically.

---

## Pipeline Changes (`templates/commands/implement.md`)

### Phase 4b Rewrite

The current Phase 4b launches a single reviewer agent. After this change, Phase 4b is split into two steps:

**Step 1: Layer Classification (orchestrator, no agent launch)**

```
FRONTEND_FILES = [files from MODIFIED_FILES_LIST matching frontend rules]
BACKEND_FILES  = [files from MODIFIED_FILES_LIST matching backend rules]

if FRONTEND_FILES is empty: FRONTEND_REVIEW_REPORT = "SKIPPED"
if BACKEND_FILES is empty: BACKEND_REVIEW_REPORT = "SKIPPED"
```

**Step 2: Launch Layer Reviewers in Parallel**

For each non-empty layer:
- Launch `frontend-reviewer` with `FRONTEND_FILES_LIST` and `PIPELINE_CONTEXT` (`run_in_background: true`)
- Launch `backend-reviewer` with `BACKEND_FILES_LIST` and `PIPELINE_CONTEXT` (`run_in_background: true`)
- The security-reviewer (currently in Phase 4b-sec) is moved to run in parallel with the other layer reviewers in this step

Wait for all layer reviewers to complete. Parse their status lines.

**Step 3: Launch Generalist Reviewer**

Construct the generalist reviewer's invocation prompt with layer reports injected:
- `FRONTEND_REVIEW_REPORT`: full output of frontend-reviewer (or "SKIPPED")
- `BACKEND_REVIEW_REPORT`: full output of backend-reviewer (or "SKIPPED")
- `SECURITY_REVIEW_REPORT`: full output of security-reviewer

Launch the generalist reviewer (foreground, waits for completion).

**Phase 4b-sec is removed.** The security-reviewer is now launched in parallel at Step 2 above. The `SECURITY_BLOCKED` gate logic moves from Phase 4b-sec into Phase 4c (after the generalist reviewer completes), where it already belongs logically.

### Pipeline Report Table Update

The Phase 4e report table currently has a "Security" column. It gains two new columns:

```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Frontend | Backend | Security | CI | Status |
```

---

## Template Placeholder Reference

### `frontend-reviewer.md` placeholders

| Placeholder | Source | Example value |
|-------------|--------|---------------|
| `{{FRONTEND_STACK}}` | `/setup` codebase analysis | `React 18 + TypeScript + Vite` |
| `{{MEMORY_PATH}}` | `/setup` standard | `.claude/agent-memory/frontend-reviewer` |

### `backend-reviewer.md` placeholders

| Placeholder | Source | Example value |
|-------------|--------|---------------|
| `{{BACKEND_STACK}}` | `/setup` codebase analysis | `Node.js 20 + PostgreSQL 15` |
| `{{MEMORY_PATH}}` | `/setup` standard | `.claude/agent-memory/backend-reviewer` |

### `reviewer.md` runtime injections (NOT `/setup` placeholders)

These tokens appear in reviewer.md but are substituted by the orchestrator at runtime, not by `/setup`. They must use a distinct notation to avoid confusion with template placeholders. The convention is to use all-caps variable names surrounded by `--- BEGIN/END ---` blocks rather than `{{...}}` syntax. See T3 for the exact notation decision.

---

## Design Decisions and Rationale

**Decision 1: Layer reviewers are scan-only, generalist reviewer fixes.**

Keeping fixing in one place (the generalist reviewer) ensures there is a single pass of CI verification after any modifications. If each layer reviewer could fix code independently, we would need to re-run CI after each one, and the order of fixes could create conflicts.

**Decision 2: Layer reviewers run in parallel with each other and with the security-reviewer.**

All three layer reviewers are stateless readers — they scan files and produce reports. No write ordering is required. Parallelism reduces total pipeline time by the time of the slowest layer reviewer (typically security, which scans the full modified file set).

**Decision 3: Security-reviewer moves from Phase 4b-sec to Phase 4b parallel step.**

The sequential positioning of the security-reviewer (run after the generalist reviewer) was an implementation detail of early pipeline versions, not a logical requirement. Moving it to run in parallel with the other layer reviewers reduces pipeline latency and simplifies Phase 4b-sec into a no-op that can be removed.

**Decision 4: Layer classification is heuristic, not configuration-driven.**

Configuration-driven classification (e.g., a `specrails.yaml` that maps directories to layers) adds friction for target repos. Heuristic classification based on file extensions and directory names covers 90%+ of real-world project structures without setup. Edge cases produce at most an unnecessary layer reviewer run (cost: a few seconds), not incorrect classification.

**Decision 5: `{{FRONTEND_STACK}}` and `{{BACKEND_STACK}}` are the only new `/setup` placeholders.**

The stack descriptions are the only per-repo facts needed. Everything else in the layer reviewer templates is domain knowledge that does not vary by repo. This keeps the `/setup` analysis burden minimal.

---

## Risks

**False positives in layer classification:** A TypeScript file in `src/utils/` containing both frontend and backend logic will be classified as backend only (since it lacks frontend path markers). Findings from backend-reviewer about it may seem irrelevant. Mitigation: the generalist reviewer can dismiss irrelevant findings.

**Layer reviewer prompt length:** Injecting all three layer reports into the generalist reviewer's prompt increases token usage. For large changesets with many findings, this could approach context limits. Mitigation: truncate each layer report to its findings tables only (omit the skipped files log) when injecting into the generalist reviewer.

**`{{BACKEND_STACK}}` and `{{FRONTEND_STACK}}` detection accuracy:** The `/setup` command must correctly identify the stack. If it produces a generic or wrong value, the layer reviewer prompts are slightly less accurate (they name a different stack) but still function — the checks are pattern-based, not stack-dependent.
