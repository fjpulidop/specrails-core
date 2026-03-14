---
change: in-context-help
type: tasks
---

# Tasks: AI-Powered In-Context Help System

Tasks are ordered by dependency. Each task has a layer tag, description, files involved, and acceptance criteria.

---

## Task 1 — Create the `/why` command template [templates]

**Description:** Create a new command template at `templates/commands/why.md`. This is the developer-facing search interface for explanation records. It requires no `{{PLACEHOLDER}}` substitution — it is a static command template. The command must handle two cases: no-argument listing and keyword/tag search.

**Files:**
- Create: `templates/commands/why.md`

**Command behavior to implement:**

The command must:
1. Accept `$ARGUMENTS` as the search query (may be empty)
2. If empty: glob `.claude/agent-memory/explanations/*.md`, read each file's frontmatter and first sentence of `## Decision`, and print a table of the 20 most recent records sorted by date descending with columns: Date, Agent, Feature, Tags, Decision Summary
3. If query provided: glob all explanation records, score each against the query (filename match = 3pts, tag exact match = 3pts, body keyword match = 1pt per occurrence), return full content of top 5 results
4. If no records exist: print a helpful message explaining the feature and how records get created
5. If query matches nothing but records exist: say so and list all unique tags from existing records to guide the user

**Template structure:**

```markdown
# /why — In-Context Help

Searches explanation records written by architect, developer, and reviewer agents.
Records are stored in `.claude/agent-memory/explanations/`.

**Usage:**
- `/why` — list recent explanations
- `/why <query>` — search by keyword or tag

[... full command instructions ...]
```

**Acceptance criteria:**
- File exists at `templates/commands/why.md`
- No `{{PLACEHOLDER}}` tokens in the file (it is static)
- The command handles empty arguments (listing mode)
- The command handles keyword queries (search mode)
- The command handles the empty-directory case gracefully (no crash, helpful message)
- The command uses only Glob and Read tools — no Bash execution required

**Dependencies:** None — this task can start immediately.

---

## Task 2 — Add "Explain Your Work" section to `templates/agents/architect.md` [templates]

**Description:** Add a new "Explain Your Work" section to the architect agent template. The section must be placed after the architect's "Quality Assurance" section and before the "Update your agent memory" section. The wording should match the architect's decision-making context: design choices, approach selection, ordering decisions, spec interpretation.

**Files:**
- Modify: `templates/agents/architect.md`

**Insertion anchor:** Insert after the `## Quality Assurance` block (ending at "Re-read the original spec change one final time to catch anything missed") and before `## Update your agent memory`.

**Content to insert:**

```markdown
## Explain Your Work

When you make a significant design decision, write an explanation record to `.claude/agent-memory/explanations/`.

**Write an explanation when you:**
- Chose one approach over two or more plausible alternatives
- Applied a project convention that a new developer might not expect
- Resolved a spec ambiguity by choosing a specific default
- Rejected a seemingly natural interpretation because of a codebase constraint

**Do NOT write an explanation for:**
- Routine task ordering that follows obvious dependency rules
- Decisions already documented verbatim in `CLAUDE.md` or `.claude/rules/` (unless you are adding context about *why* the rule exists)
- Minor choices with no meaningful tradeoff

**How to write an explanation record:**

Create a file at:
  `.claude/agent-memory/explanations/YYYY-MM-DD-architect-<slug>.md`

Use today's date. Use a kebab-case slug describing the decision topic (max 6 words).

Frontmatter (required):
```yaml
---
agent: architect
feature: <change-name or "general">
tags: [keyword1, keyword2, keyword3]
date: YYYY-MM-DD
---
```

Body (required: `## Decision`; optional: `## Why This Approach`, `## Alternatives Considered`, `## See Also`):
```markdown
## Decision

One sentence stating what was decided.

## Why This Approach

2–4 sentences of reasoning. Reference specs, CLAUDE.md sections, or existing patterns.

## Alternatives Considered

- **Alternative A**: why rejected
```

Aim for 2–5 explanation records per significant feature design. Prioritize quality — a missing explanation is better than a noisy one.
```

**Acceptance criteria:**
- Section is present in `templates/agents/architect.md`
- Section is positioned after `## Quality Assurance` and before `## Update your agent memory`
- Frontmatter schema matches EXP-2 from delta-spec
- File passes `grep -c '{{' templates/agents/architect.md` — no new unresolved placeholders introduced

**Dependencies:** None — this task can start immediately.

---

## Task 3 — Add "Explain Your Work" section to `templates/agents/developer.md` [templates]

**Description:** Add a new "Explain Your Work" section to the developer agent template. The wording should match the developer's context: implementation choices, convention application, ambiguity resolution, pattern selection.

**Files:**
- Modify: `templates/agents/developer.md`

**Insertion anchor:** Insert after `## Output Standards` (or the last workflow phase section) and before `## Update Your Agent Memory`.

