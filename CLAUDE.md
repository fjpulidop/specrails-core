# specrails-core

Agent Workflow System installer for Claude Code. Installs a complete product-driven development workflow into any repository: specialized AI agents, orchestration commands, VPC-based product discovery, and per-layer coding conventions — all adapted to the target codebase automatically.

## Stack

| Layer | Tech |
|-------|------|
| Installer | TypeScript / Node ≥ 20 (cross-platform: macOS, Linux, Windows) |
| Templates | Markdown with `{{PLACEHOLDER}}` substitution |
| Commands | Claude Code slash commands (Markdown) |
| Prompts | Markdown guide prompts |
| Spec system | OpenSpec (YAML + Markdown) |
| Tests | vitest (cross-platform CI matrix) |

## Repo layout

```
specrails-core/
├── bin/
│   ├── specrails-core.mjs    # CLI entry point (ESM dispatcher)
│   └── tui-installer.mjs      # interactive TUI writer for install-config.yaml
├── src/
│   └── installer/             # TypeScript installer (compiled → dist/)
│       ├── cli.ts             # main() + arg parser
│       ├── commands/          # init / update / doctor / perf-check
│       ├── phases/            # prereqs, provider-detect, scaffold, manifest, install-config
│       └── util/              # logger, exec, fs, git, prompts, template, errors, paths
├── dist/                       # tsc output (npm-published, gitignored)
├── README.md                  # User-facing documentation
├── templates/                 # Source templates for agents, commands, rules
│   ├── agents/                # Agent prompt templates (sr-*.md)
│   ├── commands/              # Workflow command templates
│   ├── personas/              # VPC persona template
│   ├── rules/                 # Per-layer convention template
│   ├── claude-md/             # Root CLAUDE.md template
│   └── settings/              # Settings template
├── commands/                  # Bundled slash-command bodies (enrich.md, doctor.md)
├── schemas/                   # JSON Schema for profile validation
├── openspec/                  # OpenSpec config, specs, and changes
└── .specrails/                # Runtime config (gitignored)
```

## Dev commands

```bash
npm install                              # Install deps
npm run build                            # Compile src/ → dist/
npm run build:watch                      # tsc --watch (use while iterating)
npm test                                 # typecheck + build + vitest run
npm run test:watch                       # vitest in watch mode
npm run test:coverage                    # vitest with v8 coverage
node bin/specrails-core.mjs <subcommand> # Run the CLI from a source checkout
grep -r '{{[A-Z_]*}}' .claude/agents/    # Sanity-check generated files for unsubstituted placeholders
```

## Environment

- Distributed as an npm package: `npx specrails-core@latest init`
- Cross-platform from v4.2.0: macOS, Linux, Windows (Node ≥ 20). No bash / python required.
- Test framework: vitest with a cross-OS / cross-Node matrix in `.github/workflows/ci.yml`
- CI/CD: GitHub Actions (release-please + npm publish)
- GitHub Issues used for backlog (label: `product-driven-backlog`)

## Architecture

```
Product Discovery      →  Architecture    →  Implementation    →  Review        →  Ship
(sr-product-manager)      (sr-architect)     (sr-developer)       (sr-reviewer)    (PR)
```

## Conventions

Layer-specific conventions live in `.claude/rules/` (loaded conditionally per layer).

- **File naming**: kebab-case for modules; PascalCase for TS classes; `*.test.ts` next to subject.
- **TypeScript**: ESM, strict mode, `tsconfig.json` targets ES2022 + NodeNext.
- **Cross-platform code**: spawn via `util/exec.runCommand` (handles `shell:true` on Windows + arg quoting + tree-kill); never assume POSIX paths or POSIX-only utilities.
- **Templates**: `{{UPPER_SNAKE_CASE}}` placeholders, every placeholder documented; unknown tokens are stripped at render time.
- **Markdown**: consistent heading levels, no trailing whitespace, LF line endings (`.gitattributes` enforces this).
- **Commits**: conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- **Branches**: `feat/<name>`, `fix/<name>`, `docs/<name>`.

## Warnings

- **Meta-tool**: Changes to templates affect ALL target repos. Test template generation carefully.
- **Self-referential**: specrails-core uses its own agent workflow to develop itself. Avoid infinite recursion.
- **Meta-changes**: Template edits affect ALL repos that have already run `/specrails:setup`. Changes are not retroactive.

## OpenSpec

- **Specs**: `openspec/specs/` is the source of truth. Read relevant specs before implementing.
- **Changes**: `openspec/changes/<name>/`. Use `/opsx:ff` → `/opsx:apply` → `/opsx:archive`.

## Profiles (v4.1.0+)

`implement.md` can run in two modes:

- **Legacy**: no profile present → current hardcoded behavior. Zero breakage for standalone users.
- **Profile**: profile JSON active → `AVAILABLE_AGENTS`, routing, and per-agent models come from the profile instead of the hardcoded defaults.

Profile resolution at Phase -1 (highest wins):
1. `$SPECRAILS_PROFILE_PATH` env var (snapshot path)
2. `<cwd>/.specrails/profiles/project-default.json`
3. Legacy fallback

Schema: `schemas/profile.v1.json` (shipped in the npm package). Validator error messages MUST name the offending field. Baseline agents (`sr-architect`, `sr-developer`, `sr-reviewer`) are required in every valid profile.

### Reserved paths (contract with downstream tools)

The following paths are **reserved** — the installer (`init` / `update`) MUST NEVER create, modify, or delete files inside them:

- `.specrails/profiles/**` — owned by projects (checked into git) and by tools like specrails-hub. Holds profile JSON files.
- `.claude/agents/custom-*.md` — owned by user-authored or hub-generated custom agents. The `custom-` prefix is reserved for this purpose.

Audited by `src/installer/__tests__/reserved-paths.test.ts` on every CI run.

Other paths under `.specrails/` (e.g. `.specrails/install-config.yaml`, `.specrails/specrails-version`, `.specrails/specrails-manifest.json`, `.specrails/setup-templates/`) ARE managed by the installer and remain so.

## Scoped context

- Layer rules: `.claude/rules/*.md`
