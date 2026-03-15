---
change: auto-doc-sync-agent
type: context-bundle
---

# Context Bundle: Auto-Doc Sync Agent

This document contains everything a developer needs to implement this change without reading any other file. It bundles key context from the design, tasks, and codebase exploration.

---

## What You Are Building

A new Claude Code agent called `doc-sync` that:

1. Detects the target repo's existing documentation conventions (docstrings, CHANGELOG.md, README feature sections, migration guides)
2. Reads existing documentation style before generating anything — never invents a new convention
3. Generates only the documentation types the project already uses
4. Integrates into the implement pipeline as **Phase 3d**, running after the test-writer (Phase 3c) and before the reviewer (Phase 4)
5. Is non-blocking on failure — if the agent fails or detects no documentation conventions, the pipeline continues

The agent is a **Markdown prompt file** — no shell scripts, no external tool dependencies. All documentation generation happens through Claude's code analysis.

---

## Codebase Patterns to Follow

### Agent file structure

All agents follow this pattern. The cleanest recent example for the template is `templates/agents/test-writer.md`. Its generated counterpart is `.claude/agents/test-writer.md`.

**Template file** (`templates/agents/*.md`): Uses `{{PLACEHOLDER}}` for values that vary per target repo.

**Generated file** (`.claude/agents/*.md`): Same content with placeholders substituted for specrails-specific values.

YAML frontmatter required fields:
```yaml
---
name: <kebab-case-name>
description: "Multi-line string with usage examples"
model: sonnet
color: <color-name>
memory: project
---
```

**Color assignment for doc-sync: `yellow`**

Current color assignments (do not reuse):
- `green` — architect
- `purple` — developer, backend-developer
- `red` — reviewer
- `orange` — security-reviewer
- `cyan` — test-writer, product-analyst
- `blue` — product-manager, frontend-developer

### Placeholders in templates

Templates use `{{UPPER_SNAKE_CASE}}` for static substitution. The specrails-instance values for the doc-sync agent:

| Placeholder | Resolved value |
|-------------|---------------|
| `{{TECH_EXPERTISE}}` | Copy verbatim from `.claude/agents/developer.md` |
| `{{LAYER_CLAUDE_MD_PATHS}}` | `.claude/rules/*.md` |
| `{{MEMORY_PATH}}` | `.claude/agent-memory/doc-sync/` |

For `{{TECH_EXPERTISE}}`, open `.claude/agents/developer.md` and copy the block that lists:
- Shell scripting: Bash, POSIX sh, installers, CLI tools
- TypeScript/JavaScript: Node.js, CLI frameworks...
- Template systems: Markdown templates with placeholder substitution...
- Developer tooling: CI/CD pipelines, GitHub Actions...
- AI prompt engineering: Claude Code agents, structured prompts...

**Runtime-injected values** — these are NOT substitution targets. They appear in the prompt body as instructional references (plain text, not `{{...}}`):
- `IMPLEMENTED_FILES_LIST` — the list of files the developer created or modified, injected by the orchestrator at invocation time
- `TASK_DESCRIPTION` — injected by the orchestrator at invocation time

### Memory pattern

Every agent has a memory directory with an initial `MEMORY.md` file:
```
.claude/agent-memory/<agent-name>/MEMORY.md
```

Header content for doc-sync:
```markdown
# Doc Sync Agent Memory

No memories recorded yet.
```

### Implement command structure

`templates/commands/implement.md` is the pipeline definition. Current phase structure with the new insertion point marked:

```
Phase -1: Environment Setup
Phase 0:  Parse input and determine mode
Phase 1:  Explore (parallel)
Phase 2:  Select
Phase 3a: Architect (parallel, in main repo)
Phase 3b: Implement
Phase 3c: Write Tests
           ← INSERT Phase 3d: Doc Sync HERE
Phase 4:  Merge & Review
  4a. Merge worktree changes
  4b. Launch Reviewer agent
  4b-sec. Launch Security Reviewer agent
  4c. Ship
  4d. Monitor CI
  4e. Report
```

Phase 3d is inserted immediately after the last line of Phase 3c's failure handling block:
```
- Include in the reviewer agent prompt: "Note: the test-writer failed for this feature. Check for coverage gaps."
```

The Phase 4e report table currently reads:
```
| Area | Feature | Change Name | Architect | Developer | Tests | Reviewer | Security | CI | Status |
```

After this change it must read:
```
| Area | Feature | Change Name | Architect | Developer | Tests | Docs | Reviewer | Security | CI | Status |
```

This is a **column addition** — `Docs` is inserted between `Tests` and `Reviewer` to reflect execution order.

---

## Files to Create or Modify

### Create (new files)

| Path | Description |
|------|-------------|
| `templates/agents/doc-sync.md` | Canonical agent template with `{{PLACEHOLDER}}` syntax |
| `.claude/agents/doc-sync.md` | Generated specrails instance with placeholders resolved |
| `.claude/agent-memory/doc-sync/MEMORY.md` | Initial empty memory file |

### Modify (existing files)

| Path | Change |
|------|--------|
| `templates/commands/implement.md` | Insert Phase 3d after Phase 3c failure handling; update Phase 4e table |
| `.claude/commands/implement.md` | Same changes applied to generated copy |

---

## Phase 3d Block to Insert

Insert this exact Markdown block into both `templates/commands/implement.md` and `.claude/commands/implement.md`, immediately after the "Note: the test-writer failed..." line of Phase 3c and before the `## Phase 4: Merge & Review` heading:

