---
change: in-context-help
type: context-bundle
---

# Context Bundle: AI-Powered In-Context Help System

This file is a self-contained developer briefing. You do not need to read any other file to implement this change — everything is here.

---

## What You Are Building

A lightweight explanation recording system for specrails. When agents (architect, developer, reviewer) make non-trivial decisions, they write Markdown explanation records to `.claude/agent-memory/explanations/`. A new `/why` command lets developers search these records by keyword or tag. No external dependencies — this is pure Markdown and LLM-native search.

---

## Files to Change

| File | Change Type | Notes |
|------|-------------|-------|
| `templates/commands/why.md` | Create | New command template — static, no placeholders |
| `templates/agents/architect.md` | Modify | Add "Explain Your Work" section (one insertion) |
| `templates/agents/developer.md` | Modify | Add "Explain Your Work" section (one insertion) |
| `templates/agents/reviewer.md` | Modify | Add "Explain Your Work" section (one insertion) |
| `install.sh` | Modify | Add one `mkdir -p` line for `explanations/` directory |

**Do NOT modify:**
- `.claude/agents/*.md` — these are generated copies; edit templates only
- `.claude/commands/*.md` — generated copies; edit templates only
- `openspec/specs/` — no spec files change
- Any `CLAUDE.md` or `.claude/rules/` file — conventions are unchanged

---

## Current State

### `templates/agents/architect.md` — relevant section boundaries

```
[line ~98] ## Quality Assurance
...
Re-read the original spec change one final time to catch anything missed
[line ~106]
## Update your agent memory      ← INSERT BEFORE THIS LINE
...
# Persistent Agent Memory
```

The file ends with the persistent agent memory block (the `{{MEMORY_PATH}}` placeholder and MEMORY.md section). The new section goes between `## Quality Assurance` and `## Update your agent memory`.

### `templates/agents/developer.md` — relevant section boundaries

```
[line ~85] ## Output Standards
...
If something in the spec conflicts with existing architecture, flag it explicitly before proceeding
[line ~91]
## Update Your Agent Memory      ← INSERT BEFORE THIS LINE
```

### `templates/agents/reviewer.md` — relevant section boundaries

```
[line ~74] ## Rules
...
If a test fails, read the test AND the implementation to understand the root cause before fixing.
[line ~79]
## Critical Warnings             ← INSERT BEFORE THIS LINE
```

### `install.sh` — relevant block

Search for the `agent-memory` mkdir block. It looks approximately like this:

```bash
mkdir -p "${TARGET}/.claude/agent-memory/architect"
mkdir -p "${TARGET}/.claude/agent-memory/developer"
mkdir -p "${TARGET}/.claude/agent-memory/reviewer"
# ... more agents ...
```

Add the `explanations` line at the end of this block.

---

## Exact Changes

### 1. `templates/commands/why.md` — Full content to create

