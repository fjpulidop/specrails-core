---
change: in-context-help
type: design
---

# Design: AI-Powered In-Context Help System

## Overview

Three components make up this system:

1. **Explanation record format** — Markdown files with YAML frontmatter stored in `.claude/agent-memory/explanations/`
2. **Agent prompt extensions** — An "Explain Your Work" section added to architect, developer, and reviewer agent templates
3. **`/why` command** — A slash command that searches explanation records by keyword or tag

All three are implemented in the `templates/` layer (Markdown). No shell scripts, no external tools, no build step required.

---

## Component 1: Explanation Record Format

### Storage location

```
.claude/agent-memory/explanations/
├── YYYY-MM-DD-<agent>-<slug>.md
├── 2026-03-14-architect-why-section-aware-merge.md
├── 2026-03-14-developer-why-set-euo-pipefail.md
└── 2026-03-15-reviewer-why-conventional-commits.md
```

The directory is created at setup time by `install.sh` alongside other `agent-memory/` subdirectories.

### Filename convention

```
YYYY-MM-DD-<agent>-<kebab-case-slug>.md
```

- `YYYY-MM-DD`: date the explanation was written (agent uses today's date)
- `<agent>`: one of `architect`, `developer`, `reviewer`, `security-reviewer`, `test-writer`
- `<slug>`: kebab-case summary of the decision topic (max 6 words)

Example: `2026-03-14-architect-why-task-ordering-by-layer.md`

### Frontmatter schema

```yaml
---
agent: architect          # which agent wrote this
feature: <change-name>    # openspec change name, or "general" for non-feature work
tags: [conventions, shell, error-handling]  # searchable keywords, lowercase, array
date: YYYY-MM-DD
---
```

### Body structure

```markdown
## Decision

One sentence stating what was decided.

## Why This Approach

2–4 sentences explaining the reasoning. Reference specs, CLAUDE.md sections,
or existing patterns where applicable.

## Alternatives Considered

- **Alternative A**: why it was rejected
- **Alternative B**: why it was rejected

## See Also

- `.claude/rules/shell.md` (if referencing a rule file)
- `openspec/specs/<name>/spec.md` (if referencing a spec)
```

The "Alternatives Considered" and "See Also" sections are optional — agents should include them when they add value, not as boilerplate.

---

## Component 2: Agent Prompt Extensions

### Which agents receive the extension

- `templates/agents/architect.md`
- `templates/agents/developer.md`
- `templates/agents/reviewer.md`

These are the three agents that make substantive design, implementation, and quality decisions respectively. Other agents (product-manager, test-writer, doc-sync, security-reviewer) are excluded from the first iteration — they follow scripts more than they make judgment calls.

### Placement within each agent template

The "Explain Your Work" section is added **after** the agent's core workflow section and **before** the "Update Your Agent Memory" section. This placement ensures:

- The agent has completed its reasoning before being asked to record it
- The section is discovered naturally when reading the prompt top-to-bottom
- It does not interfere with the primary workflow

### Content of the "Explain Your Work" section

The wording is slightly different per agent to match their decision types, but the structure is identical. Example for the architect:

```markdown
## Explain Your Work

When you make a significant design decision — choosing a data format, rejecting an
approach, selecting an ordering strategy, applying a convention — write an explanation
record to `.claude/agent-memory/explanations/`.

**When to write an explanation:**
- You chose one approach over two or more plausible alternatives
- You applied a project convention that a new developer might not expect
- You rejected a spec interpretation that seems natural but is wrong for this codebase
- You flagged an ambiguity and resolved it with a specific default

**When NOT to write an explanation:**
- Routine implementation that follows an obvious path
- Decisions already documented in CLAUDE.md or `.claude/rules/`
- Minor stylistic choices with no meaningful tradeoffs

**How to write an explanation record:**

Create a file at:
  `.claude/agent-memory/explanations/YYYY-MM-DD-architect-<slug>.md`

Use today's date. Use a kebab-case slug that describes the decision topic.

Required frontmatter:
  agent: architect
  feature: <change-name or "general">
  tags: [comma, separated, keywords]
  date: YYYY-MM-DD

Body sections: Decision, Why This Approach, Alternatives Considered (optional), See Also (optional).

Aim for 3–8 explanation records per significant feature. Quality over quantity —
a missing explanation is better than a noisy one.
```

### Template variable consideration

The `{{MEMORY_PATH}}` placeholder already exists in all three agent templates. The "Explain Your Work" section uses a hardcoded path (`.claude/agent-memory/explanations/`) rather than a new placeholder, because:
1. The path is consistent across all target repos (install.sh creates it)
2. Adding a new `{{EXPLANATIONS_PATH}}` placeholder would require install.sh changes with no real benefit — the path never varies

---

## Component 3: `/why` Command

### File location

```
templates/commands/why.md     → .claude/commands/why.md
```

### Command invocation

```
/why <query>
```

Where `<query>` is one or more keywords or a tag name. Examples:
- `/why set -euo pipefail`
- `/why shell conventions`
- `/why section-aware merge`
- `/why` (no args — lists all explanation records with their tags)

### Search algorithm (executed by the LLM reading the command)

The command instructs the LLM to:

1. Glob all files matching `.claude/agent-memory/explanations/*.md`
2. If no query: list all records (filename, agent, feature, tags, first line of Decision section) sorted by date descending
3. If query provided:
   - Match against: filename, frontmatter `tags` array, frontmatter `feature`, and body text
   - Score: filename match = 3pts, tag exact match = 3pts, body keyword match = 1pt per occurrence
   - Return top 5 matches, showing the full record content for each
4. If no matches: say so and suggest related tags if the explanations directory is non-empty

### Command template design considerations

This command uses no shell tools beyond what the LLM can do natively (Read, Glob). It does not require `grep` as a Bash call — the LLM reads the files and searches in-context. This keeps the command POSIX-free and consistent with the template-only approach.

The command is intentionally simple. It is a developer convenience tool, not a full-text search engine. The file count in `.claude/agent-memory/explanations/` will be in the low hundreds at most — fully in-context search is practical.

### No-args behavior

Running `/why` with no arguments serves as a directory listing / onboarding entry point. It shows a table:

```
| Date | Agent | Feature | Tags | Decision Summary |
```

Sorted by date descending, showing the 20 most recent records.

---

## install.sh Changes

The `install.sh` script creates agent memory directories during setup. The `explanations/` directory needs to be added alongside existing memory directories.

### Current pattern (lines creating memory dirs)

install.sh already creates `.claude/agent-memory/` subdirectories for each agent. The change adds:

```bash
mkdir -p "${TARGET}/.claude/agent-memory/explanations"
```

This is a one-line addition adjacent to existing `mkdir -p` calls for agent memory directories.

---

## Design Decisions and Tradeoffs

### Decision: Markdown files, not JSON

Explanation records are Markdown with YAML frontmatter, not JSON or structured data. Reasons:
- Consistent with every other file in the specrails system
- Human-readable without tooling
- The LLM can read and write them natively
- YAML frontmatter is already the established pattern for agents, rules, and memory files

Rejected: JSON — adds serialization complexity, not readable in a terminal without `jq`.

### Decision: LLM-native search, not grep

The `/why` command instructs the LLM to read and search files rather than running `grep` via Bash. Reasons:
- `grep` in a Claude Code command requires Bash permission — an unnecessary dependency for a read-only command
- LLM in-context search handles partial matches, synonyms, and natural language queries better than grep
- File count is bounded — in-context search is fast enough

Rejected: bash grep pipeline — adds friction, requires Bash permission, worse UX for fuzzy queries.

### Decision: Opt-in explanation recording (judgment-based)

Agents are instructed to use judgment about when to write explanations, not to write one for every action. Reasons:
- The value of explanations is inversely proportional to their volume
- A developer reading 50 trivial explanations will stop reading them
- Agents already have long prompts — over-specifying explanation triggers adds noise

Rejected: mandatory explanation per task — creates noise and degrades explanation quality.

### Decision: Three agents only (architect, developer, reviewer)

Only architect, developer, and reviewer receive the "Explain Your Work" section in this iteration. Reasons:
- These three make substantive judgment calls that benefit from explanation
- product-manager, test-writer, doc-sync follow more deterministic patterns
- Adding to all agents would dilute the value and add prompt length without proportional benefit

This is explicitly a first iteration — other agents can be added based on observed usage.

### Decision: Flat directory, no subdirectories by agent or feature

All explanation records go into a single `.claude/agent-memory/explanations/` directory. Reasons:
- Filename convention (`YYYY-MM-DD-<agent>-<slug>`) provides sufficient structure for filtering
- The `/why` command searches all records regardless of origin — subdirectories would complicate globbing
- Flat is simpler to scan in a terminal (`ls explanations/`)

Rejected: per-agent subdirectories — fragments search, complicates glob patterns, adds setup complexity.
