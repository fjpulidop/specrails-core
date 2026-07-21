# Installation

Install SpecRails into any git repository in two steps: install, then run the
provider-native enrich workflow. The scaffold supports Claude Code, Codex CLI,
Gemini CLI, and Kimi Code.

> **Looking for the comprehensive reference?** See [Installation & Setup](../installation.md) for full wizard phase details and advanced configuration.

## Requirements

### Plugin method (recommended)

| Tool | Version | Notes |
|------|---------|-------|
| **Claude Code** | Latest | [install guide](https://docs.anthropic.com/en/docs/claude-code) |
| **Git** | Any | Your project must be a git repository |

No Node.js required.

### Scaffold method (npx / any provider)

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 20.19.0+ | Required for the installer and pinned OpenSpec 1.4.1 CLI |
| **Supported AI CLI** | Latest compatible version | Claude Code, Codex, Gemini, or Kimi 0.27.0+ |
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

### Scaffold method (Claude, Codex, Gemini, or Kimi)

Run from inside your project directory:

```bash
cd your-project
npx specrails-core@latest init --root-dir .
```

The installer copies provider-native artifacts into `.claude/`, `.codex/`,
`.gemini/`, or `.kimi-code/`. It does not modify your application source.

#### Flags

| Flag | Effect |
|------|--------|
| `--root-dir <path>` | Target directory (default: current directory) |
| `--yes` / `-y` | Skip confirmation prompts |
| `--provider <claude\|codex\|gemini\|kimi>` | Force a specific AI CLI (default: auto-detect) |

#### What gets installed (scaffold method)

**Claude Code:**

```
your-project/
└── .claude/
    ├── commands/specrails/enrich.md     # The /specrails:enrich wizard
    ├── skills/                   # Workflow skills (/specrails:*, /opsx:*)
    ├── agents/                   # Agent definitions
    ├── rules/                    # Per-layer coding conventions
    └── settings.json             # Permissions
```

**Kimi Code:**

```text
your-project/
└── .kimi-code/
    ├── AGENTS.md
    ├── mcp.json
    ├── personas/
    ├── rules/
    ├── specrails/
    │   ├── run-skill.mjs
    │   └── vendor/js-yaml/       # Managed parser + MIT license/provenance
    └── skills/
        ├── specrails-*/SKILL.md
        ├── openspec-*/SKILL.md
        └── sr-*/SKILL.md
```

Kimi discovers only direct children of `.kimi-code/skills`, so workflows,
OpenSpec skills, managed `sr-*` roles, and user `custom-*` roles all live at
that level rather than inside a `rails/` grouping directory. Non-skill persona
data and the managed headless runner live outside the scanner root.

See [Getting Started with Kimi](getting-started-kimi.md) for installation,
login, models, effort, sessions, and headless execution details.

**Codex (beta):**

```text
your-project/
├── AGENTS.md                     # SpecRails agent instructions for Codex
└── .codex/
    ├── skills/                   # Workflow skills (/specrails:*, /opsx:*)
    ├── agents/                   # Agent definitions (TOML)
    ├── rules/                    # Per-layer coding conventions
    └── config.toml               # Permissions
```

The installer also writes `.specrails/specrails-version` and `.specrails/specrails-manifest.json` to track the installed version.

## Configure with /specrails:enrich

After either installation method, open your AI CLI in your project and run:

```bash
claude    # Claude Code
# or
codex     # Codex
# or
gemini    # Gemini CLI
# or
kimi      # Kimi Code
```

Claude and Gemini:

```
/specrails:enrich
```

Kimi:

```text
/skill:specrails-enrich
```

By default, `/specrails:enrich` runs the full 5-phase wizard:

| Phase | What happens |
|-------|-------------|
| **1. Analyze** | Detects your tech stack, architecture layers, and CI commands |
| **2. Personas** | Researches your domain and generates VPC user profiles |
| **3. Configure** | Asks about your backlog provider, git workflow, and agent selection |
| **4. Generate** | Generates project data files (`.specrails/` or `.claude/`) with your context |
| **5. Cleanup** | Removes setup scaffolding, leaving only your tailored workflow |

**In a hurry?** Run `/specrails:enrich --quick` instead — three questions, sensible defaults, done in under a minute.

**Already ran the TUI installer?** If you used `npx specrails-core@latest init` and completed the TUI agent selection, run `/specrails:enrich --from-config` to apply your saved configuration without re-answering the prompts.

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
cat .specrails/specrails-version
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

If you see `{{PLACEHOLDER}}` in generated files (scaffold method), the `/specrails:enrich` wizard did not complete. Re-run `/specrails:enrich` or fill the values manually.

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
