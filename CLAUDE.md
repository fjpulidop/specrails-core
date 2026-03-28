# specrails-core

Agent Workflow System installer for Claude Code. Installs a complete product-driven development workflow into any repository: specialized AI agents, orchestration commands, VPC-based product discovery, and per-layer coding conventions — all adapted to the target codebase automatically.

## Stack

| Layer | Tech |
|-------|------|
| Installer | Bash (install.sh) |
| Templates | Markdown with `{{PLACEHOLDER}}` substitution |
| Commands | Claude Code slash commands (Markdown) |
| Prompts | Markdown guide prompts |
| Spec system | OpenSpec (YAML + Markdown) |

## Repo layout

```
specrails-core/
├── install.sh              # Shell installer
├── README.md               # Documentation
├── templates/              # Source templates for agents, commands, rules
│   ├── agents/             # Agent prompt templates
│   ├── commands/           # Workflow command templates
│   ├── personas/           # VPC persona template
│   ├── rules/              # Per-layer convention template
│   ├── claude-md/          # Root CLAUDE.md template
│   └── settings/           # Settings template
├── commands/               # Claude Code commands (setup.md)
├── prompts/                # Guide prompts for analysis
├── openspec/               # OpenSpec config, specs, and changes
│   ├── config.yaml
│   ├── specs/
│   └── changes/
└── .claude/                # Generated output (after /setup)
    ├── agents/             # Adapted agent prompts + personas (sr-*.md)
    ├── commands/
    │   └── specrails/      # Adapted workflow commands (/specrails:* namespace)
    ├── rules/              # Per-layer convention rules
    ├── skills/             # OpenSpec skills (opsx:*)
    ├── agent-memory/       # Persistent agent memory (sr-<agent>/ dirs)
    └── settings.json       # Permissions
```

## Dev commands

```bash
shellcheck install.sh                    # Validate shell scripts
grep -r '{{[A-Z_]*}}' .claude/agents/   # Check for broken placeholders in generated files
```

## Environment

- Distributable npm package: `npx specrails-core@latest init`
- No test framework (shell scripts + markdown templates)
- CI/CD: GitHub Actions (`.github/workflows/`) — release-please + npm publish
- GitHub Issues used for backlog (label: `product-driven-backlog`)

## Architecture

```
Product Discovery      →  Architecture    →  Implementation    →  Review        →  Ship
(sr-product-manager)      (sr-architect)     (sr-developer)       (sr-reviewer)    (PR)
```

## Conventions

Layer-specific conventions are in `.claude/rules/` (loaded conditionally per layer).

- **File naming**: kebab-case everywhere
- **Shell scripts**: `set -euo pipefail`, quote all variables, use `local` for function vars
- **Templates**: `{{UPPER_SNAKE_CASE}}` for placeholders, every placeholder documented
- **Markdown**: consistent heading levels, no trailing whitespace
- **Commits**: conventional commits (`feat:`, `fix:`, `docs:`, `chore:`)
- **Branches**: `feat/<name>`, `fix/<name>`, `docs/<name>`

## Warnings

- **Meta-tool**: Changes to templates affect ALL target repos. Test template generation carefully.
- **Self-referential**: specrails-core uses its own agent workflow to develop itself. Avoid infinite recursion.
- **Meta-changes**: Template edits affect ALL repos that have already run `/setup`. Changes are not retroactive.

## OpenSpec

- **Specs**: `openspec/specs/` is the source of truth. Read relevant specs before implementing.
- **Changes**: `openspec/changes/<name>/`. Use `/opsx:ff` -> `/opsx:apply` -> `/opsx:archive`.

## Scoped context

- Layer rules: `.claude/rules/*.md`
