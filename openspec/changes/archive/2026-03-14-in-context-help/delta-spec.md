---
change: in-context-help
type: delta-spec
---

# Delta Spec: AI-Powered In-Context Help System

This document states what the specrails system SHALL do after this change is applied. Each statement is a precise, testable requirement written in the present tense (what the system does) rather than the imperative (what to build).

---

## Explanation Record System

**EXP-1**: The system provides a designated directory at `.claude/agent-memory/explanations/` in every target repository created by `install.sh`. This directory is created during the setup process alongside other `agent-memory/` subdirectories.

**EXP-2**: Explanation records are Markdown files with YAML frontmatter. The frontmatter MUST contain the following fields:
- `agent`: one of `architect`, `developer`, `reviewer`, `security-reviewer`, `test-writer`
- `feature`: the OpenSpec change name, or `general` for decisions not tied to a specific change
- `tags`: an array of lowercase keyword strings
- `date`: an ISO 8601 date string (`YYYY-MM-DD`)

**EXP-3**: Explanation record filenames follow the convention `YYYY-MM-DD-<agent>-<slug>.md` where `<slug>` is a kebab-case description of the decision topic, maximum 6 words.

**EXP-4**: The body of an explanation record contains a `## Decision` section (required) stating what was decided in one sentence. Optional sections include `## Why This Approach`, `## Alternatives Considered`, and `## See Also`.

---

## Agent Prompt Behavior

**AGT-1**: The architect agent template (`templates/agents/architect.md`) includes an "Explain Your Work" section that instructs the agent to write explanation records when it makes significant design decisions.

**AGT-2**: The developer agent template (`templates/agents/developer.md`) includes an "Explain Your Work" section that instructs the agent to write explanation records when it applies a non-obvious convention, resolves an ambiguity, or chooses one implementation approach over plausible alternatives.

**AGT-3**: The reviewer agent template (`templates/agents/reviewer.md`) includes an "Explain Your Work" section that instructs the agent to write explanation records when it applies a quality rule, rejects a pattern, or makes a judgment call beyond running CI checks.

**AGT-4**: The "Explain Your Work" section is positioned after each agent's core workflow and before the "Update Your Agent Memory" section.

**AGT-5**: Agents use judgment to decide when to write explanations. Explanation recording is not mandatory for every action. The agent MUST write an explanation when it chooses among two or more plausible approaches, and SHOULD write one when applying a convention a new developer might not expect.

**AGT-6**: Agents MUST NOT write explanation records for decisions already fully documented in `CLAUDE.md` or `.claude/rules/`, unless the record adds context about *why* the rule exists that is not present in those files.

---

## `/why` Command

**WHY-1**: The system provides a `/why` command at `.claude/commands/why.md` (generated from `templates/commands/why.md`).

**WHY-2**: `/why <query>` searches explanation records in `.claude/agent-memory/explanations/` and returns the top matching records. Matching is performed against filenames, frontmatter tags, frontmatter feature field, and body text.

**WHY-3**: `/why` with no arguments returns a table listing the 20 most recent explanation records, sorted by date descending, showing: date, agent, feature, tags, and first sentence of the Decision section.

**WHY-4**: `/why <query>` returns the full content of matching records (up to 5 results). If no records match, the command says so and, if the explanations directory is non-empty, suggests tags from existing records.

**WHY-5**: The `/why` command requires no Bash execution. It operates using only the Read and Glob tools available to the LLM.

**WHY-6**: The `/why` command source template (`templates/commands/why.md`) uses no `{{PLACEHOLDER}}` substitution — it is a static command template that requires no customization by `install.sh`.

---

## install.sh

**INS-1**: `install.sh` creates the `.claude/agent-memory/explanations/` directory when setting up a target repository, adjacent to the existing per-agent memory directories.

---

## What Does NOT Change

- The OpenSpec workflow commands (`/opsx:ff`, `/opsx:apply`, etc.) are not modified
- The `CLAUDE.md` and `.claude/rules/` files remain the authoritative source for conventions — explanation records are supplementary
- No new `{{PLACEHOLDER}}` variables are introduced in agent templates
- No external dependencies (no search index, no vector DB, no additional CLI tools)
- Agent memory `MEMORY.md` files and their per-agent topic files are unaffected — those serve a different purpose (cross-session architectural memory for the agent itself, not explanations for human developers)
