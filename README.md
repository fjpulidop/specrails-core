# specrails-core

[![CI](https://github.com/fjpulidop/specrails-core/actions/workflows/ci.yml/badge.svg)](https://github.com/fjpulidop/specrails-core/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/specrails-core.svg)](https://www.npmjs.com/package/specrails-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The agent workflow engine behind [Specrails Desktop](https://github.com/fjpulidop/specrails-desktop). Core does two things:

1. **Installs** the specrails workflow into a project for Claude Code, Codex CLI, Gemini CLI or Kimi Code: three roles (architect, developer, reviewer), the `implement` / `batch-implement` / `retry` entry points and the official OpenSpec skills.
2. **Runs** implementations through the [programmatic agent runtime](docs/agent-runtime.md): a LangGraph workflow (architect → developer → verify → reviewer → archive) with per-role providers, deterministic verification, durable recovery and OpenAI-compatible local models.

Desktop bundles a pinned Core package and owns everything around it: worktrees, commits, pull requests, backlog and the user interface. Core never ships code on its own; it prepares a reviewed candidate for the host.

## Commands

```text
specrails-core init                Install specrails into a repository
specrails-core install-framework   Materialize the versioned framework (offline)
specrails-core swap-current        Point framework/current at a version (offline)
specrails-core assemble            Link the framework into a project workspace (offline)
specrails-core pipeline            Inspect and verify durable implementation phases
specrails-core runtime             Run, inspect and resume programmatic agents
```

Desktop calls `init` and the offline framework lifecycle, then launches `dist/agent-runtime/cli.js` directly. The machine-readable contract between both lives in [`integration-contract.json`](integration-contract.json); the runtime configuration schema is [`schemas/agent-runtime.schema.json`](schemas/agent-runtime.schema.json).

## Layout

```text
bin/specrails-core.mjs     npm bin shim → dist/installer/cli.js
src/installer/             CLI, framework lifecycle, provider rendering
src/pipeline/              pipeline journal, gates and verification receipts
src/agent-runtime/         programmatic runtime: graph, executors, compact loop, recovery
templates/                 role definitions, workflow commands, provider settings, Kimi runner
schemas/                   runtime configuration schema and fixtures
integration-contract.json  Desktop ⇄ Core contract
```

## Develop

Requires Node.js 20.19.0+ and Git.

```sh
npm ci
npm test               # build + typecheck + vitest
npm run ci             # full local CI: typecheck, script tests, coverage, package check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CI and publishing](docs/ci-cd.md).

## License

MIT
