# specrails-core

[![npm version](https://img.shields.io/npm/v/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![GitHub Stars](https://img.shields.io/github/stars/fjpulidop/specrails-core?style=social)](https://github.com/fjpulidop/specrails-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm downloads](https://img.shields.io/npm/dw/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![AI providers](https://img.shields.io/badge/providers-Claude%20%7C%20Codex%20%7C%20Gemini%20%7C%20Kimi-6f42c1)](#provider-support)

**Your agentic development team. From idea to production code.**

One command turns your repo into a spec-driven pipeline with three specialized AI agents working together through OpenSpec — architect, developer, reviewer — all adapted to your codebase. Need more specialists? Add your own via a profile.

```bash
npx specrails-core@latest init   # install into the current repo — ready to use immediately
```

> **Requirements:** one supported AI CLI, git, and Node 20.19.0+. Cross-platform:
> macOS, Linux, and Windows. Use `--provider claude|codex|gemini|kimi` to
> override auto-detection.

---

## How it works

```
Idea  →  Architecture  →  Implementation  →  Review  →  PR
         (sr-architect)   (sr-developer)    (sr-reviewer)
```

Run `/specrails:implement "add dark mode"` — the pipeline designs, builds, reviews, and ships a pull request. No hand-holding.

The three core agents are adapted to your project's stack and conventions at install time, and the per-layer rules carry your codebase's patterns. Extend the trio with your own specialists through a [profile](#agent-profiles).

---

## Quick start

```bash
# 1. Install into the current repo — one pass, no follow-up step
npx specrails-core@latest init

# 2. Start building
> /specrails:implement "add user authentication"
> /specrails:implement #1, #2          # from local tickets (default)
> /specrails:implement #42             # from GitHub Issues (if configured)
```

That's it. Installation places the three agents, commands, rules, and OpenSpec skills directly — no wizard, no AI step. The pipeline takes over.

---

## Provider support

| Provider | Runtime command | Project surface | Workflow syntax |
|----------|-----------------|-----------------|-----------------|
| Claude Code | `claude` | `.claude/` | `/specrails:<command>` |
| Codex CLI | `codex` | `.codex/` | provider-native skills |
| Gemini CLI | `gemini` | `.gemini/` | `/specrails:<command>` |
| Kimi Code | managed Node skill runner → external `kimi -p` | `.kimi-code/` | `/skill:specrails-<command>` in the TUI |

Kimi is an external CLI dependency, just like the other providers. SpecRails
does not bundle a Kimi binary, start `kimi web`, or own a Kimi server. Install
Kimi Code separately, run `kimi login` once, then select it explicitly or let
the installer detect it. Parallel Kimi roles are submitted as one bounded
foreground wave; Core creates/reuses their git worktrees, attributes each
child stream, and waits for aggregate completion—without a server. See the
[Kimi setup guide](./docs/user-docs/getting-started-kimi.md).

## What gets installed

Everything lands in your repo — nothing auto-updates, nothing phones home. You own it, you commit it.

| Category | Location | Purpose |
|----------|----------|---------|
| **Agents** | `.claude/agents/` (Claude) or the provider-native skills tree (`.codex/`, `.gemini/`, `.kimi-code/`) | The three core agents (sr-architect, sr-developer, sr-reviewer) |
| **Commands** | `.claude/commands/specrails/` | Workflow commands (`/specrails:implement`, `/specrails:why`, ...) |
| **Kimi workflow skills** | `.kimi-code/skills/specrails-*/SKILL.md` | `/skill:specrails-*` directory-form skills |
| **Kimi headless runner** | `.kimi-code/specrails/run-skill.mjs` | Materializes Kimi's native skill-activation flow for headless runs |
| **OpenSpec skills** | `.claude/commands/opsx/` (or the provider-native skills directory) | `/opsx:*` commands for spec artefacts |
| **Config** | `.specrails/config.yaml` | Stack, CI commands, git workflow |
| **Rules** | `.specrails/rules/*.md` | Per-layer coding conventions |
| **Memory** | `.specrails/agent-memory/` | Persistent knowledge — agents learn across sessions |
| **Pipeline state** | `.specrails/pipeline/` | In-flight feature state for parallel builds |
| **Profiles** _(optional, yours)_ | `.specrails/profiles/*.json` | Add custom specialists + task routing |

To update, re-run the installer:

```bash
npx specrails-core@latest init
```

Or run `npx specrails-core@latest update` to refresh in place. Update leaves your `.specrails/` data, profiles, and `custom-*` agents untouched. Upgrading from v4? Update also removes the artefacts v5 no longer ships (the enrich wizard, install tiers, and the non-core agents) and prints exactly what it removed — see [Migrating from v4](#migrating-from-v4).

---

## Why specrails

| | specrails | Plain Claude Code | Cursor / Copilot |
|---|---|---|---|
| Structured pipeline | ✅ Architect → Dev → Review → PR | ❌ Manual | ❌ Manual |
| Adapts to your codebase | ✅ Reads your real stack/CI | ⚠️ Prompts only | ❌ |
| Spec-driven (OpenSpec) | ✅ Proposal → design → tasks → specs | ❌ | ❌ |
| Parallel feature builds | ✅ Git worktrees | ❌ | ❌ |
| Institutional memory | ✅ Agents learn across sessions | ❌ | ❌ |
| Open source | ✅ MIT | N/A | ❌ |

specrails is not a chat interface. It's a **development pipeline** that coordinates specialised agents through your existing tools (GitHub Issues, git, CI).

---

## The agents

Three agents, tightly integrated through the OpenSpec lifecycle (`/opsx:ff` → `/opsx:apply` → `/opsx:archive`):

| Agent | Model | Role |
|-------|-------|------|
| **sr-architect** | Sonnet | Designs features: proposal, technical design, task breakdown |
| **sr-developer** | Sonnet | Full-stack implementation (tests and docs included per task) |
| **sr-reviewer** | Sonnet | Single quality gate: correctness, TDD/spec completeness, security, and performance; runs CI, fixes issues, records learnings |

Need a specialist — a dedicated security reviewer, a data-engineering developer, a docs agent? Author it as a `custom-*` agent and declare it in a [profile](#agent-profiles); the pipeline routes to it. The installer never ships or manages non-core agents, so your custom agents are always yours.

---

## Commands

### `/specrails:implement` — Build features

```bash
/specrails:implement "add dark mode"        # from a description
/specrails:implement #85, #71               # from tickets
```

Architect designs → developer builds → reviewer validates → PR created. Multiple features run in parallel with git worktrees.

#### Letting a host own version control (`SPECRAILS_GIT_AUTO`)

By default the pipeline ships automatically (`GIT_AUTO=true`): it creates a branch, commits, pushes, and opens a pull request. When specrails-core runs **inside a host that owns version control itself** — such as [specrails-desktop](https://github.com/fjpulidop/specrails-desktop), which runs each pipeline in an isolated git worktree and opens the pull request for you — that host sets the `SPECRAILS_GIT_AUTO` environment variable to `false`.

When `SPECRAILS_GIT_AUTO=false` (or `0`), the Ship phase is forced onto the **manual** path regardless of configuration: the pipeline stops at "code written and verified" and makes **no branch, commit, push, or PR** — the host does that. This prevents a second, uncoordinated pull request. Leave the variable unset for the normal standalone behaviour (automatic shipping, subject to your `GIT_AUTO` configuration). It composes with `--dry-run`, which independently skips all git/GitHub/backlog operations.

#### Dry-run / preview mode

Not ready to commit? Run the full pipeline without touching git or GitHub:

```bash
/specrails:implement "add dark mode" --dry-run
/specrails:implement #85 --preview            # --preview is an alias for --dry-run
```

All agents run normally. Generated files land in `.claude/.dry-run/<feature-name>/` instead of your working tree. No branches, commits, PRs, or issue updates are created.

When you're happy with the preview, apply the cached output:

```bash
/specrails:implement --apply add-dark-mode    # copies files to real paths, then ships
```

To discard without applying:

```bash
rm -rf .claude/.dry-run/add-dark-mode/
```

### `/specrails:retry` — Resume a failed pipeline

```bash
/specrails:retry add-dark-mode                # resume from the failed phase
/specrails:retry add-dark-mode --from reviewer
/specrails:retry --list                       # show resumable pipeline states
```

Picks up a `/specrails:implement` run from where it stopped, reusing the OpenSpec artefacts already produced.

---

## Agent profiles

Profiles are **the way to extend the core trio**. They are declarative JSON files that tell `/specrails:implement` which agents to use, which models to run them with, and how to route tasks to specialists. Without a profile the pipeline runs the three baseline agents; with one, you add your own `custom-*` agents and routing. One project can define many profiles (e.g. `default`, `data-heavy`, `security-heavy`) and run different features with different profiles — useful for concurrent rails in `/specrails:batch-implement`.

### File layout

```
<project>/.specrails/
  profiles/
    default.json          # checked into git, team-shared
    data-heavy.json       # checked into git, team-shared
    .user-preferred.json  # gitignored, your personal default
```

### Resolution order

When running the pipeline, the active profile is resolved in this order:

1. `$SPECRAILS_PROFILE_PATH` environment variable (absolute path to a JSON snapshot)
2. Provider default: `<cwd>/.specrails/profiles/project-default.json` for
   Claude, or `<cwd>/.specrails/profiles/kimi-default.json` for Kimi
3. No profile — the three baseline agents (`sr-architect`, `sr-developer`, `sr-reviewer`)

Tools such as [specrails-desktop](https://github.com/fjpulidop/specrails-desktop) set `$SPECRAILS_PROFILE_PATH` to a job-scoped snapshot so concurrent rails can run independent profiles.

### Schema

The v1 profile schema is published at [`schemas/profile.v1.json`](./schemas/profile.v1.json). Example:

```json
{
  "schemaVersion": 1,
  "name": "data-heavy",
  "description": "Data engineering rail with stricter review",
  "orchestrator": { "model": "opus" },
  "agents": [
    { "id": "sr-architect",     "model": "opus",   "required": true },
    { "id": "sr-data-engineer", "model": "sonnet" },
    { "id": "sr-developer",     "model": "sonnet", "required": true },
    { "id": "sr-reviewer",      "model": "opus",   "required": true }
  ],
  "routing": [
    { "tags": ["etl", "schema", "data"], "agent": "sr-data-engineer" },
    { "default": true, "agent": "sr-developer" }
  ]
}
```

Baseline agents (`sr-architect`, `sr-developer`, `sr-reviewer`) MUST appear in `agents[]`. The `routing` array is ordered — first rule whose `tags` intersects the task's tags wins; the terminal `default: true` rule catches everything else.

### Reserved paths

The following paths are **reserved** — `specrails-core update` will never create, modify, or delete anything inside them:

- `.specrails/profiles/**` — profile JSON files (yours and desktop-authored).
- `.claude/agents/custom-*.md` — your custom agents. Use the `custom-` prefix to opt in to this protection.
- `.kimi-code/skills/custom-*/**` — your custom Kimi role skills. Pre-release
  `.kimi-code/skills/rails/custom-*` roles are also reserved while Core safely
  migrates them into this discoverable direct-child layout.

This contract is what lets you safely hand-author (or let specrails-desktop author) profiles and custom agents without fear of the next `update` overwriting your work. Other paths managed by specrails-core (`.specrails/install-config.yaml`, `.specrails/specrails-version`, etc.) remain under update's control. Audited by `src/installer/__tests__/reserved-paths.test.ts` on every CI run.

---

## Local ticket management

specrails-core ships with a built-in ticket system — no GitHub account or external tools required.

Tickets live in `.specrails/local-tickets.json` alongside your code. They're plain JSON and git-friendly.

**Local tickets are the default** — no GitHub account or credential setup required.

```bash
/specrails:implement #1, #4                # implement by ticket ID
/specrails:propose-spec                    # create a ticket from a spec proposal
```

See [docs/local-tickets.md](./docs/local-tickets.md) for the full schema reference, concurrency model, and command integration details.

Migrating from GitHub Issues or JIRA? See [docs/migration-guide.md](./docs/migration-guide.md).

---

## Migrating from v4

v5 is a breaking release. It removes the `/specrails:enrich` wizard, the quick/full install tiers, and the nine non-core agents (product manager/analyst, layer-specific developers and reviewers, test-writer, doc-sync, merge-resolver). The installer is now mode-less: `init` places the three core agents directly, in one pass.

To upgrade an existing install:

```bash
npx specrails-core@latest update
```

Update removes the artefacts v5 no longer ships (installer-owned agents, commands, and enrich staging) and prints the exact list of removed files. It never touches your `.specrails/profiles/**` or `.claude/agents/custom-*.md`.

- **Relied on a removed agent?** Its body is plain Markdown — copy the v4 agent to `.claude/agents/custom-<name>.md` and declare it in a [profile](#agent-profiles). Same behaviour, now user-owned.
- **Have a v4 profile that lists removed agents?** It keeps working: the pipeline warns and skips any profile agent whose file no longer exists, and continues with the rest. The three baseline agents remain required.
- **Using specrails-desktop?** Pin it to `specrails-core@^4` until a desktop release adopts the mode-less `init --from-config` flow.

---

## Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| **One supported AI CLI** | Yes | Claude Code, Codex CLI, Gemini CLI, or Kimi Code |
| **Kimi Code 0.27.0+** | For Kimi projects | Install from the [official Kimi Code guide](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started), then run `kimi login` |
| **git** | Yes | Repository detection |
| **Node 20.19.0+** | Yes | Needed for `npx specrails-core@latest init` (the floor required by the pinned OpenSpec 1.4.1 CLI). Cross-platform: macOS, Linux, Windows (10/11, x64 + ARM64 via emulation). |
| **GitHub CLI** (`gh`) | Optional | Backlog sync to GitHub Issues, PR creation. Not needed with local tickets. |

The installer checks for prerequisites and offers to install missing ones.

---

## Supported stacks

Stack-agnostic. The installer detects and adapts the agents and rules to whatever you're running:

- **Backend:** Python/FastAPI, Node/Express, Go/Gin, Rust/Actix, Java/Spring, Ruby/Rails, .NET
- **Frontend:** React, Vue, Angular, Svelte, Next.js, Nuxt
- **Database:** PostgreSQL, MySQL, SQLite, MongoDB, Redis
- **CI/CD:** GitHub Actions, GitLab CI, Jenkins, Makefile
- **Testing:** pytest, vitest, jest, go test, cargo test, rspec

---

## Design principles

1. **Local by default** — Everything lives in your repo. No cloud services, no telemetry, no phone home.
2. **Mode-less** — One install path. `init` places everything directly; there is no follow-up wizard.
3. **Context-first** — Every generated file uses your real paths, patterns, and CI commands.
4. **Spec-driven** — Every feature flows through OpenSpec (proposal → design → tasks → specs), not ad-hoc prompts.
5. **Institutional memory** — Agents learn across sessions. Reviewer learnings feed back to future developers.
6. **Parallel-safe** — Multiple features implemented simultaneously via git worktrees with automatic merge.
7. **Yours to extend** — The core is three agents; specialists come from profiles + `custom-*` agents the installer never touches.

---

## FAQ

**Can I customise the agents after installation?**
Yes. Everything in the selected provider tree and `.specrails/` is yours to
edit — agent prompts, rules, config. For Kimi, customize `.kimi-code/skills/`,
`.kimi-code/rules/`, and the managed block in `.kimi-code/AGENTS.md`;
`custom-*` role skills are preserved. To add a specialist, declare a
`custom-*` agent in a profile.

**How do I update an install?**
Run `npx specrails-core@latest update` (or re-run `init`) to refresh the agents/commands. Both leave your `.specrails/` data, profiles, and `custom-*` agents untouched.

**Does this work without GitHub CLI?**
Yes. Local tickets are the default and need no external tools. `/specrails:implement "description"` also works without `gh` — it just skips automated PR creation.

**Can I use local tickets and GitHub Issues together?**
Not simultaneously for the same project — backlog commands use one active provider at a time. You can migrate from GitHub Issues to local tickets using the [migration guide](./docs/migration-guide.md).

**How much does it cost to run?**
Cost depends on the selected provider, model, and workload. SpecRails does not
add a model surcharge. Kimi's stream output does not currently report a native
USD cost, so consumers must display it as unavailable rather than inventing an
estimate.

**Does it work with private repos?**
Yes. Orchestration runs through the selected local CLI. The provider still
connects to its model API and any MCP/integration endpoints you configure.

**How do I use specrails with Kimi?**
Install and authenticate Kimi Code, then run
`npx specrails-core@latest init --provider kimi`. Invoke the generated workflows
as `/skill:specrails-implement`, `/skill:specrails-enrich`, and so on in Kimi's
interactive TUI. Headless callers use the managed
`.kimi-code/specrails/run-skill.mjs` helper: Kimi 0.27 sends a slash command
passed directly to `kimi -p` as literal text, so the helper first renders the
same skill prompt as Kimi's native activation path and then starts external
`kimi -p --output-format stream-json`. No server installation is required.

---

## Related

- **[specrails-desktop](https://github.com/fjpulidop/specrails-desktop)** — desktop dashboard that visualises specrails pipelines (macOS, open source).
- **[specrails.dev](https://specrails.dev)** — landing page and documentation.

---

## Support

If specrails-core is useful to you, you can donate on [Ko-fi](https://ko-fi.com/D1D81Y002C) ☕ to support ongoing development.

[![Donate on Ko-fi](https://img.shields.io/badge/Donate-Ko--fi-FF5E5B?logo=kofi&logoColor=white&style=flat-square)](https://ko-fi.com/D1D81Y002C)

---

## License

MIT — [fjpulidop](https://github.com/fjpulidop)
