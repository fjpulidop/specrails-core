---
name: doctor
description: "Run diagnostics on the sr plugin installation. Checks that all agents are available, required tools are installed, config files are valid, and memory directories exist. Outputs a health report with actionable fixes."
license: MIT
compatibility: "Requires git."
metadata:
  author: specrails
  version: "1.0"
---

# SpecRails Doctor

Run a full diagnostic check on the sr plugin installation and project configuration. Outputs a health report that identifies missing components, misconfigured files, and actionable fixes.

**Input:** $ARGUMENTS — optional:
- `--fix` — automatically fix issues where possible (safe fixes only: create missing dirs, initialize empty config files)
- `--verbose` — show detailed output for each check

---

## Check 1: Plugin agents

Verify that all expected plugin agents are accessible. The sr plugin should provide 14 agents:

Expected agents: `sr:architect`, `sr:developer`, `sr:reviewer`, `sr:backend-developer`, `sr:frontend-developer`, `sr:backend-reviewer`, `sr:frontend-reviewer`, `sr:security-reviewer`, `sr:performance-reviewer`, `sr:test-writer`, `sr:doc-sync`, `sr:merge-resolver`, `sr:product-manager`, `sr:product-analyst`

Check: Read the plugin's agent definitions to confirm they're installed.

Result: `PASS` if all agents found, `WARN` if some missing.

---

## Check 2: Required tools

Check for required CLI tools:

```bash
which git && git --version
which openspec && openspec --version 2>/dev/null || echo "MISSING"
which gh && gh --version 2>/dev/null || echo "NOT_INSTALLED (optional)"
which npm && npm --version 2>/dev/null || echo "NOT_INSTALLED (optional)"
```

- `git` — required
- `openspec` — required for OpenSpec workflow (`/specrails:opsx:*` skills)
- `gh` — required only if `BACKLOG_PROVIDER=github`
- `npm` — required only if project uses Node.js

---

## Check 3: Project configuration

Check for `.specrails/config.yaml`:
- If missing: `WARN` — run `/specrails:setup` to create it
- If exists: parse and validate required fields (`project.name`, `stack.description`, `ci.command`)
- Flag any fields with placeholder values like `"<STACK>"` or `"<CI_COMMAND>"`

Check for `.claude/backlog-config.json`:
- If missing: `WARN` — run `/specrails:setup` to create it
- If exists: validate `BACKLOG_PROVIDER` is one of `github`, `local`, `none`

---

## Check 4: Agent memory directories

Check that all 14 agent memory directories exist under `.claude/agent-memory/`:
- `sr-architect/`, `sr-developer/`, `sr-reviewer/`
- `sr-backend-developer/`, `sr-frontend-developer/`
- `sr-backend-reviewer/`, `sr-frontend-reviewer/`, `sr-security-reviewer/`, `sr-performance-reviewer/`
- `sr-test-writer/`, `sr-doc-sync/`, `sr-merge-resolver/`
- `sr-product-manager/`, `sr-product-analyst/`
- `explanations/`, `failures/`

If `--fix` is set: create missing directories automatically.

---

## Check 5: Personas

Check for persona files in `.specrails/personas/` or `.claude/agents/personas/`:
- If no persona files found: `WARN` — "No personas defined. Run `/specrails:setup` to create starter personas, or add `.specrails/personas/*.md` files manually."
- If found: count files and list them

---

## Check 6: OpenSpec workspace

Check for `openspec/` directory:
- If present: check `openspec/config.yaml` exists and `openspec/specs/` directory exists
- If missing: `INFO` — "No OpenSpec workspace found. Run `openspec init` to initialize if you plan to use `/specrails:opsx:*` skills."

---

## Check 7: CLAUDE.md

Check that `CLAUDE.md` exists at project root:
- If missing: `WARN` — agents cannot read project context without CLAUDE.md
- If exists: check for specrails section (look for "SpecRails" or "sr plugin" in the file)
- If no specrails section: `INFO` — "Consider adding a specrails workflow section to CLAUDE.md to give agents better context."

---

## Check 8: Unreplaced placeholders (optional)

If `--verbose` flag is set: scan `.specrails/config.yaml` for unreplaced placeholder values (patterns matching `<[A-Z_]+>` or `{{[A-Z_]+}}`). Report any found.

---

## Output Format

```
## SpecRails Doctor Report

| Check | Status | Notes |
|-------|--------|-------|
| Plugin agents | ✅ PASS | 14/14 agents found |
| git | ✅ PASS | git 2.39.0 |
| openspec | ✅ PASS | 1.1.1 |
| gh CLI | ⚠️ WARN | Not installed — required if BACKLOG_PROVIDER=github |
| .specrails/config.yaml | ✅ PASS | Valid |
| .claude/backlog-config.json | ✅ PASS | provider=github |
| Agent memory dirs | ✅ PASS | 16/16 directories present |
| Personas | ✅ PASS | 2 persona files found |
| OpenSpec workspace | ✅ PASS | openspec/ found |
| CLAUDE.md | ⚠️ WARN | No specrails section found |

---

**Overall: HEALTHY** (9 pass, 1 warn, 0 fail)

### Warnings

1. **gh CLI not installed**
   - Required for: `/specrails:get-backlog-specs`, `/specrails:implement` (when BACKLOG_PROVIDER=github), `/specrails:auto-propose-backlog-specs`
   - Fix: `brew install gh && gh auth login`

2. **CLAUDE.md missing specrails section**
   - Agents read project context from CLAUDE.md. Without a specrails section, agents fall back to defaults.
   - Fix: Run `/specrails:setup --skip-setup` or manually add a "## SpecRails Workflow" section to CLAUDE.md
```

**Status meanings:**
- `✅ PASS` — check passed
- `⚠️ WARN` — issue found, workflow will partially work
- `❌ FAIL` — critical issue, fix required before workflow will function
- `ℹ️ INFO` — informational, no action required