**Content to insert (developer-specific wording):**

Same structural pattern as Task 2, with these changes:
- Agent label in frontmatter: `architect` → `developer`
- Filename slug prefix: `architect` → `developer`
- "Write an explanation when you" bullet points adapted for developer decisions:
  - Chose an implementation approach over a plausible alternative
  - Applied a project convention (shell flags, naming, error handling) that a new developer might not recognize
  - Resolved an ambiguous spec interpretation with a concrete implementation choice
  - Used a specific pattern (e.g., section-aware merge, POSIX compatibility shim) that has non-obvious motivation
- Example slug: `2026-03-14-developer-why-set-euo-pipefail.md`

**Acceptance criteria:**
- Section is present in `templates/agents/developer.md`
- Section is positioned after the core workflow sections and before `## Update Your Agent Memory`
- Agent frontmatter value is `developer` (not `architect`)
- No new `{{PLACEHOLDER}}` tokens introduced

**Dependencies:** Task 2 (establishes the section pattern to follow).

---

## Task 4 — Add "Explain Your Work" section to `templates/agents/reviewer.md` [templates]

**Description:** Add a new "Explain Your Work" section to the reviewer agent template. The wording should match the reviewer's context: quality judgments, rule application, CI failure fixes, pattern rejections.

**Files:**
- Modify: `templates/agents/reviewer.md`

**Insertion anchor:** Insert after `## Rules` and before `## Critical Warnings`.

**Content to insert (reviewer-specific wording):**

Same structural pattern as Task 2, with these changes:
- Agent label in frontmatter: `reviewer`
- Filename slug prefix: `reviewer`
- "Write an explanation when you" bullet points adapted for reviewer decisions:
  - Applied a lint rule or CI check fix that has non-obvious reasoning
  - Rejected a code pattern and replaced it with the correct alternative
  - Made a judgment call not covered by the CI checklist
  - Fixed an issue whose root cause a new developer would likely repeat
- Example slug: `2026-03-15-reviewer-why-conventional-commits.md`

**Acceptance criteria:**
- Section is present in `templates/agents/reviewer.md`
- Section is positioned after `## Rules` and before `## Critical Warnings`
- Agent frontmatter value is `reviewer`
- No new `{{PLACEHOLDER}}` tokens introduced

**Dependencies:** Task 2 (establishes the section pattern to follow).

---

## Task 5 — Add `explanations/` directory creation to `install.sh` [core]

**Description:** Add a `mkdir -p` call to `install.sh` to create `.claude/agent-memory/explanations/` in target repositories during setup. This must be placed adjacent to the existing per-agent memory directory creation calls.

**Files:**
- Modify: `install.sh`

**What to find:** Locate the block in `install.sh` that creates agent memory directories (search for `agent-memory`). It will contain lines like:
```bash
mkdir -p "${TARGET}/.claude/agent-memory/architect"
mkdir -p "${TARGET}/.claude/agent-memory/developer"
```

**What to add:** Immediately after the last per-agent `mkdir -p` call in that block:
```bash
mkdir -p "${TARGET}/.claude/agent-memory/explanations"
```

**Acceptance criteria:**
- `install.sh` contains the `mkdir -p "${TARGET}/.claude/agent-memory/explanations"` line
- The line is within the same block as other `agent-memory` directory creation calls
- `shellcheck install.sh` passes with no new warnings
- Running `install.sh` on a fresh target creates the `explanations/` directory

**Dependencies:** None — this task can start immediately.

---

## Task 6 — Verify placeholder integrity across modified templates [core]

**Description:** After Tasks 2, 3, and 4 modify agent templates, verify that no new unresolved `{{PLACEHOLDER}}` tokens were accidentally introduced. Also verify the section ordering in each modified file matches the design spec.

**Files:** (read-only verification)
- `templates/agents/architect.md`
- `templates/agents/developer.md`
- `templates/agents/reviewer.md`
- `templates/commands/why.md`

**Verification steps:**
1. Run: `grep -n '{{[A-Z_]*}}' templates/agents/architect.md templates/agents/developer.md templates/agents/reviewer.md templates/commands/why.md`
   - Expected: only pre-existing placeholders appear (e.g., `{{MEMORY_PATH}}`, `{{LAYER_TAGS}}`) — no new ones
2. Confirm section order in each agent template:
   - architect: `## Quality Assurance` → `## Explain Your Work` → `## Update your agent memory`
   - developer: core workflow → `## Explain Your Work` → `## Update Your Agent Memory`
   - reviewer: `## Rules` → `## Explain Your Work` → `## Critical Warnings`
3. Confirm `templates/commands/why.md` has zero `{{...}}` tokens

**Acceptance criteria:**
- No new placeholder tokens found by grep
- Section ordering confirmed correct in all three agent templates
- `why.md` confirmed to be static (zero placeholders)

**Dependencies:** Tasks 1, 2, 3, 4 must all be complete.
