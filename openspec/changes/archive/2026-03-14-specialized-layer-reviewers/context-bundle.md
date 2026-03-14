---
change: specialized-layer-reviewers
type: context-bundle
---

# Context Bundle: Specialized Layer Reviewers

Everything a developer needs to implement this change without asking questions. Read this entire document before starting any task.

---

## What You Are Building

Three new or modified agent templates that introduce specialized code review for frontend and backend layers. The generalist reviewer (`reviewer.md`) gains the ability to receive and synthesize specialist reports. The `/implement` pipeline is updated to launch layer reviewers in parallel before the generalist reviewer makes its pass/fail decision.

This is a pure Markdown template change. No new build tooling, no scripts, no configuration files. The implementation medium is: write Markdown, following existing agent template conventions.

---

## Current State (Before This Change)

### `/implement` Phase 4b (current)

```
Phase 4b: Launch single generalist reviewer (foreground)
Phase 4b-sec: Launch security-reviewer (sequential, after generalist reviewer)
```

The security-reviewer runs AFTER the generalist reviewer has already fixed issues and produced its report. This means the security scan happens on already-reviewed code, which is good, but it adds sequential latency and is architecturally disconnected from the review process.

### Reviewer agent (current)

`templates/agents/reviewer.md` is self-contained. It runs CI checks, fixes issues, and produces a report with three sections: CI Checks, Issues Fixed, Files Modified. It has no concept of other reviewers or specialist inputs.

### Security reviewer (current)

`templates/agents/security-reviewer.md` is mature and fully specified. Its output protocol (`SECURITY_STATUS:` terminal line) is the model for the new layer reviewers. Study it carefully — the frontend and backend reviewers must follow the same conventions.

---

## Files to Read Before Starting

These are the files you must read and understand before writing any code:

1. `/Users/javi/repos/specrails/templates/agents/security-reviewer.md` — the canonical scan-and-report agent pattern. Frontend and backend reviewers mirror its structure exactly.

2. `/Users/javi/repos/specrails/templates/agents/reviewer.md` — the generalist reviewer you will modify. Understand the existing output format before adding to it.

3. `/Users/javi/repos/specrails/templates/agents/frontend-developer.md` — shows what `{{FRONTEND_STACK}}`, `{{FRONTEND_TECH_LIST}}`, and `{{FRONTEND_EXPERTISE}}` look like in a frontend agent context. Informs naming conventions.

4. `/Users/javi/repos/specrails/templates/agents/backend-developer.md` — same, for backend context.

5. `/Users/javi/repos/specrails/.claude/commands/implement.md` — the current, fully-resolved implement pipeline. You will modify both this file AND the template version.

6. `/Users/javi/repos/specrails/templates/commands/implement.md` — the template version with `{{PLACEHOLDER}}` tokens. Modify this in parallel with the resolved version.

7. `openspec/changes/specialized-layer-reviewers/design.md` — the authoritative check specifications. Do not invent checks or patterns beyond what is documented there.

8. `openspec/changes/specialized-layer-reviewers/delta-spec.md` — the normative classification rules and behavioral contracts. The file classification logic in T11 must match section 4 exactly.

---

## Agent Template Conventions

All agent templates in `templates/agents/` follow this structure. Deviate only if the design explicitly requires it.

### Frontmatter

```yaml
---
name: agent-name-in-kebab-case
description: "Use this agent when... (orchestrator instruction). Examples: ..."
model: sonnet
color: <color>
memory: project
---
```

The `description` field is what Claude reads when deciding whether to launch this agent. It must start with "Use this agent when..." and include 1-2 examples in the format shown in `security-reviewer.md`.

### Color convention (from existing agents)

- `red` — reviewer (generalist)
- `orange` — security-reviewer
- `blue` — frontend agents
- `purple` — backend agents
- `green` — (unused, available)

New assignments:
- `frontend-reviewer` → `blue` (consistent with `frontend-developer`)
- `backend-reviewer` → `purple` (consistent with `backend-developer`)

### Memory section

Every agent ends with a Persistent Agent Memory section. Copy this section from `security-reviewer.md` and adapt the "What to save" bullet points for the new agent's domain.

### Placeholder naming

`{{UPPER_SNAKE_CASE}}` for all `/setup`-time placeholders. The two new placeholders are:
- `{{FRONTEND_STACK}}` — e.g., `React 18 + TypeScript + Vite`
- `{{BACKEND_STACK}}` — e.g., `Node.js 20 + Express + PostgreSQL 15`

Runtime injections (values passed by the orchestrator at agent launch, not resolved by `/setup`) use `[injected]` notation, NOT `{{...}}` notation. This is critical — see T9.

---

## The Status Line Protocol

This is the most important convention for the new agents. Study how `security-reviewer.md` implements it, then mirror it exactly:

1. The status line is the **very last line** of the agent's output.
2. It is formatted as: `KEY: VALUE` with no trailing whitespace or newlines.
3. The orchestrator parses it by reading the final line of the agent's output.
4. Nothing may follow the status line.

For the new agents:
- `FRONTEND_REVIEW_STATUS: ISSUES_FOUND` or `FRONTEND_REVIEW_STATUS: CLEAN`
- `BACKEND_REVIEW_STATUS: ISSUES_FOUND` or `BACKEND_REVIEW_STATUS: CLEAN`

