# Getting Started with SpecRails + Codex

This guide gets you running SpecRails using OpenAI Codex as your AI agent. If you are using Claude Code instead, see the [standard installation guide](installation.md).

> **Beta**: Codex support is available in SpecRails 1.x as a beta feature. Core Skills work out of the box. See [Codex vs Claude Code](codex-vs-claude-code.md) for what is and is not supported.

---

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 18+ | Required for the installer |
| **Codex CLI** | Latest | `npm i -g @openai/codex` |
| **Git** | Any | Your project must be a git repository |

Optional but recommended:

| Tool | Why |
|------|-----|
| **GitHub CLI** (`gh`) | Automatic PR creation and Issue integration |

### Install Codex CLI

```bash
npm i -g @openai/codex
```

Verify the install:

```bash
codex --version
```

You need an OpenAI account with Codex access. Sign in with:

```bash
codex auth login
```

---

## Install SpecRails

Run the installer from inside your project directory:

```bash
cd your-project
npx specrails-core@latest init --root-dir .
```

The installer detects Codex CLI automatically and generates configuration in `.codex/` instead of `.claude/`.

### Flags

| Flag | Effect |
|------|--------|
| `--root-dir <path>` | Target directory (default: current directory) |
| `--yes` / `-y` | Skip confirmation prompts |

### What gets installed

```
your-project/
├── AGENTS.md                          # SpecRails agent instructions for Codex
└── .codex/
    ├── skills/                        # Workflow skills (/specrails:*, /opsx:*)
    ├── agents/                        # Agent definitions (TOML)
    ├── rules/                         # Per-layer coding conventions
    ├── agent-memory/                  # Persistent agent memory
    └── config.toml                    # Permissions and configuration
```

---

## Configure with enrich

After installation, open Codex and run the enrich skill:

```bash
codex
```

Then invoke the enrich skill:

```
/specrails:enrich
```

Or run it non-interactively:

```bash
codex exec "run /specrails:enrich --yes"
```

The wizard runs 5 phases:

| Phase | What happens |
|-------|-------------|
| **1. Analyze** | Detects your tech stack, architecture layers, and CI commands |
| **2. Personas** | Researches your domain and generates VPC user profiles |
| **3. Configure** | Asks about your backlog provider, git workflow, and agent selection |
| **4. Generate** | Fills all templates with your project-specific context |
| **5. Cleanup** | Removes setup files, leaving only your tailored workflow |

---

## Use your first skill

Once setup is complete, try generating a feature:

```bash
codex
```

```
/specrails:implement "add a health check endpoint"
```

Or with a GitHub issue number:

```
/specrails:implement #42
```

This runs the full SpecRails pipeline: Architect → Developer → Reviewer → PR.

---

## Codex Cloud (alternative)

If you prefer the web interface, SpecRails Skills also work in **Codex Cloud** at [chatgpt.com/codex](https://chatgpt.com/codex). Connect your repository and use Skills from the UI.

Note that Codex Cloud runs asynchronously — long-running skills like `/specrails:implement` are well-suited to this environment.

---

## Verify

Check that everything installed correctly:

```bash
# List generated agent configs
ls .codex/agents/

# List installed skills
ls .codex/skills/

# Check for unresolved placeholders (should return nothing)
grep -r '{{[A-Z_]*}}' .codex/agents/ .codex/skills/ 2>/dev/null

# Check the installed version
cat .specrails/specrails-version
```

---

## Troubleshooting

### "No AI CLI found"

Neither `claude` nor `codex` was found in your `PATH`. Install Codex CLI:

```bash
npm i -g @openai/codex
```

### Codex CLI not detected

The installer looks for `codex` in your `PATH`. If it is installed but not found, verify:

```bash
which codex
codex --version
```

If Codex is installed via a custom path, pass the provider explicitly:

```bash
npx specrails-core@latest init --root-dir . --provider codex
```

### Existing `.codex/` directory detected

The installer warns if SpecRails artifacts already exist. You can merge or abort to review manually.

### Placeholders not resolved

If you see `{{PLACEHOLDER}}` in generated files, `/specrails:enrich` did not complete. Re-run `/specrails:enrich` or fill the values manually.

---

[← Installation](installation.md) · [Codex vs Claude Code →](codex-vs-claude-code.md) · [CLI Reference →](cli-reference.md)
