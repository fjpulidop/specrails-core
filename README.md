# specrails-core

[![npm version](https://img.shields.io/npm/v/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![GitHub Stars](https://img.shields.io/github/stars/fjpulidop/specrails-core?style=social)](https://github.com/fjpulidop/specrails-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm downloads](https://img.shields.io/npm/dw/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![Claude Code](https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet)](https://docs.anthropic.com/en/docs/claude-code)
[![Codex](https://img.shields.io/badge/Built%20for-OpenAI%20Codex-412991)](https://github.com/openai/codex)

**Your AI development team. From idea to production code.**

One command gives your repo a full team of specialized AI agents: architect, developer, reviewer, product manager — all working together through a structured pipeline, fully adapted to your codebase.

```bash
npx specrails-core@latest init --root-dir .
```

> **Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex) (choose one), Node 18+, git

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

**2. Run setup inside your AI CLI**

```bash
claude      # Claude Code
# or
codex       # OpenAI Codex (beta)
> /setup    # run the 5-phase wizard (~5 min)
```

**3. Start building**

```bash
> /sr:implement "add user authentication"
> /sr:implement #1, #2                 # from local tickets (default)
> /sr:implement #42, #43               # from GitHub Issues (if configured)
> /sr:update-product-driven-backlog    # discover new features with AI
```

That's it. The pipeline takes over.

---

## What gets installed

| Category | Files | Purpose |
|----------|-------|---------|
| **Agents** | `.claude/agents/*.md` | 14 specialized AI agents |
| **Personas** | `.claude/agents/personas/*.md` | VPC user profiles, generated from your users |
| **Commands** | `.claude/commands/sr/*.md` | 17 workflow commands: `/sr:implement`, `/sr:product-backlog`, `/sr:health-check`, `/sr:why`, and more |
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
| **sr-merge-resolver** | Sonnet | AI-powered merge conflict resolution for multi-feature pipelines |
| **sr-performance-reviewer** | Sonnet | Performance regression detection after implementation |
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

#### Dry-run / preview mode

Not ready to commit? Run the full pipeline without touching git or GitHub:

```bash
/sr:implement "add dark mode" --dry-run
/sr:implement #85 --preview            # --preview is an alias for --dry-run
```

All agents run normally. Generated files land in `.claude/.dry-run/<feature-name>/` instead of your working tree. No branches, commits, PRs, or issue updates are created.

When you're happy with the preview, apply the cached output:

```bash
/sr:implement --apply add-dark-mode    # copies files to real paths, then ships
```

To discard without applying:

```bash
rm -rf .claude/.dry-run/add-dark-mode/
```

### `/sr:product-backlog` — View prioritized backlog

```bash
/sr:product-backlog                  # show all areas
/sr:product-backlog UI, Decks        # filter by area
```

Reads your tickets (local or GitHub Issues), scores by VPC persona match, recommends top 3 for next sprint.

### `/sr:update-product-driven-backlog` — Discover features

```bash
/sr:update-product-driven-backlog             # explore all areas
/sr:update-product-driven-backlog Analytics   # focus on one area
```

AI product discovery using your personas. Evaluates ideas, creates tickets (local or GitHub Issues) for the best ones.

---

## Local ticket management

specrails-core ships with a built-in ticket system — no GitHub account or external tools required.

Tickets live in `.claude/local-tickets.json` alongside your code. They're plain JSON, git-friendly, and bidirectionally synced with specrails-hub in real time.

**Local tickets are the default.** The `/setup` wizard defaults to local tickets and skips GitHub/JIRA credential setup unless you opt in.

```bash
/sr:implement #1, #4           # implement by ticket ID
/sr:product-backlog            # view prioritized backlog
/sr:update-product-driven-backlog  # discover and create tickets with AI
/sr:propose-spec               # create a ticket from a spec proposal
```

See [docs/local-tickets.md](./docs/local-tickets.md) for the full schema reference, concurrency model, and command integration details.

Migrating from GitHub Issues or JIRA? See [docs/migration-guide.md](./docs/migration-guide.md).

---

## VPC persona scoring

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
| **GitHub CLI** (`gh`) | Optional | Backlog sync to GitHub Issues, PR creation. Not needed with local tickets. |
| **JIRA CLI** (`jira`) | Optional | Backlog sync to JIRA. Not needed with local tickets. |

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

## Design principles

1. **Two-step install** — Shell handles prerequisites, Claude handles intelligence. No API keys beyond Claude Code auth.
2. **Self-cleaning** — All scaffolding removed after setup. Only final, project-specific files remain.
3. **Context-first** — Every generated file uses your real paths, patterns, and CI commands.
4. **Persona-driven** — Product decisions grounded in researched user personas, not assumptions.
5. **Institutional memory** — Agents learn across sessions. Reviewer learnings feed back to future developers.
6. **Parallel-safe** — Multiple features implemented simultaneously via git worktrees with automatic merge.

---

## FAQ

**Can I customize the agents after installation?**
Yes. The generated files in `.claude/` are yours to edit — plain markdown. Edit agent personalities, adjust CI commands, add rules, create personas.

**Can I re-run setup?**
Run `npx specrails-core@latest init --root-dir <path>` again to re-scaffold, then `/setup`.

**Does this work without OpenSpec?**
Partially. Product discovery commands and individual agents work. `/sr:implement` and sr-architect rely on OpenSpec for structured design artifacts.

**Does this work without GitHub CLI?**
Yes. Local tickets are the default and need no external tools. `/sr:implement "description"` also works without `gh` — it just skips automated PR creation.

**Can I use local tickets and GitHub Issues together?**
Not simultaneously for the same project — backlog commands use one active provider at a time. You can migrate from GitHub Issues to local tickets using the [migration guide](./docs/migration-guide.md).

**How much does it cost to run?**
A full `/sr:implement` cycle for one feature typically costs a few dollars in Claude API usage. The sr-product-manager uses Opus; all other agents use Sonnet or Haiku.

**Does it work with private repos?**
Yes. Everything runs locally through Claude Code. No external services beyond the Claude API.

---

## Also in the SpecRails ecosystem

- **[specrails-hub](https://github.com/fjpulidop/specrails-hub)** — GUI for specrails-core. Manage your agents, run commands, and view pipeline results from a web interface.
- **[specrails.dev](https://specrails.dev)** — Official website and documentation.
- **Product Hunt** — [Vote for SpecRails on launch day](https://www.producthunt.com) _(link goes live on launch day — star this repo to get notified)_

---

## License

MIT — [fjpulidop](https://github.com/fjpulidop)
