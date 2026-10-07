## Context

Engine v2 (`src/agent-runtime/engine/`) executes Desktop-authored graphs. Its `verify` piece (`engine/pieces/verify.ts`) runs the configured plan through `executeVerification`, returns `pass`/`fail`/`failed`, stops after three identical failures and treats exit `-1` as infrastructure. The legacy graph (`graph/nodes.ts`, `verifyNode`) additionally classifies host preconditions (`hostPreconditionFailure`), environment failures (`isEnvironmentFailure`), runs `installEnvironment` once and re-verifies, and returns `status: 'blocked'` with a host-facing message. Those helpers live in `compact/environment.ts` and are unit tested.

Constraints discovered while reading the code:

- `definition-validator.ts:105` requires a node's `ends` to match the piece outcomes exactly. A new unconditional outcome would invalidate every saved definition. `prompt` already solves this with `getOutcomes(params)` keyed on `sentinel`.
- A piece result with `status: 'blocked'` exits the body only when its outcome maps to `null` or is unmapped with `status: 'failed'` (`compiler.ts:120`). Routing to an `end` node is the host's decision; the structured blocker must therefore travel in the piece `output` so an `end` reason template can render it.
- Desktop's Implement recipe binds `build`/`correct` as custom roles. `roleInstructions` for a custom role renders `descriptor.prompt` plus the custom boundary section; it never renders `developerTail`, so custom write roles do not see the host verification plan today. `role-turn.ts:52` also passes no `verification` option.
- `environment.ts` is shared by the compact runtime and the legacy graph; its spawn is synchronous (`cross-spawn.sync`). The verify piece is async but runs on the host, so a synchronous bounded install is acceptable and keeps one implementation.

## Goals / Non-Goals

Goals:
- A missing Playwright browser, a missing tool or an uninstalled dependency never consumes a correction round in engine v2: the host repairs once and re-verifies.
- A host precondition (no network for the browser download, registry credentials, a failing setup command) ends the run with a structured, actionable blocker.
- Hosts can declare idempotent `setup` commands that run before verification.
- The fixer returns a structured blocker instead of prose when the cause is outside the change; the developer cannot pass verification through a temporary configuration the host cannot use; both roles see the complete host plan.

Non-Goals:
- Network sandbox changes for Codex (`--sandbox workspace-write`). Host-side installs make agent-side network unnecessary for this case.
- Changing the legacy `graph/nodes.ts` behavior beyond extracting shared helpers.
- Auto-detecting `test:e2e` in `suggestVerificationCommands` (Desktop owns suggestions).

## Decisions

### D1. Shared host-repair helpers

Extract from `graph/nodes.ts` into a new `src/agent-runtime/verification-repair.ts`: `installRoots(context, commands)`, `checkoutRelative(context, directory)`, `hostPreconditionMessage(...)`, `preconditionBlock(context, receipt)` returning a structured `HostBlocker` instead of a string, plus a new `repairEnvironment(context, receipt, guardrails, note)` that wraps `installEnvironment` and reports `{ installs, refused?: HostBlocker }`. `graph/nodes.ts` imports them; its observable behavior stays identical (existing tests must still pass).

`HostBlocker` (exported from `engine/contracts.ts` as a JSON-shaped interface):

```
{ kind: 'network' | 'credential' | 'environment-variable' | 'toolchain' | 'setup' | 'environment',
  reason: string, command: string, args: string[], cwd: string, requiredAction: string, evidenceId?: string }
```

`hostPreconditionFailure` keeps returning a reason string; a new `hostPreconditionKind(output)` maps the matched signature to a `kind`. `requiredAction` is a short imperative sentence the host can show verbatim (for example "Run `npx playwright install chromium` in ticket-1 with network access, then retry the run").

### D2. Playwright awareness in `environment.ts`

- `ENVIRONMENT_SIGNATURES` gains `/browserType\.launch: Executable doesn't exist at/i`, `/Looks like Playwright was just installed or updated/i` and `/ms-playwright[\\/](?:chromium|firefox|webkit|chromium_headless_shell)[-_]\d+/i`.
- `hostPreconditionFailure` gains `/Failed to download (?:Chrome for Testing|Chromium|Firefox|WebKit|chromium|firefox|webkit)/i` and `/Error: (?:getaddrinfo ENOTFOUND|connect ETIMEDOUT|ECONNRESET)[^\n]*(?:playwright|cdn\.playwright\.dev|playwright\.azureedge\.net)/i` → "the Playwright browser download cannot reach its CDN from the verification environment" (`kind: 'network'`).
- `plannedInstalls(root, failureOutput)` plans `{ ecosystem: 'node', command: <npx|pnpm exec|yarn>, args: ['playwright', 'install', <browser>] }` when the manifest declares `@playwright/test` or `playwright` and the failure output matches a Playwright signature. The browser is parsed from the missing path (`chromium_headless_shell-1243` → `chromium`, `firefox-…` → `firefox`, `webkit-…` → `webkit`); when none is parsable, install without a browser argument. `npx` resolves through `cross-spawn` like the other runners. The plan runs after the dependency install plan for the same root so a fresh worktree gets `node_modules` first.
- `installEnvironment` keeps the process environment as is. The Playwright plan carries a per-plan `timeoutMs` of 10 minutes (browser downloads are large); other plans keep the current 5-minute default.

### D3. Engine v2 verify piece repair flow

In `verifyPiece.execute`, after the first `executeVerification`:

