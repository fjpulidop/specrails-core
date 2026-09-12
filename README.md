# specrails-core

[![CI](https://github.com/fjpulidop/specrails-core/actions/workflows/ci.yml/badge.svg)](https://github.com/fjpulidop/specrails-core/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Specrails Core installs specification-driven development workflows into a project. It gives your AI CLI three baseline roles—architect, developer and reviewer—plus provider-native commands, OpenSpec integration and project conventions. You choose the provider; Core supplies the workflow and its local artifacts.

Use Core directly from Claude Code, Codex CLI, Gemini CLI or Kimi Code. For mission conversations, a shared project board, execution loops and delivery controls, use [Specrails Desktop](https://github.com/fjpulidop/specrails-desktop).

The current source also includes an opt-in [programmatic agent runtime](docs/agent-runtime.md): a shared LangGraph workflow with per-role providers, durable recovery and local OpenAI-compatible models. Its TypeScript API and CLI keep phase control in Core while the caller owns delivery.

This README describes the current source tree. `npx specrails-core@latest` installs the published package, not unmerged changes. Check the [release notes](https://github.com/fjpulidop/specrails-core/releases), or [build this checkout](#develop-from-source) when testing unreleased work.

## Quick start

You need **Node.js 20.19.0+**, Git and at least one installed, authenticated AI CLI. A provider may impose a higher Node or operating-system requirement than Core itself. Install providers through their own supported installation flow.

From the project you want to configure:

```sh
npx specrails-core@latest init --provider claude
```

Choose `claude`, `codex`, `gemini` or `kimi`. The default installer collects agent and model configuration interactively. For a non-interactive installation using defaults:

```sh
npx specrails-core@latest init --yes --provider claude
```

Core 5 installs the baseline roles and workflows directly; it does not invoke a model for an enrichment phase. Installing dependencies or OpenSpec may require network access. Review the generated project configuration before running an implementation.

Open the selected AI CLI in that project and use its native workflow syntax:

| Provider | Executable | Implement | Batch | Retry |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `/specrails:implement` | `/specrails:batch-implement` | `/specrails:retry` |
| Codex CLI | `codex` | `$implement` | `$batch-implement` | `$retry` |
| Gemini CLI | `gemini` | `/specrails:implement` | `/specrails:batch-implement` | `/specrails:retry` |
| Kimi Code | `kimi` | `/skill:specrails-implement` | `/skill:specrails-batch-implement` | `/skill:specrails-retry` |

For example, enter this **inside Claude Code or Gemini CLI**, not in your shell:

```text
/specrails:implement "add keyboard navigation to the settings page"
/specrails:implement #1, #2
```

Kimi integration targets Kimi Code 0.27.0+. Its headless path uses the installed `.kimi-code/specrails/run-skill.mjs` helper to activate the workflow before calling the external CLI; passing a slash command directly to `kimi -p` is not equivalent. See [Kimi setup](docs/user-docs/getting-started-kimi.md) and [provider pipeline contracts](docs/user-docs/provider-pipelines.md).

## How implementation works

```text
Specification → Architecture → Implementation → Review → Delivery
                sr-architect   sr-developer      sr-reviewer
```

The architect produces the OpenSpec proposal, design and tasks. The developer implements the agreed work. The reviewer checks the result against the spec and project verification commands. Delivery follows the configured Git workflow and the execution owner's policy.

The current source installs a local pipeline helper for persisted phase state, explicit role handoffs and verification receipts. Retry resumes the first incomplete or invalid phase; it does not treat an earlier success as valid after its inputs change. A batch retains its tickets' requirements and repository identities in an aggregate change. See the [pipeline contract](docs/user-docs/provider-pipelines.md) for the execution context and validation limits.

Standalone automatic delivery can create branches, commits, pushes and pull requests when enabled. Set the project's Git workflow deliberately; model execution and repository writes are real operations, not a preview by default. GitHub pull requests additionally require an authenticated `gh` CLI.

When a host such as Desktop owns worktrees and delivery, it sets `SPECRAILS_GIT_AUTO=false` and supplies the execution context. Core then leaves branch creation, commits, pushes and PRs to that host. Multi-repository contexts must explicitly identify the selected repositories and the OpenSpec/backlog owner; an additional readable folder is not automatically an implementation target.

## Installed files and ownership

Standalone installation normally copies committable artifacts into the repository and uses a shared framework store under `~/.specrails/`. Relocated installations, including Desktop-managed workspaces, can keep framework links and project artifacts outside the checkout. The resolved workspace determines where these files live.

| Surface | Purpose |
| --- | --- |
| `.claude/`, `.codex/`, `.gemini/`, `.kimi-code/` | Selected provider's agents, commands or skills |
| `openspec/` | Specifications and change artifacts |
| `.specrails/config.yaml` and `install-config.yaml` | Project workflow and installation configuration |
| `.specrails/rules/` and `agent-memory/` | Coding conventions and retained agent notes |
| `.specrails/runtime/` and `pipeline/` | Installed execution helper and run state in the current source |
| `.specrails/local-tickets.json` | Local backlog, when that backlog provider is selected |
| `.specrails/profiles/` | User-owned profiles and model/routing choices |

Local tickets do not require GitHub or Jira. External backlog integrations require their own credentials and configuration. See [local tickets](docs/local-tickets.md) and [backlog migration](docs/migration-guide.md).

Managed files can be regenerated by updates. Keep extensions in documented user-owned locations rather than relying on edits to generated agents surviving an update.

## Extend the agents

Profiles can select models and route tasks to additional specialists where the provider workflow supports them. Keep the three baseline roles, then add your custom agents and routing. The profile schema is [schemas/profile.v1.json](schemas/profile.v1.json).

```sh
npx specrails-core@latest profile validate .specrails/profiles/default.json
```

The installer reserves these extension paths:

- `.specrails/profiles/**`
- `.claude/agents/custom-*.md`
- `.kimi-code/skills/custom-*/**`

Use the `custom-` prefix for protected custom roles. The legacy nested Kimi custom-role layout is preserved during migration as well. Other provider-managed surfaces are not a blanket guarantee that arbitrary local changes survive regeneration. See [customization](docs/customization.md) for the broader configuration model.

## Update an existing project

Updating the executable and refreshing a project's artifacts are separate operations. From the project directory:

```sh
npx specrails-core@latest --version
npx specrails-core@latest update --dry-run
npx specrails-core@latest update
npx specrails-core@latest doctor
```

Use an exact published package version instead of `latest` when reproducibility matters. The selected CLI supplies the framework bytes; the current source rejects an older CLI overwriting a newer installed framework. It retains recovery information for failed updates and does not report a complete upgrade after a partial component refresh.

Existing provider selections are preserved by the current update implementation. Installing support for an additional provider does not require discarding the other provider's managed artifacts. See [installation and update consistency](docs/user-docs/core-updates.md) for version checks, copied versus linked workspaces, concurrent updates and rollback behavior.

### Migrating from Core 4

Core 5 removes the `enrich` command, the quick/full installation tiers and the previously bundled non-core specialist agents. `init` performs deterministic placement instead of launching the old enrichment wizard.

Before upgrading, review customizations and profiles that refer to removed agents. Move any specialist you want to retain into a protected `custom-*` role and update its profile reference. The migration removes installer-owned legacy artifacts; protected profiles and custom agents remain user-owned.

Desktop must support the selected Core lifecycle. Current Desktop source supports Core 5, but older installed Desktop releases can differ. Updating this repository or the global CLI alone does not upgrade a running Desktop application or every project's copied artifacts.

## Develop from source

Core uses one npm dependency tree. Node **20.19.0+** is the package minimum; CI exercises the declared platform/runtime matrix.

```sh
git clone https://github.com/fjpulidop/specrails-core.git
cd specrails-core
npm ci
npm test
```

`npm test` builds `dist/`, checks types and runs the tests. To use the current checkout against a separate project:

```sh
npm run build
node bin/specrails-core.mjs --version
node bin/specrails-core.mjs init --root-dir /absolute/path/to/project --provider codex
```

That final command installs into the target project. Use a disposable fixture when testing installation behavior. No global npm install is needed to execute this checkout.

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile the installer and runtime |
| `npm run typecheck` | Check production and test types |
| `npm test` | Build, typecheck and run tests |
| `npm run test:coverage` | Build and run the coverage suite |
| `npm run test:scripts` | Run release and package guard regressions |
| `npm run check:package` | Build, install and verify a temporary npm consumer |
| `npm run ci` | Run local type, release, coverage and package checks |
| `npm pack` | Build and create a package tarball without publishing |

See [CI and releases](docs/ci-cd.md) for platform gates and publication requirements. Tests with simulated provider processes do not establish live compatibility with every CLI version, and an installer test does not prove a model will successfully implement every requested feature.

## Data, security and documentation

Core's configuration, specs and run state are local files. Provider CLIs still send supplied context to their configured model services; package installation, GitHub/Jira and MCP integrations may also use the network. Model usage is billed according to your provider. Review the repository's commands and agent permissions before execution.

- [CLI reference](docs/user-docs/cli-reference.md)
- [Provider pipeline contracts](docs/user-docs/provider-pipelines.md)
- [Programmatic agent runtime](docs/agent-runtime.md)
- [Core update consistency](docs/user-docs/core-updates.md)
- [Local tickets](docs/local-tickets.md)
- [Documentation index](docs/README.md)
- [Contributing](CONTRIBUTING.md), [security reporting](SECURITY.md) and [changelog](CHANGELOG.md)

Specrails Core is available under the [MIT license](LICENSE). Development can be supported through [Ko-fi](https://ko-fi.com/D1D81Y002C).
