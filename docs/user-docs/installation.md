# Installation

Install SpecRails into any git repository in two steps: run the installer, then run `/setup` inside your AI CLI.

SpecRails supports both **Claude Code** and **OpenAI Codex**. The installer detects which CLI you have and configures accordingly. See [Codex vs Claude Code](codex-vs-claude-code.md) for a feature comparison.

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 18+ | Required for the installer |
| **Claude Code** | Latest | Stable — [install guide](https://docs.anthropic.com/en/docs/claude-code) |
| **Codex CLI** | Latest | Beta — `npm i -g @openai/codex` |
| **Git** | Any | Your project must be a git repository |

You need at least one of Claude Code or Codex CLI. If both are installed, the installer uses Claude Code by default. Override with `--provider codex` (or the env var `CLI_PROVIDER=codex`).

Optional but recommended:

| Tool | Why |
|------|-----|
| **GitHub CLI** (`gh`) | Automatic PR creation and Issue integration |

## Install

Run the installer from inside your project directory:

```bash
cd your-project
npx specrails-core@latest init --root-dir .
```

The installer copies agent templates, skills, and configuration files into `.claude/` (Claude Code) or `.codex/` (Codex). It does not modify your existing code.

### Flags

| Flag | Effect |
|------|--------|
| `--root-dir <path>` | Target directory (default: current directory) |
| `--yes` / `-y` | Skip confirmation prompts |
| `--provider <claude\|codex>` | Force a specific AI CLI (default: auto-detect) |

You can also force a specific provider:

```bash
npx specrails-core@latest init --root-dir . --provider codex
```

Alternatively, use the `CLI_PROVIDER` env var (legacy):

```bash
CLI_PROVIDER=codex npx specrails-core@latest init --root-dir .
```

### What gets installed

**Claude Code:**

```
your-project/
└── .claude/
    ├── commands/setup.md         # The /setup wizard
    ├── skills/                   # Workflow skills (/sr:*, /opsx:*)
    ├── agents/                   # Agent definitions
    ├── rules/                    # Per-layer coding conventions
    └── settings.json             # Permissions
```

**Codex (beta):**

```
your-project/
├── AGENTS.md                     # SpecRails agent instructions for Codex
└── .codex/
    ├── skills/                   # Workflow skills (/sr:*, /opsx:*)
    ├── agents/                   # Agent definitions (TOML)
    ├── rules/                    # Per-layer coding conventions
    └── config.toml               # Permissions
```

The installer also writes `.specrails-version` and `.specrails-manifest.json` to track the installed version.

## Configure with /setup

After installation, open your AI CLI in your project and run the setup wizard:

```bash
claude    # Claude Code
# or
codex     # Codex
```

```
/setup
```

By default, `/setup` runs the full 5-phase wizard:

| Phase | What happens |
|-------|-------------|
| **1. Analyze** | Detects your tech stack, architecture layers, and CI commands |
| **2. Personas** | Researches your domain and generates VPC user profiles |
| **3. Configure** | Asks about your backlog provider, git workflow, and agent selection |
| **4. Generate** | Fills all templates with your project-specific context |
| **5. Cleanup** | Removes setup files, leaving only your tailored workflow |

**In a hurry?** Run `/setup --lite` instead — three questions, sensible defaults, done in under a minute.

After setup, `.claude/` contains fully configured agents and commands ready to use. The `/setup` command removes itself — it only runs once.

## Verify

Check that everything installed correctly:

```bash
# List generated agents
ls .claude/agents/

# Check for unresolved placeholders (should return nothing)
grep -r '{{[A-Z_]*}}' .claude/agents/ .claude/commands/ .claude/rules/

# Check the installed version
cat .specrails-version
```

## Troubleshooting

### "This appears to be the specrails source repository"

You ran the installer from inside the SpecRails source repo. Run it from your target project instead:

```bash
cd /path/to/your-project
npx specrails-core@latest init --root-dir .
```

### Existing `.claude/` directory detected

The installer warns if SpecRails artifacts already exist. You can merge (install alongside existing files) or abort to review manually.

### Placeholders not resolved

If you see `{{PLACEHOLDER}}` in generated files, the `/setup` wizard did not complete. Re-run `/setup` or fill the values manually.

### "No Claude API key configured"

Claude Code supports two authentication modes:

- **OAuth** — the default for new installs (`claude auth login`). No API key appears in `claude config`.
- **API key** — explicit key set via `claude config set api_key <key>` or `ANTHROPIC_API_KEY`.

If you authenticated via OAuth, the installer's prerequisite check still fails even though Claude Code is working. Bypass it with:

```bash
SPECRAILS_SKIP_PREREQS=1 npx specrails-core@latest init --root-dir .
```

Or set an API key explicitly if you prefer:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx specrails-core@latest init --root-dir .
```

### Claude Code not found

Install Claude Code following [Anthropic's guide](https://docs.anthropic.com/en/docs/claude-code), then re-run the installer.

### Codex CLI not found

Install Codex CLI and re-run:

```bash
npm i -g @openai/codex
```

Or force the provider if Codex is installed at a non-standard path:

```bash
npx specrails-core@latest init --root-dir . --provider codex
```

---

[← Getting Started](../getting-started.md) · [Quick Start →](quick-start.md) · [Getting Started (Codex) →](getting-started-codex.md) · [CLI Reference →](cli-reference.md)
