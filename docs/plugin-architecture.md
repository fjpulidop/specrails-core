# Plugin Architecture

SpecRails is distributed as a **Claude Code plugin** (`sr`). This document explains what that means, how the plugin relates to your project, and the three available distribution channels.

## Two-layer model

SpecRails separates **logic** (the plugin) from **project data** (your repo).

```
┌─────────────────────────────────────┐
│         sr plugin (logic)           │
│  agents · skills · hooks · refs     │
│  updated via: claude plugin update  │
└────────────────┬────────────────────┘
                 │  /specrails:enrich generates
                 ▼
┌─────────────────────────────────────┐
│       .specrails/ (project data)    │
│  config · personas · rules · memory │
│  lives in your repo, yours to edit  │
└─────────────────────────────────────┘
```

### What lives in the plugin

The plugin contains everything that doesn't change per project:

| Component | Description |
|-----------|-------------|
| **Agent prompts** | sr-architect, sr-developer, sr-reviewer, sr-product-manager, and 10 more |
| **Skills** | OpenSpec skills (`/opsx:*`), workflow commands (`/specrails:*`) |
| **Hooks** | Pre/post-tool hooks for agent coordination |
| **References** | Agent reference docs, API patterns, test conventions |

You never edit these directly. To update them, run `claude plugin update sr`.

### What lives in your project (`.specrails/`)

`/specrails:enrich` generates ~8–10 files adapted to your specific codebase:

| File | Description |
|------|-------------|
| `config.yaml` | Stack overview, CI commands, git workflow, backlog provider |
| `personas/*.md` | VPC user personas — researched from your domain |
| `rules/*.md` | Per-layer coding conventions (backend, frontend, etc.) |
| `agent-memory/` | Persistent agent knowledge — grows across sessions |
| `pipeline/` | In-flight state for parallel feature builds |
| `CLAUDE.md` (root) | Project architecture reference for agents |

These files are committed to your repo. They are the "project intelligence" that makes agents adapt to your stack.

## Distribution channels

SpecRails supports three installation paths:

### 1. Claude Code plugin (recommended)

```bash
claude plugin install sr   # install
/specrails:enrich                 # configure for your project
claude plugin update sr    # update logic anytime
```

**Best for:** Most projects. No Node.js required. Plugin updates are one command and don't touch your project data.

### 2. Claude Code scaffold

```bash
npx specrails-core@latest init --root-dir .   # TUI agent selection + copy templates
/specrails:enrich --from-config               # AI analysis using your saved config
```

The scaffold copies the full agent+command set into `.claude/` — you own and version those files. The `init` command now includes a TUI installer that lets you select agents and model preset. Updates require re-running `npx` and re-running `/specrails:enrich`.

**Best for:** Teams that want to version the agent prompts themselves, or projects that need full offline control.

### 3. Codex project

```bash
npx specrails-core@latest init --root-dir .   # same as scaffold
codex                                          # open Codex
/specrails:enrich                             # configure
```

Codex does not support the Claude Code plugin system. Use the scaffold method.

**Best for:** OpenAI Codex CLI users.

## The `/specrails:enrich` wizard

`/specrails:enrich` is a 5-phase wizard that generates your project data. It runs once (or re-runs to regenerate).

| Phase | Output |
|-------|--------|
| **1. Analyze** | Detects stack, CI commands, architecture layers |
| **2. Personas** | Researches domain, generates VPC user personas |
| **3. Configure** | Backlog provider, git workflow, agent selection |
| **4. Generate** | Writes `.specrails/config.yaml`, personas, rules, CLAUDE.md |
| **5. Cleanup** | Removes wizard scaffolding |

Quick mode: `/specrails:enrich --quick` — three questions, done in under a minute.

From-config mode: `/specrails:enrich --from-config` — reads `.specrails/install-config.yaml` (written by the TUI installer) and runs non-interactively.

## OpenSpec skills

The `sr` plugin bundles the full OpenSpec skill set. These are available as `/opsx:*` commands:

| Skill | Purpose |
|-------|---------|
| `/opsx:ff` | Fast-forward through all change artifacts |
| `/opsx:apply` | Implement an OpenSpec change |
| `/opsx:verify` | Verify implementation matches spec |
| `/opsx:archive` | Archive a completed change |
| `/opsx:explore` | Explore ideas before writing a spec |

OpenSpec is the structured design layer that powers `/specrails:implement` — the architect uses it to produce a technical design before the developer begins coding.

## Updating

### Update plugin logic

```bash
claude plugin update sr
```

Updates agents, skills, hooks, and references. Does not touch `.specrails/` project data.

### Regenerate project data

```bash
/specrails:enrich
```

Re-runs the wizard and regenerates `.specrails/`. Useful when your stack changes significantly or you want to refresh personas.

---

[← Installation](installation.md) · [Core Concepts →](concepts.md)
