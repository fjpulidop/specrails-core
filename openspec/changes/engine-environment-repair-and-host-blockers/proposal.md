## Why

Desktop runs the Implement loop on engine v2, whose `verify` piece has no environment handling. A verification failure caused by a missing toolchain artifact (a Playwright browser build, an uninstalled dependency) reaches the fixer as if it were a code defect. The fixer prompt rightly forbids it from touching the environment, so it edits nothing, the candidate hash stays unchanged and the run ends at `correction-stalled` after spending a correction round. The legacy graph path already repairs environments (`graph/nodes.ts`) but engine v2 never gained that behavior. A run observed on 2026-10-06 (`pixel-depths`, ticket 1) failed exactly this way: `browserType.launch: Executable doesn't exist at ~/Library/Caches/ms-playwright/chromium_headless_shell-1243/...` while `npm ci`, lint, typecheck, unit tests and build all passed.

## What Changes

- The engine v2 `verify` piece gains host-owned environment repair: before handing a failure to a correction round it classifies host preconditions (credentials, registry access, missing variables, a browser download that cannot reach the network) and environment failures (missing tools, modules, Playwright browser builds), runs the planned installs once and re-verifies. A precondition the host cannot satisfy ends the run as `blocked` with a structured blocker instead of a correction round. Guardrails `environment-repair` and `lockfile-repair` keep governing the behavior.
- `compact/environment.ts` recognises Playwright browser failures (`Executable doesn't exist at … ms-playwright`, "Looks like Playwright was just installed", `browserType.launch`) and plans `npx playwright install <browser>` (or the pnpm/yarn equivalent) for repositories that depend on `@playwright/test` or `playwright`. A failed browser download (`Failed to download …`, offline CDN) is a host precondition.
- Runtime configuration gains an optional `setup` array with the same command shape as `verification`. Setup commands run sequentially in the admitted workspace before each verification plan; a failing setup command is a host precondition blocker, never a correction round.
- The verify piece output and the run completion expose a structured `blocker` (`kind`, `reason`, `command`, `cwd`, `requiredAction`) so hosts can render an actionable message and a retry hint.
- The fixer output contract gains an optional structured `blocker` with the same shape. The fixer prompt tells the role to return it, with evidence and the required action, instead of free-text diagnosis when the cause lies outside the change. The fixer boundary admits an idempotent, documented toolchain install inside the admitted workspace (for example `npx playwright install chromium`) and still forbids editing package-manager, registry, credential, CI or environment configuration.
- The developer prompt forbids validating with a temporary configuration that points at tools the host verification cannot use, and requires installing a missing project tool through the project's documented command or reporting it as a blocker. Role turns show the developer and fixer the complete host verification plan, including commands proposed by the architect for repositories without configured checks.

## Capabilities

### New Capabilities
- `verification-environment-repair`: host-owned environment classification, planned installs, single re-verify and structured host blockers in the engine v2 `verify` piece.
- `runtime-setup-commands`: the optional `setup` array of the runtime configuration and its execution before verification.
- `correction-blocker-contract`: the structured `blocker` field of the fixer output, its prompt instructions, the developer rule against temporary verification bypasses and the host plan visibility for write roles.

### Modified Capabilities
- (none; Core has no main specs for these areas yet)

## Impact

- `src/agent-runtime/engine/pieces/verify.ts`, `src/agent-runtime/compact/environment.ts`, `src/agent-runtime/graph/nodes.ts` (shared helpers extracted), `src/agent-runtime/config.ts`, `src/agent-runtime/executor-types.ts`, `src/agent-runtime/prompts.ts`, `src/agent-runtime/engine/pieces/role-turn.ts`, engine contracts for the blocker shape.
- Desktop vendors the runtime configuration schema and the Implement recipe; the paired Desktop change `implement-environment-repair-and-blockers` consumes the new `setup` field, the `blocker` output and the fixer schema.
- No change to shipped CLI commands, OpenSpec artifacts or delivery semantics. Behavior is additive and guardrail-controlled.
