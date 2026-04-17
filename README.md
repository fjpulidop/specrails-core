# specrails-core

[![npm version](https://img.shields.io/npm/v/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![GitHub Stars](https://img.shields.io/github/stars/fjpulidop/specrails-core?style=social)](https://github.com/fjpulidop/specrails-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm downloads](https://img.shields.io/npm/dw/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![Claude Code](https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet)](https://docs.anthropic.com/en/docs/claude-code)
[![Codex](https://img.shields.io/badge/Built%20for-OpenAI%20Codex-412991)](https://github.com/openai/codex)

**Your agentic development team. From idea to production code.**

One command turns your repo into a spec-driven pipeline with a team of specialized AI agents — architect, developers, reviewers, product manager — all adapted to your codebase.

```bash
npx specrails-core@latest init   # install into the current repo
/specrails:enrich                # optional: deep codebase analysis
```

> **Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex) (one of them), git, Node 18+.

---

## How it works

```
Idea  →  Architecture  →  Implementation  →  Review  →  PR
         (sr-architect)   (sr-developer)    (sr-reviewer)
```

Run `/specrails:implement "add dark mode"` — the pipeline designs, builds, reviews, and ships a pull request. No hand-holding.

Every artifact (agents, rules, personas) is generated **specifically for your project** by analysing your actual codebase, tech stack, and CI setup. Not generic templates.

---

## Quick start

```bash
# 1. Install into the current repo
npx specrails-core@latest init
```

The TUI asks you to pick a tier:

- **Quick** (default) — agents and commands installed straight to `.claude/`, ready to use immediately. No AI interaction.
- **Full** — same as Quick plus `/specrails:enrich` (5-phase deep analysis: stack detection, VPC personas, competitive research). ~5 min.

```bash
# 2. Optional — run enrich later if you picked Quick
/specrails:enrich

# 3. Start building
> /specrails:implement "add user authentication"
> /specrails:implement #1, #2          # from local tickets (default)
> /specrails:implement #42             # from GitHub Issues (if configured)
```

That's it. The pipeline takes over.

---

## What gets installed

Everything lands in your repo — nothing auto-updates, nothing phones home. You own it, you commit it.

| Category | Location | Purpose |
|----------|----------|---------|
| **Agents** | `.claude/agents/` | 14 specialised AI agents |
| **Commands** | `.claude/commands/specrails/` | 17 workflow commands (`/specrails:implement`, `/specrails:get-backlog-specs`, `/specrails:why`, …) |
| **OpenSpec skills** | `.claude/commands/opsx/` | `/opsx:*` commands for spec artefacts |
| **Config** | `.specrails/config.yaml` | Stack, CI commands, git workflow |
| **Personas** | `.specrails/personas/*.md` | VPC user profiles, generated from your users |
| **Rules** | `.specrails/rules/*.md` | Per-layer coding conventions |
| **Memory** | `.specrails/agent-memory/` | Persistent knowledge — agents learn across sessions |
| **Pipeline state** | `.specrails/pipeline/` | In-flight feature state for parallel builds |

To update, re-run the installer:

```bash
npx specrails-core@latest init
```

It refreshes the agents/commands while leaving your `.specrails/` data untouched.

---

## Why specrails

| | specrails | Plain Claude Code | Cursor / Copilot |
|---|---|---|---|
| Structured pipeline | ✅ Architect → Dev → Review → PR | ❌ Manual | ❌ Manual |
| Adapts to your codebase | ✅ Reads your real stack/CI | ⚠️ Prompts only | ❌ |
| Product-driven backlog | ✅ VPC persona scoring | ❌ | ❌ |
| Parallel feature builds | ✅ Git worktrees | ❌ | ❌ |
| Institutional memory | ✅ Agents learn across sessions | ❌ | ❌ |
| Open source | ✅ MIT | N/A | ❌ |

specrails is not a chat interface. It's a **development pipeline** that coordinates multiple specialised agents through your existing tools (GitHub Issues, JIRA, git, CI).

---

## The agents

| Agent | Model | Role |
|-------|-------|------|
| **sr-architect** | Sonnet | Designs features: proposal, technical design, task breakdown |
| **sr-developer** | Sonnet | Full-stack implementation |
| **sr-backend-developer** | Sonnet | Backend-specialised implementation |
| **sr-frontend-developer** | Sonnet | Frontend-specialised implementation |
| **sr-reviewer** | Sonnet | Quality gate: runs CI, fixes issues, records learnings |
| **sr-backend-reviewer** | Sonnet | Backend code review: API design, DB patterns, performance |
| **sr-frontend-reviewer** | Sonnet | Frontend code review: UX, accessibility, component design |
| **sr-test-writer** | Sonnet | Generates unit, integration, and e2e tests |
| **sr-security-reviewer** | Sonnet | Secrets detection, OWASP checks, dependency vulnerabilities |
| **sr-doc-sync** | Sonnet | Updates changelogs, READMEs, API docs |
| **sr-merge-resolver** | Sonnet | AI-powered merge conflict resolution for multi-feature pipelines |
| **sr-performance-reviewer** | Sonnet | Performance regression detection after implementation |
| **sr-product-manager** | Opus | Product discovery: competitive analysis, VPC evaluation |
| **sr-product-analyst** | Haiku | Read-only backlog analysis and prioritisation |

---

## Commands

### `/specrails:implement` — Build features

```bash
/specrails:implement "add dark mode"        # from a description
/specrails:implement #85, #71               # from tickets
/specrails:implement UI, Analytics          # explore areas, pick the best ideas
```

Architect designs → developer builds → reviewer validates → PR created. Multiple features run in parallel with git worktrees.

#### Dry-run / preview mode

Not ready to commit? Run the full pipeline without touching git or GitHub:

```bash
/specrails:implement "add dark mode" --dry-run
/specrails:implement #85 --preview            # --preview is an alias for --dry-run
```

All agents run normally. Generated files land in `.claude/.dry-run/<feature-name>/` instead of your working tree. No branches, commits, PRs, or issue updates are created.

When you're happy with the preview, apply the cached output:

```bash
/specrails:implement --apply add-dark-mode    # copies files to real paths, then ships
```

To discard without applying:

```bash
rm -rf .claude/.dry-run/add-dark-mode/
```

### `/specrails:get-backlog-specs` — View prioritised backlog

```bash
/specrails:get-backlog-specs                  # show all areas
/specrails:get-backlog-specs UI, Decks        # filter by area
```

Reads your tickets (local or GitHub Issues), scores by VPC persona match, recommends top 3 for the next sprint.

### `/specrails:auto-propose-backlog-specs` — Discover features

```bash
/specrails:auto-propose-backlog-specs             # explore all areas
/specrails:auto-propose-backlog-specs Analytics   # focus on one area
```

AI product discovery using your personas. Evaluates ideas, creates tickets (local or GitHub Issues) for the best ones.

---

## Local ticket management

specrails-core ships with a built-in ticket system — no GitHub account or external tools required.

Tickets live in `.specrails/local-tickets.json` alongside your code. They're plain JSON and git-friendly.

**Local tickets are the default.** The `/specrails:enrich` wizard skips GitHub/JIRA credential setup unless you opt in.

```bash
/specrails:implement #1, #4                # implement by ticket ID
/specrails:get-backlog-specs               # view prioritised backlog
/specrails:auto-propose-backlog-specs      # discover and create tickets with AI
/specrails:propose-spec                    # create a ticket from a spec proposal
```

See [docs/local-tickets.md](./docs/local-tickets.md) for the full schema reference, concurrency model, and command integration details.

Migrating from GitHub Issues or JIRA? See [docs/migration-guide.md](./docs/migration-guide.md).

---

## VPC persona scoring

Features are scored against your user personas using the Value Proposition Canvas framework:

```
+-----------------------------+    +-----------------------------+
|     VALUE PROPOSITION       |    |     CUSTOMER SEGMENT        |
|  Products & Services    <---+--->|  Customer Jobs              |
|  Pain Relievers         <---+--->|  Pains                      |
|  Gain Creators          <---+--->|  Gains                      |
+-----------------------------+    +-----------------------------+
```

Each persona scores features 0–5. Features are ranked by score / effort ratio. No gut-feel product decisions.

---

## Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| **Claude Code** or **Codex CLI** | Yes (one of them) | AI agent runtime |
| **git** | Yes | Repository detection |
| **Node 18+** | Yes | Needed for `npx specrails-core@latest init` |
| **GitHub CLI** (`gh`) | Optional | Backlog sync to GitHub Issues, PR creation. Not needed with local tickets. |
| **JIRA CLI** (`jira`) | Optional | Backlog sync to JIRA. Not needed with local tickets. |

The installer checks for prerequisites and offers to install missing ones.

---

## Supported stacks

Stack-agnostic. The `/specrails:enrich` wizard detects and adapts to whatever you're running:

- **Backend:** Python/FastAPI, Node/Express, Go/Gin, Rust/Actix, Java/Spring, Ruby/Rails, .NET
- **Frontend:** React, Vue, Angular, Svelte, Next.js, Nuxt
- **Database:** PostgreSQL, MySQL, SQLite, MongoDB, Redis
- **CI/CD:** GitHub Actions, GitLab CI, Jenkins, Makefile
- **Testing:** pytest, vitest, jest, go test, cargo test, rspec

---

## Design principles

1. **Local by default** — Everything lives in your repo. No cloud services, no telemetry, no phone home.
2. **Self-cleaning** — Installer scaffolding is removed after setup. Only final, project-specific files remain.
3. **Context-first** — Every generated file uses your real paths, patterns, and CI commands.
4. **Persona-driven** — Product decisions grounded in researched user personas, not assumptions.
5. **Institutional memory** — Agents learn across sessions. Reviewer learnings feed back to future developers.
6. **Parallel-safe** — Multiple features implemented simultaneously via git worktrees with automatic merge.

---

## FAQ

**Can I customise the agents after installation?**
Yes. Everything under `.claude/` and `.specrails/` is yours to edit — agent prompts, personas, rules, config. Commit what makes sense, gitignore what's transient.

**Can I re-run the wizard?**
Run `/specrails:enrich` again at any time to regenerate or update project data files. Re-running `npx specrails-core@latest init` refreshes the agents/commands without touching `.specrails/`.

**Does this work without GitHub CLI?**
Yes. Local tickets are the default and need no external tools. `/specrails:implement "description"` also works without `gh` — it just skips automated PR creation.

**Can I use local tickets and GitHub Issues together?**
Not simultaneously for the same project — backlog commands use one active provider at a time. You can migrate from GitHub Issues to local tickets using the [migration guide](./docs/migration-guide.md).

**How much does it cost to run?**
A full `/specrails:implement` cycle for one feature typically costs a few dollars in Claude API usage. The sr-product-manager uses Opus; all other agents use Sonnet or Haiku.

**Does it work with private repos?**
Yes. Everything runs locally through Claude Code (or Codex). No external services beyond the model API.

**How do I use specrails with Codex?**
Same install path: `npx specrails-core@latest init --root-dir .`. The TUI detects Codex and adjusts the agent configuration. See [docs/user-docs/getting-started-codex.md](./docs/user-docs/getting-started-codex.md).

---

## Related

- **[specrails-hub](https://github.com/fjpulidop/specrails-hub)** — desktop dashboard that visualises specrails pipelines (macOS, open source).
- **[specrails.dev](https://specrails.dev)** — landing page and documentation.

---

## Support

If specrails-core is useful to you, you can donate on [Ko-fi](https://ko-fi.com/D1D81Y002C) ☕ to support ongoing development.

[![Donate on Ko-fi](https://img.shields.io/badge/Donate-Ko--fi-FF5E5B?logo=kofi&logoColor=white&style=flat-square)](https://ko-fi.com/D1D81Y002C)

---

## License

MIT — [fjpulidop](https://github.com/fjpulidop)
