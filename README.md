# specrails-core

[![npm version](https://img.shields.io/npm/v/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**AI agent workflow system for [Claude Code](https://claude.ai/code).** Installs a complete product-driven development pipeline into any repository — 12 specialized agents, orchestration commands, persona-based product discovery, and per-layer coding conventions — all generated specifically for your codebase.

```bash
npx specrails-core@latest init --root-dir <your-project>
```

---

## The pipeline

```
Product Discovery  →  Architecture  →  Implementation  →  Review  →  Ship
(sr-product-manager)  (sr-architect)   (sr-developer)   (sr-reviewer)  (PR)
```

One command runs the full cycle:

```
/sr:implement #85, #71           # implement GitHub Issues
/sr:implement "add dark mode"    # implement from description
/sr:implement UI, Analytics      # explore areas, pick the best ideas
```

Multiple features run in parallel using git worktrees. Single features run sequentially.

---

## Quick start

**Step 1 — Install into your project**

```bash
npx specrails-core@latest init --root-dir /path/to/your/repo
```

The installer scaffolds temporary setup files into `.claude/` and checks prerequisites (Claude Code, git, npm, GitHub CLI).

**Step 2 — Run the setup wizard inside Claude Code**

```bash
cd /path/to/your/repo
claude          # open Claude Code
> /setup        # run the interactive setup wizard
```

Claude runs a 5-phase wizard that reads your actual codebase and generates everything tailored to your stack:

| Phase | What happens |
|-------|-------------|
| **1. Codebase Analysis** | Detects your stack, layers, CI commands, and coding conventions |
| **2. User Personas** | Researches your competitive landscape, generates VPC personas |
| **3. Configuration** | Choose backlog (GitHub Issues / JIRA / none), git workflow, agents |
| **4. File Generation** | Writes all agents, commands, rules — fully contextualized |
| **5. Cleanup** | Self-destructs scaffolding, only final files remain |

---

## What gets installed

| Category | Location | Description |
|----------|----------|-------------|
| **Agents** | `.claude/agents/*.md` | 12 specialized AI agents |
| **Personas** | `.claude/agents/personas/*.md` | VPC user profiles from competitive research |
| **Commands** | `.claude/commands/sr/*.md` | `/sr:implement`, `/sr:product-backlog`, `/sr:update-product-driven-backlog` |
| **Rules** | `.claude/rules/*.md` | Per-layer coding conventions, loaded by file path |
| **Memory** | `.claude/agent-memory/` | Persistent agent knowledge across sessions |
| **Config** | `.claude/settings.json`, `CLAUDE.md` | Permissions, project context, architecture reference |

---

## The 12 agents

| Agent | Model | Role |
|-------|-------|------|
| **sr-architect** | Sonnet | Designs features — proposal, technical design, task breakdown |
| **sr-developer** | Sonnet | Full-stack implementation from architect artifacts |
| **sr-backend-developer** | Sonnet | Backend-specialized implementation |
| **sr-frontend-developer** | Sonnet | Frontend-specialized implementation |
| **sr-reviewer** | Sonnet | Final quality gate — runs CI, fixes issues, records learnings |
| **sr-backend-reviewer** | Sonnet | API design, database patterns, performance review |
| **sr-frontend-reviewer** | Sonnet | UX patterns, accessibility, component design review |
| **sr-test-writer** | Sonnet | Generates unit, integration, and e2e tests |
| **sr-security-reviewer** | Sonnet | Secrets detection, OWASP checks, dependency audit |
| **sr-doc-sync** | Sonnet | Changelogs, READMEs, API docs after every change |
| **sr-product-manager** | Opus | Competitive analysis, VPC evaluation, feature ideation |
| **sr-product-analyst** | Haiku | Read-only backlog analysis and prioritization |

The `/sr:implement` pipeline routes tasks to the right agent automatically based on layer tags.

---

## Product discovery commands

### `/sr:product-backlog` — Prioritized backlog

Reads GitHub Issues labeled `product-driven-backlog`, scores them against your VPC personas, and recommends the top 3 for the next sprint.

```
/sr:product-backlog               # show all areas
/sr:product-backlog UI, Decks     # filter by area
```

### `/sr:update-product-driven-backlog` — Discover new features

Analyzes your codebase against each persona's jobs/pains/gains, generates new feature ideas, and creates GitHub Issues for the best ones.

```
/sr:update-product-driven-backlog             # explore all areas
/sr:update-product-driven-backlog Analytics   # focus on one area
```

---

## Value Proposition Canvas scoring

Every feature is evaluated against your user personas before implementation. Features score 0–5 per persona based on jobs-to-be-done, pains, and gains — ranked by score / effort ratio. Product decisions stay grounded in real user needs.

```
+-----------------------------+    +-----------------------------+
|     VALUE PROPOSITION       |    |     CUSTOMER SEGMENT        |
|                             |    |                             |
|  Products & Services    <---+--->|  Customer Jobs              |
|  Pain Relievers         <---+--->|  Pains                      |
|  Gain Creators          <---+--->|  Gains                      |
+-----------------------------+    +-----------------------------+
```

---

## Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| **Claude Code** | Yes | AI agent runtime — [install](https://docs.anthropic.com/en/docs/claude-code) |
| **Git** | Yes | Repository detection |
| **npm** | Recommended | Install OpenSpec CLI |
| **OpenSpec CLI** | Recommended | Spec-driven design workflow |
| **GitHub CLI** (`gh`) | Optional | Backlog sync and PR creation |
| **JIRA CLI** | Optional | JIRA as backlog alternative |

The installer checks for each tool and offers to install missing ones automatically.

> You only need one backlog provider. If you use neither, `/sr:implement "description"` still works.

---

## Supported stacks

specrails-core is stack-agnostic — the setup wizard reads your actual files and generates accurate conventions, not generic templates.

- **Backend**: Python/FastAPI, Node/Express, Go/Gin, Rust/Actix, Java/Spring, Ruby/Rails, .NET
- **Frontend**: React, Vue, Angular, Svelte, Next.js, Nuxt
- **Database**: PostgreSQL, MySQL, SQLite, MongoDB, Redis
- **CI/CD**: GitHub Actions, GitLab CI, Jenkins, Makefile
- **Testing**: pytest, vitest, jest, go test, cargo test, rspec

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
Yes. Files in `.claude/` are plain markdown — edit agent personalities, adjust CI commands, add rules, create personas.

**How do I customize an agent's personality?**
Each agent template (`sr-architect`, `sr-developer`, `sr-reviewer`) includes a `## Personality` section with four configurable settings:

| Setting | Options | What it controls |
|---|---|---|
| `tone` | `terse` / `verbose` | How much explanation the agent includes in its output |
| `risk_tolerance` | `conservative` / `aggressive` | How cautious the agent is when making decisions |
| `detail_level` | `summary` / `full` | Granularity of output artifacts and reports |
| `focus_areas` | comma-separated keywords | Areas the agent prioritizes (e.g. `security, performance`) |

After running `/setup`, edit `.claude/agents/sr-architect.md` (or `sr-developer.md` / `sr-reviewer.md`) and change the values inline. Existing setups without a `## Personality` section continue to work unchanged — defaults apply.

**Can I re-run setup?**
Run `npx specrails-core@latest init --root-dir <path>` again to re-scaffold, then `/setup`.

**Does this work without OpenSpec?**
Partially. `/sr:implement` and sr-architect use OpenSpec for structured design artifacts. Product discovery commands and individual agents work without it.

**Does this work without GitHub CLI?**
Yes. If you use GitHub Issues, `gh` is needed for backlog commands. Otherwise use JIRA, skip backlog entirely, or use `/sr:implement "description"` without a PR step.

**How much does it cost?**
The sr-product-manager (Opus) is the most expensive agent. All others use Sonnet or Haiku. A full `/sr:implement` cycle for one feature typically costs a few dollars through Claude Code.

---

## License

MIT