```markdown
## Phase 3d: Doc Sync

Launch a **doc-sync** agent for each feature after its test-writer completes.

Construct the agent invocation prompt to include:
- **IMPLEMENTED_FILES_LIST**: the complete list of files the developer created or modified for this feature
- **TASK_DESCRIPTION**: the original task or feature description that drove the implementation

### Launch modes

**If `SINGLE_MODE`**: Launch a single doc-sync agent in the foreground (`run_in_background: false`). Wait for completion before proceeding to Phase 4.

**If multiple features (worktrees)**: Launch one doc-sync agent per feature, each in its corresponding worktree (`isolation: worktree`, `run_in_background: true`). Wait for all doc-sync agents to complete before proceeding to Phase 4.

### Dry-run behavior

**If `DRY_RUN=true`**, include in every doc-sync agent prompt:

> IMPORTANT: This is a dry-run. Write all new or modified documentation files under:
>   .claude/.dry-run/\<feature-name\>/
>
> Mirror the real destination path within this directory. After writing each file, append an entry
> to .claude/.dry-run/\<feature-name\>/.cache-manifest.json using this JSON format:
>   {"cached_path": "...", "real_path": "...", "operation": "create|modify"}

### Failure handling

If a doc-sync agent fails or times out:
- Record `Docs: FAILED` for that feature in the Phase 4e report
- Continue to Phase 4 — doc-sync failure is non-blocking
- Include in the reviewer agent prompt: "Note: the doc-sync agent failed for this feature. Documentation may be incomplete."
```

---

## Documentation Detection Protocol (for agent prompt)

The agent prompt must describe detection using this logic, in order:

| Documentation Type | Detection Signal | If Detected |
|-------------------|-----------------|-------------|
| Inline docstrings | Find 1+ existing docstring in same-language files as `IMPLEMENTED_FILES_LIST` | Add docstrings to undocumented exported symbols in those files |
| CHANGELOG.md | File exists at repo root or `docs/CHANGELOG.md` | Read format, prepend new entry |
| README feature list | `## Features`, `## What's New`, or `## Capabilities` section in README.md | Append new entry under matching section |
| Migration guide | `MIGRATION.md`, `docs/migration/` dir, or `### Breaking Changes` in CHANGELOG | Generate migration section if breaking change detected |

If none of these signals are found: output `DOC_SYNC_STATUS: SKIPPED` and stop.

---

## Output Format (for agent prompt)

The agent prompt must specify this exact output format:

```
## Doc Sync Results

### Documentation Detected
- Docstrings: yes/no (<style if yes>)
- CHANGELOG.md: yes/no (<format if yes>)
- README feature section: yes/no (<section heading if yes>)
- Migration guide: yes/no (<location if yes>)

### Documentation Written
| Type | File | Description |
|------|------|-------------|
| Docstrings | <file> | Added docstrings to N exported symbols |
| Changelog | CHANGELOG.md | Added entry for <feature> |
| README | README.md | Added feature entry under <section> |
| Migration | <file> | Added breaking change section |

### Skipped
| Type | Reason |
|------|--------|
(rows or "None")

---
DOC_SYNC_STATUS: DONE|SKIPPED|PARTIAL|FAILED
```

`DOC_SYNC_STATUS:` MUST be the very last line of output. The pipeline parses this line to populate the Phase 4e report `Docs` column.

---

## Key Design Decisions (Do Not Deviate)

1. **Detection-first** — the agent never generates documentation if it cannot detect an existing convention for that doc type. It does not bootstrap new documentation systems.

2. **Non-blocking failure** — if the agent fails, Phase 4 continues. The reviewer notes the gap. Do not add error recovery loops.

3. **Never modify implementation or test files** — doc-sync only writes to documentation files (source comments/docstrings are an exception: these are in the source file but are documentation, not logic).

4. **One doc-sync per feature in multi-feature mode** — scoped to its own worktree, not a single agent over all features.

5. **Color is `yellow`** — do not change this to an already-used color.

6. **`DOC_SYNC_STATUS:` is the final output line** — same pattern as `TEST_WRITER_STATUS:` in test-writer. The orchestrator parses this to populate the Docs column.

7. **Phase 3d, not anything else** — the numbering continues the existing 3a, 3b, 3c sequence. Do not renumber existing phases.

---

## Verification Checklist

Before considering this change complete:

- [ ] `templates/agents/doc-sync.md` exists and has valid YAML frontmatter with `color: yellow`
- [ ] `templates/agents/doc-sync.md` contains exactly these placeholders: `{{TECH_EXPERTISE}}`, `{{LAYER_CLAUDE_MD_PATHS}}`, `{{MEMORY_PATH}}`
- [ ] `.claude/agents/doc-sync.md` exists with no unresolved `{{...}}` strings
- [ ] `.claude/agent-memory/doc-sync/MEMORY.md` exists
- [ ] `templates/commands/implement.md` has a `## Phase 3d: Doc Sync` section positioned after Phase 3c and before Phase 4
- [ ] `.claude/commands/implement.md` has the same Phase 3d section
- [ ] Phase 4e report table in both implement files includes `Docs` column between `Tests` and `Reviewer`
- [ ] `grep '{{[A-Z_]*}}' .claude/agents/doc-sync.md` returns no output
- [ ] Phase 3d failure handling is non-blocking in both implement files
