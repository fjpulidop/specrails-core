# specrails

**Agent Workflow System installer for Claude Code.**

Install a complete product-driven development workflow into any repository: specialized AI agents, orchestration commands, VPC-based product discovery, and per-layer coding conventions — all adapted to your codebase automatically.

## What it does

specrails gives your project a team of specialized AI agents that work together through a structured pipeline:

```
Product Discovery  →  Architecture  →  Implementation  →  Review  →  Ship
(product-manager)     (architect)       (developer)       (reviewer)   (PR)
```

Every artifact — agents, commands, rules, personas — is generated specifically for your project by analyzing your actual codebase, tech stack, and target users. Not generic templates: fully contextualized to your architecture, CI pipeline, and coding conventions.

## What gets installed

| Category | Files | Purpose |
|----------|-------|---------|
| **Agents** | `.claude/agents/*.md` | Specialized AI agents (architect, developer, reviewer, product-manager, product-analyst, and optional layer-specific developers) |
| **Personas** | `.claude/agents/personas/*.md` | Value Proposition Canvas profiles for your target users, generated from competitive research |
| **Commands** | `.claude/commands/*.md` | Workflow orchestrators (`/implement`, `/product-backlog`, `/update-product-driven-backlog`) |
| **Rules** | `.claude/rules/*.md` | Per-layer coding conventions, loaded conditionally by file path |
| **Memory** | `.claude/agent-memory/` | Persistent knowledge directories — agents learn across sessions |
| **Config** | `.claude/settings.json`, `CLAUDE.md` | Permissions, project context, architecture reference |

## How it works

Installation happens in two steps — a shell script for scaffolding, then Claude for the intelligent parts.

### Step 1: Install (shell script)

```bash
./specrails/install.sh
```

The installer:

1. **Checks prerequisites** — git, Claude Code CLI, npm, OpenSpec CLI, GitHub CLI
2. **Offers to install missing tools** — npm via nvm, OpenSpec via npm
3. **Detects existing setup** — warns if `.claude/` or `openspec/` already exist
4. **Scaffolds temporary files** — copies templates and the `/setup` command into `.claude/`

### Step 2: Setup (inside Claude Code)

```bash
claude     # open Claude Code in your repo
> /setup   # run the setup wizard
```

Claude runs an interactive 5-phase wizard:

| Phase | What happens | Interaction |
|-------|-------------|-------------|
| **1. Codebase Analysis** | Reads your repo structure, detects stack, layers, CI commands, and coding conventions | Confirm or modify detected architecture |
| **2. User Personas** | Asks who your target users are, researches the competitive landscape online, generates full VPC personas | Describe your users, approve generated personas |
| **3. Configuration** | Choose backlog provider (GitHub Issues / JIRA / none), access mode (read/write or read-only), git workflow (auto or manual), agents, and commands | Select options |
| **4. File Generation** | Fills all templates with your project's context and writes final files | Automatic |
| **5. Cleanup** | Removes scaffolding (`/setup` command, templates), adds `specrails/` to `.gitignore` | Confirm cleanup |

After setup, the scaffolding self-destructs — only the final, project-specific files remain.

## Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| **Git** | Yes | Repository detection |
| **Claude Code** | Yes | AI agent runtime — [install](https://docs.anthropic.com/en/docs/claude-code) |
| **npm** | Recommended | Needed to install OpenSpec CLI |
| **OpenSpec CLI** | Recommended | Spec-driven design workflow (`/opsx:ff`, `/opsx:apply`) |
| **GitHub CLI** (`gh`) | Optional | Backlog sync to GitHub Issues, PR creation |
| **JIRA CLI** (`jira`) | Optional | Backlog sync to JIRA (alternative to GitHub Issues) |

The installer will check for each tool and offer to install missing ones.

> **Note:** You only need one backlog provider — GitHub Issues or JIRA. The `/setup` wizard asks which one you use. If you don't use either, backlog commands are skipped but `/implement "description"` still works.

## Usage after installation

Once setup is complete, you have three main commands:

### `/implement` — Build features

The full pipeline: architect designs, developer implements, reviewer validates, then ships a PR.

```
/implement #85, #71           # implement specific GitHub Issues
/implement "add dark mode"     # implement from a text description
/implement UI, Analytics       # explore areas and pick the best ideas
```

Handles 1 to N features. Single features run sequentially; multiple features run in parallel using git worktrees.

### `/product-backlog` — View prioritized backlog

Reads GitHub Issues labeled `product-driven-backlog`, sorts by VPC persona score, and recommends the top 3 for the next sprint.

```
/product-backlog               # show all areas
/product-backlog UI, Decks     # filter by area
```

### `/update-product-driven-backlog` — Discover new features

Runs product discovery using your VPC personas. Analyzes the codebase, evaluates ideas against each persona's jobs/pains/gains, and creates GitHub Issues for the best ones.

```
/update-product-driven-backlog            # explore all areas
/update-product-driven-backlog Analytics  # focus on one area
```

## The agents

| Agent | Model | Role |
|-------|-------|------|
| **Architect** | Sonnet | Designs features: creates proposal, technical design, task breakdown, and context bundles via OpenSpec |
| **Developer** | Sonnet | Implements features: reads the architect's artifacts and writes production code across all layers |
| **Backend Developer** | Sonnet | Specialized backend implementation (lighter prompt, backend-only CI) |
| **Frontend Developer** | Sonnet | Specialized frontend implementation (lighter prompt, frontend-only CI) |
| **Reviewer** | Sonnet | Final quality gate: runs exact CI checks, fixes issues, records learnings for future developers |
| **Product Manager** | Opus | Product discovery: competitive analysis, VPC evaluation, feature ideation |
| **Product Analyst** | Haiku | Read-only backlog analysis: prioritization, gap analysis, reporting |

The `/implement` pipeline automatically routes tasks to the right developer agent based on layer tags in the task breakdown.

## Value Proposition Canvas (VPC)

Every feature idea is evaluated against your project's user personas using the VPC framework:

```
+-----------------------------+    +-----------------------------+
|     VALUE PROPOSITION       |    |     CUSTOMER SEGMENT        |
|                             |    |                             |
|  Products & Services    <---+--->|  Customer Jobs              |
|  Pain Relievers         <---+--->|  Pains                      |
|  Gain Creators          <---+--->|  Gains                      |
+-----------------------------+    +-----------------------------+
```

Each persona scores features 0-5 based on how well they address their specific jobs, pains, and gains. Features are ranked by total persona score / effort ratio. This grounds every product decision in real user needs rather than gut feeling.

## Project structure

```
specrails/
├── install.sh                              # Step 1: shell installer
├── README.md                               # This file
├── commands/
│   └── setup.md                            # Step 2: Claude Code /setup wizard
├── templates/                              # Structural references for file generation
│   ├── agents/
│   │   ├── architect.md                    # Design & task breakdown agent
│   │   ├── developer.md                    # Full-stack implementation agent
│   │   ├── backend-developer.md            # Backend-specialized agent
│   │   ├── frontend-developer.md           # Frontend-specialized agent
│   │   ├── reviewer.md                     # CI/CD quality gate agent
│   │   ├── product-manager.md              # Product discovery agent
│   │   └── product-analyst.md              # Read-only analysis agent
│   ├── commands/
│   │   ├── implement.md                    # Implementation pipeline orchestrator
│   │   ├── product-backlog.md              # Backlog viewer with VPC scoring
│   │   └── update-product-driven-backlog.md # Product discovery & issue sync
│   ├── personas/
│   │   └── persona.md                      # VPC persona template
│   ├── rules/
│   │   └── layer.md                        # Per-layer convention template
│   ├── claude-md/
│   │   └── root.md                         # Root CLAUDE.md template
│   └── settings/
│       └── settings.json                   # Permission template
└── prompts/
    ├── analyze-codebase.md                 # Guide for codebase analysis
    ├── generate-personas.md                # Guide for VPC persona generation
    └── infer-conventions.md                # Guide for convention detection
```

## Supported stacks

specrails is stack-agnostic. The `/setup` wizard detects and adapts to whatever you're using:

- **Backend**: Python/FastAPI, Node/Express, Go/Gin, Rust/Actix, Java/Spring, Ruby/Rails, .NET
- **Frontend**: React, Vue, Angular, Svelte, Next.js, Nuxt
- **Database**: PostgreSQL, MySQL, SQLite, MongoDB, Redis
- **CI/CD**: GitHub Actions, GitLab CI, Jenkins, Makefile
- **Testing**: pytest, vitest, jest, go test, cargo test, rspec

The setup wizard reads your actual CI config, dependency files, and source code to generate accurate conventions — not guesses.

## Design principles

1. **Two-step install**: Shell for prerequisites, Claude for intelligence. No API keys needed beyond Claude Code auth.
2. **Self-cleaning**: All scaffolding artifacts are removed after setup. Only final files remain.
3. **Context-first**: Every generated file references real paths, real patterns, and real CI commands from your codebase.
4. **Persona-driven**: Product decisions are grounded in researched user personas, not assumptions.
5. **Institutional memory**: Agents learn across sessions via persistent memory directories. The reviewer's learnings feed back to developers.
6. **Parallel-safe**: Multiple features can be implemented simultaneously using git worktrees with automatic merge.

## FAQ

**Can I customize the agents after installation?**
Yes. The generated files in `.claude/` are yours to edit. They're plain markdown — modify agent personalities, adjust CI commands, add new rules, or create new personas.

**Can I re-run setup?**
The `/setup` command deletes itself after completion. To re-run, execute `install.sh` again to re-scaffold, then run `/setup`.

**Does this work without OpenSpec?**
Partially. The `/implement` command and architect agent rely on OpenSpec for structured design artifacts. Without it, you can still use the product discovery commands and individual agents directly.

**Does this work without GitHub CLI?**
Yes, with limitations. If you use GitHub Issues as your backlog provider, `gh` is needed for backlog commands. But you can use JIRA instead, or skip backlog commands entirely. The `/implement` command still works with text descriptions — it just skips PR creation and tells you to create it manually.

**Can I use JIRA instead of GitHub Issues?**
Yes. During `/setup` Phase 3, choose "JIRA" as your backlog provider. If the JIRA CLI isn't installed, the wizard offers to install it (go-jira via brew, or REST API mode with no CLI needed). You'll also choose whether access is read & write (create tickets, add comments on completion) or read-only (read tickets for context but never modify JIRA).

**Can I skip automatic git operations?**
Yes. During `/setup` Phase 3, choose "Manual" for the git workflow. The pipeline will still architect, develop, and review — but it stops after review and shows you a summary of all changes. You handle branching, committing, and PRs yourself.

**How much does it cost to run?**
Depends on usage. The product-manager agent uses Opus (most capable, most expensive) for deep product thinking. All other agents use Sonnet or Haiku. A full `/implement` cycle for one feature typically costs a few dollars in API usage through Claude Code.

## License

MIT
