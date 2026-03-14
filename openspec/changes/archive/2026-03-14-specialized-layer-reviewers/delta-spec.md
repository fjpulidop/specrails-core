---
change: specialized-layer-reviewers
type: delta-spec
---

# Delta Spec: Specialized Layer Reviewers

This document describes what changes in the system's specification as a result of this feature. It is the authoritative record of spec drift — every item here reflects a new behavioral contract that future changes must respect.

---

## 1. New Agents

### `templates/agents/frontend-reviewer.md` (new)

**Behavioral contract:**

- Identity: scan-and-report only. Never fixes code, never asks for clarification.
- Inputs: `FRONTEND_FILES_LIST`, `PIPELINE_CONTEXT`, resolves `{{FRONTEND_STACK}}` and `{{MEMORY_PATH}}` at `/setup` time.
- Checks performed: bundle size signals, accessibility (WCAG 2.1 AA subset), render performance patterns.
- Output: structured findings report ending with `FRONTEND_REVIEW_STATUS: ISSUES_FOUND` or `FRONTEND_REVIEW_STATUS: CLEAN` as the very last line.
- Status line protocol: identical to `security-reviewer`'s `SECURITY_STATUS:` protocol (last line, no trailing content).
- Memory: persistent agent memory at `{{MEMORY_PATH}}`, same conventions as other agents.

### `templates/agents/backend-reviewer.md` (new)

**Behavioral contract:**

- Identity: scan-and-report only. Never fixes code, never asks for clarification.
- Inputs: `BACKEND_FILES_LIST`, `PIPELINE_CONTEXT`, resolves `{{BACKEND_STACK}}` and `{{MEMORY_PATH}}` at `/setup` time.
- Checks performed: N+1 query patterns, connection pool safety, pagination safety, missing indexes.
- Output: structured findings report ending with `BACKEND_REVIEW_STATUS: ISSUES_FOUND` or `BACKEND_REVIEW_STATUS: CLEAN` as the very last line.
- Status line protocol: same as `security-reviewer`.
- Memory: persistent agent memory at `{{MEMORY_PATH}}`.

---

## 2. Modified Agents

### `templates/agents/reviewer.md` (modified)

**Additions:**

- Receives three new inputs at runtime (injected by orchestrator): `FRONTEND_REVIEW_REPORT`, `BACKEND_REVIEW_REPORT`, `SECURITY_REVIEW_REPORT`. Any may be the string `"SKIPPED"`.
- New "Layer Review Summary" table in the output format (required field in every review report).
- New rule: High-severity layer findings may be attempted as fixes; Critical/complex findings are flagged only.

**No removals.** All existing behavior (CI checks, fix-and-retry loop, existing output format) is preserved.

---

## 3. Modified Pipeline (`templates/commands/implement.md` and `.claude/commands/implement.md`)

### Phase 4b — Layer Dispatch (new structure)

**Before:**
- Phase 4b: Launch single generalist reviewer (foreground).
- Phase 4b-sec: Launch security-reviewer (sequential, after generalist reviewer).

**After:**
- Phase 4b, Step 1: Orchestrator classifies `MODIFIED_FILES_LIST` into `FRONTEND_FILES` and `BACKEND_FILES` using heuristic rules.
- Phase 4b, Step 2: Launch layer reviewers in parallel (`run_in_background: true`):
  - `frontend-reviewer` (if `FRONTEND_FILES` non-empty)
  - `backend-reviewer` (if `BACKEND_FILES` non-empty)
  - `security-reviewer` (always)
  Wait for all to complete. Parse status lines.
- Phase 4b, Step 3: Launch generalist reviewer (foreground) with layer reports injected.
- Phase 4b-sec: **Removed.** Security reviewer now runs in Phase 4b Step 2.

**`SECURITY_BLOCKED` gate logic:** Moves from Phase 4b-sec to Phase 4c (unchanged behavior — still blocks git/PR operations if `SECURITY_STATUS: BLOCKED`).

### Phase 4e Report Table

**Before:** `| ... | Reviewer | Security | CI | Status |`

**After:** `| ... | Reviewer | Frontend | Backend | Security | CI | Status |`

New column values:
- `CLEAN` — layer reviewer ran and found no issues
- `ISSUES` — layer reviewer found issues (details in reviewer report)
- `SKIPPED` — no files of this type were in the changeset

---

## 4. File Classification Spec (new, part of pipeline spec)

Layer classification rules are now a defined part of the `/implement` pipeline spec. The following is normative:

### Frontend classification

A file is frontend if:
- Extension is one of: `.jsx`, `.tsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.sass`, `.less`, `.html`, `.htm`
- OR extension is `.js` or `.ts` AND path contains one of: `components/`, `pages/`, `views/`, `ui/`, `client/`, `frontend/`, `app/`
- OR path starts with: `public/`, `static/`, `assets/`

### Backend classification

A file is backend if:
- Extension is one of: `.py`, `.go`, `.java`, `.rb`, `.php`, `.rs`, `.cs`, `.sql`
- OR extension is `.js` or `.ts` AND path contains one of: `server/`, `api/`, `routes/`, `controllers/`, `services/`, `models/`, `db/`, `backend/`
- OR path is under: `migrations/`, `alembic/`, `db/migrate/`

### Overlap

A file matching both frontend and backend rules appears in both lists. Both reviewers scan it.

---

## 5. New `/setup` Placeholders

Two new placeholders are introduced for layer reviewer templates:

| Placeholder | Used in | Resolved by |
|-------------|---------|-------------|
| `{{FRONTEND_STACK}}` | `frontend-reviewer.md` | `/setup` codebase analysis |
| `{{BACKEND_STACK}}` | `backend-reviewer.md` | `/setup` codebase analysis |

The `/setup` command must detect these stacks during its codebase analysis phase. Detection approach:
- `FRONTEND_STACK`: check `package.json` dependencies for React, Vue, Angular, Svelte, Next.js, Nuxt; note version.
- `BACKEND_STACK`: check for `requirements.txt` (Python), `go.mod` (Go), `pom.xml`/`build.gradle` (Java), `Gemfile` (Ruby), `Cargo.toml` (Rust); check for DB config files indicating PostgreSQL, MySQL, SQLite, MongoDB.

If detection is ambiguous, `/setup` defaults to a generic description: `"detected from codebase"`.

---

## 6. Backward Compatibility

- Target repos with no frontend files: frontend-reviewer is never launched. Pipeline behavior is identical to pre-change.
- Target repos with no backend files: backend-reviewer is never launched. Pipeline behavior is identical to pre-change.
- Target repos with neither: only the generalist reviewer and security-reviewer run. Net change: security-reviewer now runs in parallel with the generalist reviewer's setup step rather than sequentially after it (minor latency improvement only).
- All existing `/setup` placeholder names are unchanged. The two new placeholders are additive.
