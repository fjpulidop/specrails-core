# Installation

Install SpecRails into any git repository in two steps: install, then run `/specrails:setup` inside your AI CLI.

SpecRails supports both **Claude Code** and **OpenAI Codex**. The installer detects which CLI you have and configures accordingly. See [Codex vs Claude Code](codex-vs-claude-code.md) for a feature comparison.

> **Looking for the comprehensive reference?** See [Installation & Setup](../installation.md) for full wizard phase details and advanced configuration.

## Requirements

### Plugin method (recommended)

| Tool | Version | Notes |
|------|---------|-------|
| **Claude Code** | Latest | [install guide](https://docs.anthropic.com/en/docs/claude-code) |
| **Git** | Any | Your project must be a git repository |

No Node.js required.

### Scaffold method (npx / Codex)

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 18+ | Required for the installer |
| **Claude Code** or **Codex CLI** | Latest | See [Codex vs Claude Code](codex-vs-claude-code.md) |
| **Git** | Any | Your project must be a git repository |

Optional but recommended (both methods):

| Tool | Why |
|------|-----|
| **GitHub CLI** (`gh`) | Automatic PR creation and Issue integration |

## Install

### Plugin method (Claude Code)

```bash
claude plugin install sr
```

No cloning, no npm, nothing else. The plugin is now ready in all your Claude Code sessions.

To update later: `claude plugin update sr`

### Scaffold method (Claude Code or Codex)

Run from inside your project directory:

```bash
cd your-project
npx specrails-core@latest init --root-dir .
```

The installer copies templates and commands into `.claude/` (Claude Code) or `.codex/` (Codex). It does not modify your existing code.

#### Flags

| Flag | Effect |
|------|--------|
| `--root-dir <path>` | Target directory (default: current directory) |
| `--yes` / `-y` | Skip confirmation prompts |
| `--provider <claude\|codex>` | Force a specific AI CLI (default: auto-detect) |

#### What gets installed (scaffold method)

**Claude Code:**

```
your-project/
└── .claude/
    ├── commands/specrails/setup.md      # The /specrails:setup wizard
    ├── skills/                   # Workflow skills (/specrails:*, /opsx:*)
    ├── agents/                   # Agent definitions
    ├── rules/                    # Per-layer coding conventions
    └── settings.json             # Permissions
```

**Codex (beta):**

```
your-project/
├── AGENTS.md                     # SpecRails agent instructions for Codex
└── .codex/
    ├── skills/                   # Workflow skills (/specrails:*, /opsx:*)
    ├── agents/                   # Agent definitions (TOML)
    ├── rules/                    # Per-layer coding conventions
    └── config.toml               # Permissions
```

The installer also writes `.specrails-version` and `.specrails-manifest.json` to track the installed version.

## Configure with /specrails:setup

After either installation method, open your AI CLI in your project and run:

```bash
claude    # Claude Code
# or
codex     # Codex
```

```
/specrails:setup
```

By default, `/specrails:setup` runs the full 5-phase wizard:

| Phase | What happens |
|-------|-------------|
| **1. Analyze** | Detects your tech stack, architecture layers, and CI commands |
| **2. Personas** | Researches your domain and generates VPC user profiles |
| **3. Configure** | Asks about your backlog provider, git workflow, and agent selection |
| **4. Generate** | Generates project data files (`.specrails/` or `.claude/`) with your context |
| **5. Cleanup** | Removes setup scaffolding, leaving only your tailored workflow |

**In a hurry?** Run `/specrails:setup --lite` instead — three questions, sensible defaults, done in under a minute.

## Verify

Check that everything installed correctly:

```bash
# Plugin method: check project data was generated
ls .specrails/

# Scaffold method: list generated agents
ls .claude/agents/

# Scaffold method: check for unresolved placeholders (should return nothing)
grep -r '{{[A-Z_]*}}' .claude/agents/ .claude/commands/ .claude/rules/

# Scaffold method: check the installed version
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

If you see `{{PLACEHOLDER}}` in generated files (scaffold method), the `/specrails:setup` wizard did not complete. Re-run `/specrails:setup` or fill the values manually.

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