1. `setup` (D4) ran before this point; a setup failure already returned.
2. If the receipt is invalid and a host precondition matches (`preconditionBlock`), produce the blocker (step 5).
3. Else if invalid, `guardrails['environment-repair'] !== false` and any failed command matches `isEnvironmentFailure`: emit progress `{ type: 'verification-output', payload: { text: '[environment] …' } }` for each install event, run `repairEnvironment`. A refused install (precondition) → blocker. At least one successful install → run `executeVerification` again with the same request; the second receipt replaces the first for all downstream logic (memory, fingerprint, diagnostics). Record `output.environmentRepair = { attempted: true, installs: [{ command, args, root, ok, detail }], reverified: boolean }`.
4. The no-progress fingerprint counts the final receipt only, so a repaired-and-passing run resets the counter as today.
5. Blocker result: `output.blocker = HostBlocker`, `output.valid = false`, `receipt` evidence kept. Outcome depends on `params.hostBlockers`:
   - `hostBlockers: true` → outcome `'blocked'`, `status: 'blocked'`, `error: { code: 'verification_host_precondition', message: blocker.reason + ' ' + blocker.requiredAction }`.
   - otherwise → outcome `'fail'` (legacy routing) with the same `output.blocker`, so a free-prompt fixer still receives the structured reason.
   `descriptor.getOutcomes(params)` returns `['pass','fail','failed','blocked']` when `params.hostBlockers === true`, else the current three. `paramsSchema` gains `hostBlockers: { type: 'boolean' }` and `setup: { oneOf: [{ const: 'configured' }, { type: 'array', items: verificationCommandSchema }] }`.
6. Progress text lines use the existing `verification-output` channel so Desktop's loop log shows `[environment] npx playwright install chromium (ticket-1)` and `Environment: installed …` without a new event type.

### D4. Runtime `setup` commands

- `RuntimeConfig.setup?: VerificationCommand[]` (same shape; `policy` is accepted but ignored). `config.ts` validates it with the same validator as `verification` (extract `validateCommandList(field)`), including the credential-in-env refusal and duplicate keys across `setup` and `verification`.
- The verify piece reads `params.setup === 'configured' ? deps.config.setup ?? [] : params.setup ?? []`, applies `withScopeDefault`, validates with `validateVerificationRequest({ kind: 'scoped', commands })` and runs them sequentially (`maxConcurrency: 1`) through `executeVerification` with `onEvidence` and progress wired exactly like checks, before the first verification run. The setup receipt is not a verification receipt: it never installs a verified candidate and is not fed to the no-progress fingerprint. Its command outputs are appended to `output.setup = { commands: [...diagnostics] }`.
- A failing setup command is a blocker `{ kind: 'setup', reason: 'setup command failed', requiredAction: 'Fix or remove the setup command … then retry' }` routed per D3.5. Exit `-1` keeps the infrastructure `failed` outcome.
- Setup runs on every visit of the verify node (idempotent by contract; the documentation says so). Reuse through snapshot-local policy is not applied.

### D5. Fixer and developer contracts

- `prompts.ts` `fixerSection` step 7 and 8: when the cause is a host precondition or environment blocker, return `blocker: { kind, command, cwd, evidence, requiredAction }` in the JSON, make no edits, and say in `summary` that no candidate change was made on purpose. Step 7 admits running the project's documented, idempotent toolchain install inside the admitted workspace (named example `npx playwright install <browser>`) when the host did not already repair it, without editing configuration.
- `boundarySection('developer')` second bullet: keep the configuration prohibition; add "Installing a documented, idempotent toolchain artifact inside the admitted workspace (a Playwright browser, a Python virtualenv) is allowed and must be reported in `verification`."
- `developerSection` step 4 gains: "Never validate with a temporary configuration, alternate runner or local browser the host verification plan does not use, and never delete such a file to hide it; the host runs the plan below as-is. When a required tool is missing, install it through the project's documented command or report it as a blocker."
- `developerTail` output contract documents the optional `blocker` object (same shape as `HostBlocker` minus `evidenceId`, plus free-text `evidence`).
- Custom roles: `roleInstructions` for a non-builtin role with `access: 'write'` appends the host plan block from `developerTail` (the "Core owns these complete verification commands" list only, not the output contract, which the host schema defines). `role-turn.ts` passes `verification` = configured checks for the repositories in scope plus the proposals from `params.additionalCommandsFrom`'s source output when present (resolved the same way `verify.ts` does; extract `resolveVerificationPlan(deps, context, params)` into `verify.ts` and import it). The hidden-plan gap that let the developer "pass" e2e with a temporary config closes because the developer now sees `npm run test:e2e` is a host check.

### D6. Completion and status surfacing

- `implicitCompletion` already uses `error.code` as the reason. For the `blocked` outcome the Desktop recipe maps to an `end` node whose `reason` interpolates `{{outputs.verify.blocker.requiredAction}}`; Core needs no completion change. `EngineCompletion` gains an optional `blocker?: HostBlocker` populated by the `end` piece when `params.blockerFrom` names a node whose output carries one (`end` params: `blockerFrom?: string`). Hosts read it from `completion.blocker` rather than parsing reasons.

## Risks / Trade-offs

- Running `playwright install` on the host downloads ~150 MB; bounded by the 10-minute plan timeout and only triggered by a matching failure. Offline hosts fail fast with a `network` blocker.
- `setup` on every verify visit costs time for slow commands; documented as idempotent-and-cheap. A later change can add snapshot-local reuse.
- The optional `blocked` outcome keeps old definitions valid; hosts opt in per node.
- Prompt edits change role behavior for all hosts using builtin roles; covered by `prompts.test.ts` assertions on the new sentences.

## Migration Plan

Additive. `setup` is optional; `hostBlockers` defaults to false; the fixer `blocker` field is optional in the output contract. Desktop vendors the schema in its paired change. No data migration.

## Open Questions

None blocking. Whether `setup` should gain snapshot-local reuse is deferred.
