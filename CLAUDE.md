# specrails-core

Agent workflow engine for specrails-desktop: a deterministic installer that renders the specrails workflow for Claude Code, Codex, Gemini CLI and Kimi Code, plus the programmatic agent runtime that executes implementations. Desktop is the only host; there is no standalone product surface.

## Stack

| Layer | Tech |
|-------|------|
| CLI + installer | TypeScript (ESM, strict), Node ≥ 20.19.0, macOS/Linux/Windows |
| Runtime | @langchain/langgraph state graph, provider CLI executors, OpenAI-compatible chat loop |
| Specs | OpenSpec (pinned in `pinned-versions.json`) |
| Tests | vitest (OS × Node CI matrix) |

## Layout

```
bin/specrails-core.mjs        npm bin shim → dist/installer/cli.js
src/installer/
  cli.ts                      single dispatcher: init, install-framework, swap-current, assemble, pipeline, runtime
  commands/                   init + offline framework lifecycle
  phases/                     prereqs, provider detection, scaffold (provider rendering), manifest, install-config
  util/                       fs, exec, git, registry, install transaction, logger
src/pipeline/pipeline-state.ts  pipeline journal, gates and verification receipts; Node built-ins only because it is copied into projects as .specrails/runtime/pipeline-state.mjs
src/agent-runtime/            runtime: workflow engine, graph nodes/roles, executors, compact loop, recovery, CLI
src/shared/                   helpers shared by the CLIs (argument parsing)
templates/                    sr-* roles, implement/batch-implement/retry, provider settings, Kimi runner
integration-contract.json     Desktop ⇄ Core contract (schemaVersion 5.1)
```

## Commands

```bash
npm ci
npm run build          # src/ → dist/
npm test               # build + typecheck + vitest
npm run ci             # typecheck, script tests, coverage, package check
```

## Conventions

- Dependency direction is `shared ← pipeline ← agent-runtime ← installer`, enforced by `src/architecture.test.ts`. The installer loads the runtime lazily for the `runtime` command only.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`); kebab-case files; tests next to their subject as `*.test.ts`.
- Spawn processes through `src/installer/util/exec.ts` or `src/agent-runtime/cli-process.ts` (Windows quoting and tree-kill); never assume POSIX paths.
- `templates/commands/specrails/*.md` are the single source for every provider's workflow entry points.
- Any change to the files Desktop reads (`integration-contract.json`, CLI flags, `.specrails/runtime/*`, runtime status JSON) needs a paired Desktop change.

## Contracts with Desktop

- Reserved paths the installer never creates, modifies or deletes: `.specrails/profiles/**` and `<provider>/agents/custom-*.md` (Desktop-owned). Audited by `src/installer/__tests__/reserved-paths.test.ts`.
- `init complete` is a frozen sentinel line matched by Desktop's setup wizard.
- The runtime requires host-owned delivery (`ownership.git: "host"`).
