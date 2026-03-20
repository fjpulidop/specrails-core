# Installation

Install SpecRails into any git repository in two steps: run the installer, then run `/setup` inside Claude Code.

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 18+ | Required for the installer |
| **Claude Code** | Latest | The AI CLI that runs the agents — [install guide](https://docs.anthropic.com/en/docs/claude-code) |
| **Git** | Any | Your project must be a git repository |

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

The installer copies agent templates, commands, and configuration files into `.claude/` inside your project. It does not modify your existing code.

### Flags

| Flag | Effect |
|------|--------|
| `--root-dir <path>` | Target directory (default: current directory) |
| `--yes` / `-y` | Skip confirmation prompts |

### What gets installed

```
your-project/
└── .claude/
    ├── commands/setup.md         # The /setup wizard
    ├── setup-templates/          # Agent and command templates
    ├── web-manager/              # Pipeline Monitor dashboard (optional)
    └── security-exemptions.yaml  # Security scanner config
```

The installer also writes `.specrails-version` and `.specrails-manifest.json` to track the installed version.

## Configure with /setup

After installation, open Claude Code in your project and run the setup wizard:

```bash
claude    # open Claude Code
```

```
/setup
```

The wizard runs 5 phases:

| Phase | What happens |
|-------|-------------|
| **1. Analyze** | Detects your tech stack, architecture layers, and CI commands |
| **2. Personas** | Researches your domain and generates VPC user profiles |
| **3. Configure** | Asks about your backlog provider, git workflow, and agent selection |
| **4. Generate** | Fills all templates with your project-specific context |
| **5. Cleanup** | Removes setup files, leaving only your tailored workflow |

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

### Claude Code not found

Install Claude Code following [Anthropic's guide](https://docs.anthropic.com/en/docs/claude-code), then re-run the installer.

---

[Quick Start →](quick-start.md) · [CLI Reference →](cli-reference.md)
