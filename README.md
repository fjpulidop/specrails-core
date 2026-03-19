# specrails-core

[![npm version](https://img.shields.io/npm/v/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm downloads](https://img.shields.io/npm/dw/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![Claude Code](https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet)](https://docs.anthropic.com/en/docs/claude-code)

**Your AI development team. From idea to production code.**

One command gives your repo a full team of specialized AI agents: architect, developer, reviewer, product manager — all working together through a structured pipeline, fully adapted to your codebase.

```bash
npx specrails-core@latest init --root-dir .
```

> **Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (required), Node 18+, git

---

## How it works

```
Idea  →  Architecture  →  Implementation  →  Review  →  PR
         (sr-architect)   (sr-developer)    (sr-reviewer)
```

Run `/sr:implement "add dark mode"` — the pipeline designs, builds, reviews, and ships a pull request. No hand-holding required.

Every artifact (agents, rules, personas) is generated **specifically for your project** by analyzing your actual codebase, tech stack, and CI setup. Not generic templates.

---

## Quick start

**1. Install**

```bash
npx specrails-core@latest init --root-dir .
```

**2. Run setup inside Claude Code**

```bash
claude      # open Claude Code in your project
> /setup    # run the 5-phase wizard (~5 min)
```

**3. Start building**

```bash
> /sr:implement "add user authentication"
> /sr:implement #42, #43               # from GitHub Issues
> /sr:update-product-driven-backlog    # discover new features with AI
```

That's it. The pipeline takes over.

---

## What gets installed

| Category | Files | Purpose |
|----------|-------|---------|
| **Agents** | `.claude/agents/*.md` | 12 specialized AI agents |
| **Personas** | `.claude/agents/personas/*.md` | VPC user profiles, generated from your users |
| **Commands** | `.claude/commands/sr/*.md` | `/sr:implement`, `/sr:product-backlog`, `/sr:update-product-driven-backlog` |
| **Rules** | `.claude/rules/*.md` | Per-layer coding conventions, loaded by file path |
| **Memory** | `.claude/agent-memory/` | Persistent knowledge — agents learn across sessions |
| **Config** | `.claude/settings.json`, `CLAUDE.md` | Permissions, architecture reference |

---

## Why SpecRails

| | SpecRails | Plain Claude Code | Cursor / Copilot |
|---|---|---|---|
| Structured pipeline | ✅ Architect → Dev → Review → PR | ❌ Manual | ❌ Manual |
| Adapts to your codebase | ✅ Reads your actual stack/CI | ⚠️ Prompts only | ❌ |
| Product-driven backlog | ✅ VPC persona scoring | ❌ | ❌ |
| Parallel feature builds | ✅ Git worktrees | ❌ | ❌ |
| Institutional memory | ✅ Agents learn across sessions | ❌ | ❌ |
| Open source | ✅ MIT | N/A | ❌ |

SpecRails is not a chat interface. It's a **development pipeline** that coordinates multiple specialized agents through your existing tools (GitHub Issues, JIRA, git, CI).

---

## The agents

| Agent | Model | Role |
|-------|-------|------|
| **sr-architect** | Sonnet | Designs features: proposal, technical design, task breakdown |
| **sr-developer** | Sonnet | Full-stack implementation |
| **sr-backend-developer** | Sonnet | Backend-specialized implementation |
| **sr-frontend-developer** | Sonnet | Frontend-specialized implementation |
| **sr-reviewer** | Sonnet | Quality gate: runs CI, fixes issues, records learnings |
| **sr-backend-reviewer** | Sonnet | Backend code review: API design, DB patterns, performance |
| **sr-frontend-reviewer** | Sonnet | Frontend code review: UX, accessibility, component design |
| **sr-test-writer** | Sonnet | Generates unit, integration, and e2e tests |
| **sr-security-reviewer** | Sonnet | Secrets detection, OWASP checks, dependency vulnerabilities |
| **sr-doc-sync** | Sonnet | Updates changelogs, READMEs, API docs |
| **sr-product-manager** | Opus | Product discovery: competitive analysis, VPC evaluation |
| **sr-product-analyst** | Haiku | Read-only backlog analysis and prioritization |

---

## Commands

### `/sr:implement` — Build features

```bash
/sr:implement "add dark mode"        # from a description
/sr:implement #85, #71               # from GitHub Issues
/sr:implement UI, Analytics          # explore areas, pick the best ideas
```

Architect designs → developer builds → reviewer validates → PR created. Multiple features run in parallel with git worktrees.

### `/sr:product-backlog` — View prioritized backlog

```bash
/sr:product-backlog                  # show all areas
/sr:product-backlog UI, Decks        # filter by area
```

Reads your GitHub Issues, scores by VPC persona match, recommends top 3 for next sprint.

### `/sr:update-product-driven-backlog` — Discover features

```bash
/sr:update-product-driven-backlog             # explore all areas
/sr:update-product-driven-backlog Analytics   # focus on one area
```

AI product discovery using your personas. Evaluates ideas, creates GitHub Issues for the best ones.

---

## Value Proposition Canvas (VPC)

Features are scored against your user personas using the VPC framework:

```
+-----------------------------+    +-----------------------------+
|     VALUE PROPOSITION       |    |     CUSTOMER SEGMENT        |
|  Products & Services    <---+--->|  Customer Jobs              |
|  Pain Relievers         <---+--->|  Pains                      |
|  Gain Creators          <---+--->|  Gains                      |
+-----------------------------+    +-----------------------------+
```

Each persona scores features 0-5. Features are ranked by score/effort ratio. No gut-feel product decisions.

---

## Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| **Claude Code** | Yes | AI agent runtime — [install](https://docs.anthropic.com/en/docs/claude-code) |
| **git** | Yes | Repository detection |
| **npm / Node 18+** | Recommended | Needed for npx install and OpenSpec CLI |
| **OpenSpec CLI** | Recommended | Structured design artifacts for `/sr:implement` |
| **GitHub CLI** (`gh`) | Optional | Backlog sync to GitHub Issues, PR creation |
| **JIRA CLI** (`jira`) | Optional | Backlog sync to JIRA |

The installer checks for each tool and offers to install missing ones.

---

## Supported stacks

Stack-agnostic. The `/setup` wizard detects and adapts to whatever you're running:

**Backend:** Python/FastAPI, Node/Express, Go/Gin, Rust/Actix, Java/Spring, Ruby/Rails, .NET
**Frontend:** React, Vue, Angular, Svelte, Next.js, Nuxt
**Database:** PostgreSQL, MySQL, SQLite, MongoDB, Redis
**CI/CD:** GitHub Actions, GitLab CI, Jenkins, Makefile
**Testing:** pytest, vitest, jest, go test, cargo test, rspec

---

## FAQ

**Can I customize the agents after installation?**
Yes. The generated files in `.claude/` are yours to edit — plain markdown.

**Can I re-run setup?**
The `/setup` command deletes itself after completion. Re-run `install.sh` to re-scaffold, then `/setup` again.

**Does this work without OpenSpec?**
Partially. Product discovery commands and individual agents work. `/sr:implement` and sr-architect rely on OpenSpec for structured design artifacts.

**Does this work without GitHub CLI?**
Yes. Use JIRA instead, or skip backlog commands. `/sr:implement "description"` works without `gh` — it just skips automated PR creation.

**How much does it cost to run?**
A full `/sr:implement` cycle for one feature typically costs a few dollars in Claude API usage. The sr-product-manager uses Opus; all other agents use Sonnet or Haiku.

**Does it work with private repos?**
Yes. Everything runs locally through Claude Code. No external services beyond the Claude API.

---

## Also in the SpecRails ecosystem

- **[specrails-hub](https://github.com/fjpulidop/specrails-hub)** — GUI for specrails-core. Manage your agents, run commands, and view pipeline results from a web interface.
- **[specrails.dev](https://specrails.dev)** — Official website and documentation.

---

## License

MIT — [fjpulidop](https://github.com/fjpulidop)