```markdown
# /why — In-Context Help

Searches explanation records written by architect, developer, and reviewer agents
during the OpenSpec implementation pipeline.

Records are stored in `.claude/agent-memory/explanations/` as Markdown files with
YAML frontmatter (agent, feature, tags, date).

**Usage:**
- `/why` — list the 20 most recent explanation records
- `/why <query>` — search records by keyword or tag

---

## Step 1: Find explanation records

Glob all files matching `.claude/agent-memory/explanations/*.md`.

If the directory does not exist or contains no files:
Print:
```
No explanation records found yet.

Explanation records are written by the architect, developer, and reviewer agents
when they make significant decisions during feature implementation.

Run `/implement` on a feature to generate your first explanation records.
```
Then stop.

## Step 2: Handle no-argument mode (listing)

If `$ARGUMENTS` is empty:

Read each explanation record file. Extract from frontmatter: `date`, `agent`, `feature`, `tags`.
Extract the first sentence of the `## Decision` section as the decision summary.

Sort records by `date` descending. Print the 20 most recent as a Markdown table:

```
## Recent Explanation Records

| Date | Agent | Feature | Tags | Decision |
|------|-------|---------|------|----------|
| 2026-03-14 | architect | in-context-help | [templates, commands] | Chose flat directory over per-agent subdirectories. |
| ...  | ...   | ...     | ...  | ...      |
```

Then stop.

## Step 3: Handle query mode (search)

If `$ARGUMENTS` is non-empty, treat the full string as the search query.

For each explanation record file:
1. Read the full file content
2. Score the record against the query:
   - Filename contains a query word: +3 points per matching word
   - Frontmatter `tags` array contains an exact query word: +3 points per matching tag
   - Frontmatter `feature` contains a query word: +2 points
   - Body text contains a query word: +1 point per occurrence (case-insensitive)
3. Sum the score

Sort records by score descending. Take the top 5 records with score > 0.

If no records score > 0:
Print:
```
No explanation records match "<query>".
```
Then list all unique tags from existing records:
```
## Available Tags

[sorted list of all unique tags from all explanation records]

Try `/why <tag>` with one of the tags above, or `/why` to browse all records.
```

If records match, print each matching record in full, separated by `---`:

```
## Results for "<query>" (N matches)

---

**[date] [agent] — [feature]**
Tags: [tag1, tag2]

[full record body]

---

**[date] [agent] — [feature]**
...
```
```

### 2. Section to insert in `templates/agents/architect.md`

Insert this block between `## Quality Assurance` and `## Update your agent memory`:

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

Required frontmatter:
```yaml
---
agent: architect
feature: <change-name or "general">
tags: [keyword1, keyword2, keyword3]
date: YYYY-MM-DD
---
```

Required body section — `## Decision`: one sentence stating what was decided.

Optional sections: `## Why This Approach` (2–4 sentences of reasoning), `## Alternatives Considered` (bullet list), `## See Also` (file references).

Aim for 2–5 explanation records per significant feature design. Quality over quantity — a missing explanation is better than a noisy one.
```

### 3. Section to insert in `templates/agents/developer.md`

Insert this block between `## Output Standards` and `## Update Your Agent Memory`:

```markdown
## Explain Your Work

When you make a significant implementation decision, write an explanation record to `.claude/agent-memory/explanations/`.

**Write an explanation when you:**
- Chose an implementation approach over a plausible alternative
- Applied a project convention (shell flags, file naming, error handling) that a new developer might not recognize
- Resolved an ambiguous spec interpretation with a concrete implementation choice
- Used a specific pattern whose motivation is non-obvious from the code alone

**Do NOT write an explanation for:**
- Straightforward implementations with no meaningful alternatives
- Decisions already documented verbatim in `CLAUDE.md` or `.claude/rules/`
- Stylistic choices that follow an obvious convention

**How to write an explanation record:**

Create a file at:
  `.claude/agent-memory/explanations/YYYY-MM-DD-developer-<slug>.md`

Use today's date. Use a kebab-case slug describing the decision topic (max 6 words).

Required frontmatter:
```yaml
---
agent: developer
feature: <change-name or "general">
tags: [keyword1, keyword2, keyword3]
date: YYYY-MM-DD
---
```

Required body section — `## Decision`: one sentence stating what was decided.

Optional sections: `## Why This Approach`, `## Alternatives Considered`, `## See Also`.

Aim for 2–5 explanation records per feature implementation.
```

### 4. Section to insert in `templates/agents/reviewer.md`

Insert this block between `## Rules` and `## Critical Warnings`:

```markdown
## Explain Your Work

When you make a non-trivial quality judgment, write an explanation record to `.claude/agent-memory/explanations/`.

**Write an explanation when you:**
- Applied a lint rule fix that has non-obvious reasoning
- Rejected a code pattern and replaced it with the project-correct alternative
- Made a judgment call not explicitly covered by the CI checklist
- Fixed a root-cause issue that a new developer would likely repeat

**Do NOT write an explanation for:**
- Routine CI check failures fixed by obvious corrections
- Decisions already documented verbatim in `CLAUDE.md` or `.claude/rules/`
- Style fixes with no architectural significance

**How to write an explanation record:**

Create a file at:
  `.claude/agent-memory/explanations/YYYY-MM-DD-reviewer-<slug>.md`

Use today's date. Use a kebab-case slug describing the decision topic (max 6 words).

Required frontmatter:
```yaml
---
agent: reviewer
feature: <change-name or "general">
tags: [keyword1, keyword2, keyword3]
date: YYYY-MM-DD
---
```

Required body section — `## Decision`: one sentence stating what was decided.

Optional sections: `## Why This Approach`, `## Alternatives Considered`, `## See Also`.
```

### 5. Line to add in `install.sh`

Locate the block creating `agent-memory` subdirectories. Add at the end of that block:

```bash
mkdir -p "${TARGET}/.claude/agent-memory/explanations"
```

---

## Existing Patterns to Follow

### Frontmatter pattern (from `.claude/rules/agents.md`)

Agent files use YAML frontmatter with `---` delimiters. Explanation records follow the same pattern — the developer implementing this should verify the frontmatter format against an existing agent file like `templates/agents/architect.md`.

### Shell script pattern (from `.claude/rules/shell.md`)

`install.sh` uses `"${TARGET}"` (double-quoted, braces) for all variable expansions. The new `mkdir -p` line must follow this pattern exactly.

### Static command template pattern

`templates/commands/why.md` is a static template (no `{{PLACEHOLDER}}`). This is consistent with how `templates/commands/health-check.md` works — verify against that file if uncertain about the format.

### Memory directory naming

Existing memory dirs: `.claude/agent-memory/architect/`, `developer/`, `reviewer/`, etc. The new `explanations/` dir follows the same pattern but is shared (not per-agent).

---

## Conventions Checklist

Before marking tasks done, verify:

- [ ] `templates/commands/why.md` has zero `{{PLACEHOLDER}}` tokens
- [ ] All three agent templates have the new section in the correct position
- [ ] `install.sh` change uses `"${TARGET}"` quoting convention
- [ ] `shellcheck install.sh` passes with no new errors or warnings
- [ ] No leftover `{{...}}` tokens in modified template files: `grep -r '{{[A-Z_]*}}' templates/agents/architect.md templates/agents/developer.md templates/agents/reviewer.md`
- [ ] The "Explain Your Work" section uses the agent-correct filename prefix in each template (architect/developer/reviewer)
- [ ] The frontmatter in each template's example uses the agent-correct `agent:` value

---

## Risks Table

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agents write too many trivial explanations (noise) | Medium | Medium | Prompt language emphasizes "quality over quantity" and lists explicit "Do NOT write" cases |
| Agents write too few explanations (feature underused) | Medium | Low | Feature still works with zero records — `/why` gracefully handles empty directory |
| New `{{PLACEHOLDER}}` accidentally introduced in static `why.md` | Low | Low | Task 6 verification step catches this with grep |
| Section inserted in wrong position in agent template | Low | Low | Context bundle provides exact anchor lines; Task 6 verifies ordering |
| `install.sh` change breaks existing setup on older bash | Low | Medium | `mkdir -p` is POSIX — no compatibility risk. shellcheck catches shell issues |
| Explanation records accumulate unbounded over time | Low | Low | No cleanup is needed — files are small Markdown; `ls` and `/why` remain fast at thousands of records |
