# Getting Started

Get SpecRails running in your project in under 5 minutes.

## What is SpecRails?

SpecRails installs a **product-driven development workflow** into any repository. It gives Claude Code a team of **12 specialized AI agents** — an architect, developers, layer reviewers, a reviewer, a product manager — that work together to go from idea to shipped PR automatically.

Think of it as hiring a full engineering team that lives inside your CLI.

## Prerequisites

You only need two things:

- **Git** — your project must be a git repository
- **[Claude Code](https://claude.ai/claude-code)** — Anthropic's CLI tool

Optional (recommended):

- **npm** — for installing the Pipeline Monitor dashboard
- **[GitHub CLI](https://cli.github.com/)** (`gh`) — for automatic PR creation and issue tracking

## Install

Pick your preferred method:

**npx (recommended)**

```bash
npx specrails-core@latest init --root-dir <your-project>
```

**git clone**

```bash
git clone https://github.com/fjpulidop/specrails.git
./specrails/install.sh --root-dir <your-project>
```

The installer will:

1. Check your prerequisites
2. Copy templates and commands into `.claude/`
3. Initialize OpenSpec (if available)
4. Track the installed version for future updates

> **Note:** Run this from the repo where you want SpecRails — not from the SpecRails source repo itself.

## Run the Setup Wizard

Open Claude Code in your project and run:

```
/setup
```

The wizard walks you through 5 phases:

| Phase | What happens |
|-------|-------------|
| **1. Analyze** | Detects your tech stack, architecture layers, CI commands, and conventions |
| **2. Personas** | Researches your competitive landscape and generates user personas (VPC profiles) |
| **3. Configure** | Asks about your backlog provider, git workflow, and which agents/commands to enable |
| **4. Generate** | Fills all templates with your project-specific context |
| **5. Cleanup** | Removes the wizard and templates, leaving only your tailored workflow files |

After setup, your `.claude/` directory contains fully adapted agents, commands, and rules — ready to use.

## Your first feature

Let's implement something. Pick an issue from your backlog, or describe a feature:

```
/sr:implement "add a health check endpoint"
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

- `/sr:why "question"` — search agent explanation records in plain language. Ask why a design decision was made, why a library was chosen, or why a particular pattern is used. Agents record their reasoning as they work.
- `/sr:product-backlog` — see your prioritized backlog with safe implementation ordering. Good first stop before picking what to build next.
- `/sr:compat-check #N` — check whether an issue's implementation would break existing API consumers before you commit to it.

## What's next?

Now that you're running, learn how the system thinks:

- [Core Concepts](concepts.md) — understand the pipeline architecture and product-driven approach
- [Agents](agents.md) — meet each agent and understand their role
- [Workflows & Commands](workflows.md) — master the full command set

---

[← Back to Docs](README.md) · [Core Concepts →](concepts.md)
