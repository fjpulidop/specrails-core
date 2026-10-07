## 1. Shared repair helpers and Playwright awareness

- [x] 1.1 Add Playwright environment signatures, the browser-download precondition and `hostPreconditionKind` to `src/agent-runtime/compact/environment.ts`; plan `playwright install <browser>` (npx/pnpm exec/yarn) after the dependency plan for roots declaring `@playwright/test` or `playwright`, parsing the browser from the missing path; per-plan 10-minute timeout. Unit tests in `environment.test.ts` for each signature, the browser parse, the offline precondition and the plan order.
- [x] 1.2 Create `src/agent-runtime/verification-repair.ts` with `HostBlocker`, `installRoots`, `checkoutRelative`, `hostPreconditionMessage`, `preconditionBlock` (structured) and `repairEnvironment`; make `graph/nodes.ts` import them with unchanged behavior. Unit tests for `preconditionBlock` kinds and `repairEnvironment` outcomes with a fake spawn.

## 2. Engine v2 verify piece

- [x] 2.1 Add `hostBlockers` and `setup` params to the `verify` descriptor with `getOutcomes` adding `blocked` only when `hostBlockers === true`; extract `resolveVerificationPlan(deps, context, params)`.
- [x] 2.2 Implement setup execution before verification (sequential, scoped, evidence and progress wired, `output.setup`), setup failure → `kind: 'setup'` blocker.
- [x] 2.3 Implement precondition classification, guardrail-controlled environment repair with `[environment]` progress lines, single re-verify, `output.environmentRepair`, `output.blocker` and the `blocked`/`fail` routing per `hostBlockers`.
- [x] 2.4 Engine tests (`engine/pieces/verify.test.ts`, new): Playwright failure repaired and re-verified; offline download → blocker (`blocked` with flag, `fail` without); registry 401 → credential blocker without installs; plain assertion failure unchanged; guardrail off; setup success and failure; validator accepts legacy ends and rejects unmapped `blocked` when the flag is set.

## 3. Configuration and completion contracts

- [x] 3.1 Add `setup?: VerificationCommand[]` to `RuntimeConfig` (`executor-types.ts`) and validate it in `config.ts` through a shared `validateCommandList`, including cross-list duplicate keys; tests in `config.test.ts`.
- [x] 3.2 Add `HostBlocker` and `EngineCompletion.blocker?` to `engine/contracts.ts`; `end` piece accepts `blockerFrom` and copies the blocker; test in `pieces.test.ts`.

## 4. Role prompts and host plan visibility

- [x] 4.1 Update `prompts.ts`: fixer steps 7 and 8 (structured `blocker`, intentional no-change, documented toolchain install), developer boundary bullet, developer step 4 temporary-bypass rule, `developerTail` output contract with `blocker`; render the host plan block for custom write roles. Tests in `prompts.test.ts`.
- [x] 4.2 `role-turn.ts` passes the resolved verification plan (configured checks plus `additionalCommandsFrom` proposals read from the definition's verify node) to `roleInstructions` for write roles; test with a custom role in `pieces.test.ts` or a new `role-turn.test.ts`.

## 5. Documentation and verification

- [x] 5.1 Document `setup`, `hostBlockers`, the blocker shape and the repair flow in `docs/` (runtime configuration and engine pieces README) and in `src/agent-runtime/engine/pieces/README.md`. (verify/setup/blocker/repair areas done; prompt-contract docs belong to 4.x)
- [x] 5.2 Run `npm run typecheck`, `npm run lint` and the agent-runtime test suites; record results in the change progress. (2026-10-07: typecheck clean; no lint script in Core; `npx vitest run src/agent-runtime` → 79 files, 895 tests passed; `npm run build` OK.)
