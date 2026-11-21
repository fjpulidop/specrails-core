# specrails-core

[![CI](https://github.com/fjpulidop/specrails-core/actions/workflows/ci.yml/badge.svg)](https://github.com/fjpulidop/specrails-core/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The agent workflow engine behind [Specrails Desktop](https://github.com/fjpulidop/specrails-desktop). Core does three things:

1. **Installs** the specrails workflow into a project for Claude Code, Codex CLI, Gemini CLI or Kimi Code: the `implement` and `retry` entry points (`implement` runs one ticket or several tickets as one aggregate run), provider settings and the official OpenSpec skills. The architect, developer and reviewer roles are defined by the runtime itself; no role file is installed.
2. **Executes** Desktop-owned workflow definitions on the [definition engine](docs/engine-v2/README.md) and the built-in implementation workflow through the [programmatic agent runtime](docs/agent-runtime.md): per-role providers, deterministic verification, durable recovery and OpenAI-compatible local models. Desktop owns workflow composition and editable loop agents; Core retains the built-in workflow for saved runs.
3. **Hosts** long-lived interactive [agent sessions](docs/agent-sessions/architecture.md) (missions, chats, sub-agents) over a JSON-RPC stdio [protocol](docs/agent-sessions/protocol.md).

Desktop bundles a pinned Core package and owns everything around it: worktrees, commits, pull requests, backlog and the user interface. Core never ships code on its own; it prepares a reviewed candidate for the host.

## Commands

```text
specrails-core init                Install specrails into a repository
specrails-core install-framework   Materialize the versioned framework (offline)
specrails-core swap-current        Point framework/current at a version (offline)
specrails-core assemble            Link the framework into a project workspace (offline)
specrails-core pipeline            Inspect and verify durable implementation phases (incl. `pipeline trace`)
specrails-core rules               Inventory a repository's gates and written rules (.specrails/rules.json)
specrails-core runtime             Run, inspect, resume and fork runs; serve agent sessions (`runtime host`)
```

Desktop calls `init` and the offline framework lifecycle, then launches `dist/agent-runtime/cli.js` directly. The machine-readable contract between both lives in [`integration-contract.json`](integration-contract.json); the runtime configuration schema is [`schemas/agent-runtime.schema.json`](schemas/agent-runtime.schema.json).

## Layout

```text
bin/specrails-core.mjs     npm bin shim → dist/installer/cli.js
src/installer/             CLI, framework lifecycle, provider rendering
src/pipeline/              pipeline journal, gates and verification receipts
src/agent-runtime/         runtime: built-in graph, definition engine (engine/), agent sessions (session/), executors, recovery
src/shared/                helpers shared by the CLIs
templates/                 workflow commands, provider settings, Kimi runner
schemas/                   runtime configuration and workflow definition schemas
integration-contract.json  Desktop ⇄ Core contract
docs/                      runtime, engine, session, CI and release documentation
```

## Develop

Requires Node.js 22.22.3+ and Git.

```sh
npm ci
npm test               # build + typecheck + vitest
npm run ci             # full local CI: typecheck, script tests, coverage, package check
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [CI and publishing](docs/ci-cd.md) and the [release policy](docs/release-policy.md).

## License

MIT
