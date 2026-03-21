# Codex vs Claude Code

SpecRails supports both **OpenAI Codex** and **Anthropic Claude Code** as AI agent runtimes. This page explains the differences so you can choose the right setup for your team.

---

## Summary

| | Claude Code | Codex |
|--|-------------|-------|
| **Support status** | Stable | Beta |
| **CLI** | `claude` | `codex` |
| **Config directory** | `.claude/` | `.codex/` |
| **Agent instructions** | `CLAUDE.md` | `AGENTS.md` |
| **Skills (`/sr:*`, `/opsx:*`)** | ✅ Full support | ✅ Full support |
| **OpenSpec workflow** | ✅ Full support | ✅ Full support |
| **Parallel worktrees** | ✅ Native | ⚠️ Limited |
| **Agent definitions** | Markdown frontmatter | TOML |
| **Permissions config** | `settings.json` | `config.toml` |
| **Agent memory** | File-based | File-based (MEMORY.md) |
| **MCP** | ✅ First-class | ✅ First-class |
| **Codex Cloud (web)** | ✗ | ✅ |

---

## What works the same

### Skills

SpecRails Skills use `SKILL.md` format, which is shared between Codex and Claude Code. All `/sr:*` and `/opsx:*` skills run identically on both platforms:

- `/sr:implement` — full pipeline (design → code → review → PR)
- `/sr:product-backlog` — VPC-ranked backlog view
- `/sr:health-check` — codebase quality analysis
- `/opsx:ff` — OpenSpec fast-forward
- All other workflow skills

### OpenSpec

The full OpenSpec design-to-code workflow works on both platforms. Artifacts (proposals, designs, task lists, context bundles) are plain Markdown files — no platform dependency.

### Git and GitHub

Both platforms use standard `git` and the `gh` CLI. PR creation, branch management, and issue integration work identically.

### Agent memory

Both platforms use file-based memory. Claude Code uses `.claude/agent-memory/`. Codex uses `.codex/agent-memory/`. The format is the same — only the location changes.

---

## What is different

### Parallel execution and worktrees

`/sr:batch-implement` (multiple issues in parallel) uses git worktree isolation. On Claude Code this runs locally with full isolation. On Codex:

- **Codex CLI**: Parallel execution is supported but worktree isolation is limited in the current beta. Multiple issues may share a working directory.
- **Codex Cloud**: Native async parallelism — each task gets an isolated cloud environment. Well-suited for batch work.

### Agent definitions

SpecRails generates agent definitions in the format required by each platform:

| Platform | Format | Location |
|----------|--------|----------|
| Claude Code | Markdown with YAML frontmatter | `.claude/agents/sr-*.md` |
| Codex | TOML | `.codex/agents/sr-*.toml` |

The behavior of each agent (Architect, Developer, Reviewer, etc.) is identical — only the definition format differs.

### Configuration and permissions

| Platform | Format | Location |
|----------|--------|----------|
| Claude Code | JSON | `.claude/settings.json` |
| Codex | TOML | `.codex/config.toml` |

The installer generates the correct format automatically.

### Non-interactive invocation

Claude Code and Codex have different non-interactive modes:

```bash
# Claude Code
claude --print "run /sr:implement #42"

# Codex
codex exec "run /sr:implement #42"
```

Skills themselves are the same — only the CLI invocation differs.

---

## Choosing a platform

**Choose Claude Code if:**
- You want the most stable and fully tested SpecRails experience
- You need reliable parallel worktree isolation for batch feature work
- Your team is already in the Anthropic ecosystem

**Choose Codex if:**
- Your team is in the OpenAI ecosystem and prefers Codex
- You want to use Codex Cloud for async, web-based agent runs
- You are evaluating SpecRails and already have Codex installed

**Use both if:**
- Different team members use different tools
- You want to benchmark agents across platforms

When both CLIs are installed, the SpecRails installer detects which is active. You can override with `CLI_PROVIDER=claude` or `CLI_PROVIDER=codex`.

---

## Platform detection

The installer detects your platform automatically:

```
Detected CLI: codex (1.2.0)
Generating config in .codex/
```

To override:

```bash
CLI_PROVIDER=codex npx specrails-core@latest init --root-dir .
CLI_PROVIDER=claude npx specrails-core@latest init --root-dir .
```

---

## Known limitations (Codex beta)

| Limitation | Status |
|-----------|--------|
| Parallel worktree isolation | Partial — being improved |
| Windows support | Experimental in Codex CLI |
| Agent memory system maturity | Less mature than Claude Code; use MEMORY.md patterns |
| Codex CLI version stability | Frequent updates; pin your version if needed |

---

[← Getting Started (Codex)](getting-started-codex.md) · [← Installation](installation.md) · [CLI Reference →](cli-reference.md)