The `security-reviewer.md` Rules section has: "The `SECURITY_STATUS:` line MUST be the very last line of your output. Nothing may follow it." Use the exact same wording, adapted for the new status key name.

---

## Phase 4b Restructuring: Exact Changes

### Before (current `implement.md` Phase 4b and 4b-sec)

```
### 4b. Launch Reviewer agent

Launch a single reviewer agent to validate ALL merged changes. Include:
- Full CI commands
- Cross-feature merge issue checks
- Record learnings to common-fixes.md
- Archive completed changes via OpenSpec

[... dry-run instructions ...]

### 4b-sec. Launch Security Reviewer agent

After the reviewer agent completes, launch a security-reviewer agent...

[... SECURITY_STATUS parsing, SECURITY_BLOCKED variable ...]
```

### After (new Phase 4b structure)

```
### 4b. Layer Dispatch and Review

#### Step 1: Layer Classification

[enumerate FRONTEND_FILES and BACKEND_FILES using classification rules from delta-spec.md section 4]

#### Step 2: Launch Layer Reviewers in Parallel

[launch frontend-reviewer (if applicable), backend-reviewer (if applicable), security-reviewer]
[wait for all to complete]
[parse status lines: FRONTEND_STATUS, BACKEND_STATUS, SECURITY_BLOCKED]

#### Step 3: Launch Generalist Reviewer

[construct prompt with layer reports injected]
[launch reviewer (foreground)]

[Note: Phase 4b-sec is removed. Security gate enforced in Phase 4c.]
```

The security gate logic (`if SECURITY_BLOCKED=true: stop, print findings, skip to Phase 4e`) stays in Phase 4c exactly where it is. Do not move it; just remove the reference to Phase 4b-sec as its source.

---

## What NOT to Change

- Do not touch `install.sh`. New agent templates are picked up automatically via `cp -r "$SCRIPT_DIR/templates/"*` in the installer.
- Do not modify the `/setup` command. Stack detection is already built into `/setup`'s codebase analysis. The new placeholders (`{{FRONTEND_STACK}}`, `{{BACKEND_STACK}}`) are resolved by the same mechanism that resolves `{{FRONTEND_STACK}}` in `frontend-developer.md`, which already exists.
- Do not modify `security-reviewer.md`. Its output contract is unchanged. It moves position in the pipeline (from Phase 4b-sec to Phase 4b Step 2) but its template content does not change.
- Do not add a `delta-spec.md` field for the `/setup` command changes. Stack detection is an implementation detail of `/setup`, not a new spec.

---

## Exact Changes Summary (for conflict detection)

| File | Operation | Regions modified |
|------|-----------|-----------------|
| `templates/agents/frontend-reviewer.md` | Create | entire file |
| `templates/agents/backend-reviewer.md` | Create | entire file |
| `templates/agents/reviewer.md` | Modify | after `## CI/CD Pipeline Equivalence` section (insert Layer Review Findings); inside `## Output Format` (insert Layer Review Summary table); inside `## Rules` (insert one rule) |
| `templates/commands/implement.md` | Modify | `### 4b.` section (rewrite); `### 4b-sec.` section (remove); Phase 4e report table (add 2 columns) |
| `.claude/commands/implement.md` | Modify | same regions as template |

---

## Verification Approach

The design calls for test fixtures (T16, T17). Here is the convention:

- Create fixtures under `test-fixtures/<feature-name>/`
- These are temporary — delete them after verification
- Do not commit test fixtures
- The fixture files should be minimal: 20-40 lines, containing exactly the patterns you need to verify

For T16 (`Button.jsx`), the file needs:
```jsx
// missing alt on img
<img src="icon.png" />

// non-semantic interactive (no role)
<div onClick={handleClick}>Click me</div>

// heavy import
import moment from 'moment';
```

For T17 (`users.js`), the file needs:
```js
// N+1: query inside async loop
for (const id of userIds) {
  const user = await db.query('SELECT * FROM users WHERE id = $1', [id]);
}

// Unbounded query
const allUsers = await User.findAll();
```

---

## Open Questions (Resolved)

**Q: Should layer reviewers be able to block the pipeline?**
A: No. Only the generalist reviewer and the security-reviewer's SECURITY_STATUS: BLOCKED gate can stop the pipeline. Layer findings are advisory inputs to the generalist reviewer, which makes the final call.

**Q: What if both frontend and backend reviewers find the same file has issues?**
A: Both report independently. The generalist reviewer sees both reports and synthesizes. There is no deduplication requirement — the generalist applies judgment.

**Q: How does the orchestrator handle a layer reviewer that crashes or times out?**
A: Set the relevant report to `"ERROR: reviewer did not complete"` and continue. The generalist reviewer is launched with that placeholder in place of the report. The generalist notes the failure in its Layer Review Summary (status: ERROR).

**Q: Should `{{FRONTEND_STACK}}` and `{{BACKEND_STACK}}` be required or optional in `/setup`?**
A: Optional with a safe default. If `/setup` cannot detect the stack, it uses `"detected from codebase"`. This is already the convention for other stack placeholders in `frontend-developer.md` and `backend-developer.md`.
