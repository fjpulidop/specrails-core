# Getting Started

Get SpecRails running in your project in under 5 minutes.

## What is SpecRails?

SpecRails installs a **product-driven development workflow** into any repository. It gives Claude Code a team of **12 specialized AI agents** — an architect, developers, layer reviewers, a reviewer, a product manager — that work together to go from idea to shipped PR automatically.

Think of it as hiring a full engineering team that lives inside your CLI.

## Prerequisites

You need:

- **Git** — your project must be a git repository
- **[Claude Code](https://claude.ai/claude-code)** — Anthropic's CLI tool

Optional (recommended):

- **[GitHub CLI](https://cli.github.com/)** (`gh`) — for automatic PR creation and issue tracking

> **Using OpenAI Codex instead of Claude Code?** See [getting-started-codex.md](user-docs/getting-started-codex.md) for Codex-specific setup.

## Install

**Plugin method (recommended) — no Node.js required**

```bash
claude plugin install sr
```

**Scaffold method (for Codex users or full offline control)**

```bash
npx specrails-core@latest init --root-dir <your-project>
```

See [installation.md](installation.md) for full details on both methods and when to use each.

## Run the Setup Wizard

Open Claude Code in your project and run:

```
/specrails:setup
```

By default, `/specrails:setup` runs the **full 5-phase wizard** — deep stack analysis, researched user personas, and fully adapted agents.

| Phase | What happens |
|-------|-------------|
| **1. Analyze** | Detects your tech stack, architecture layers, CI commands, and conventions |
| **2. Personas** | Researches your competitive landscape and generates full VPC user personas |
| **3. Configure** | Asks about your backlog provider, git workflow, and which agents to enable |
| **4. Generate** | Generates your project data files (`.specrails/`) with project-specific context |
| **5. Cleanup** | Removes the wizard scaffolding, leaving only your tailored workflow files |

**In a hurry?** Run `/specrails:setup --lite` for the quick version: three questions, sensible defaults, done in under a minute.

| Question | What it configures |
|----------|-------------------|
| What is this project? | Agent context and CLAUDE.md |
| Who are the target users? | Persona stubs for product discovery |
| Git access — read-only or read-write? | Whether agents can commit |

Lite mode installs the four core agents (architect, developer, reviewer, product manager), all workflow commands, and local ticket storage. You can run the full wizard later to deepen the configuration.

After either mode, your project data files are ready to use and your `/specrails:*` commands are live.

## Your first feature

Let's implement something. Pick an issue from your backlog, or describe a feature:

```
/specrails:implement "add a health check endpoint"
```

SpecRails will:

1. **Architect** analyzes the request and designs the implementation
2. **Developer** writes the code across all layers
3. **Test Writer** generates tests for the new code
4. **Doc Sync** updates your changelog and docs
5. **Security Reviewer** scans for secrets and vulnerabilities
6. **Reviewer** runs your full CI suite and fixes any issues
7. Creates a **Pull Request** ready for human review

That's it. One command, full pipeline.

## Useful commands for newcomers

Once you have a feature running, a few commands help you understand what's happening and why:

- `/specrails:why "question"` — search agent explanation records in plain language. Ask why a design decision was made, why a library was chosen, or why a particular pattern is used. Agents record their reasoning as they work.
- `/specrails:product-backlog` — see your prioritized backlog with safe implementation ordering. Good first stop before picking what to build next.
- `/specrails:compat-check #N` — check whether an issue's implementation would break existing API consumers before you commit to it.

## What's next?

Now that you're running, learn how the system thinks:

- [Core Concepts](concepts.md) — understand the pipeline architecture and product-driven approach
- [Agents](agents.md) — meet each agent and understand their role
- [Workflows & Commands](workflows.md) — master the full command set

---

**Looking for step-by-step guides?** See [Quick Start](user-docs/quick-start.md) for a walkthrough of your first feature, or [Installation](user-docs/installation.md) for detailed install options including Codex support.

[← Back to Docs](README.md) · [Core Concepts →](concepts.md)
