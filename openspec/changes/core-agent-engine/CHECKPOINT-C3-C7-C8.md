# Detailed checkpoint — persistence, forks, memory, controls and evaluation

Date: 2026-09-26. Worktree `/private/tmp/specrails-core-engine-v2` is shared.
Root owns the combined commit/PR. This is work in progress, not full initiative acceptance. See `CHECKPOINT.md` for the global continuation plan.

## Ownership and implemented files

core_planning owns `src/agent-runtime/engine/checkpoint/{database,ledger,lease,saver}.ts`, adjacent tests/README and crash fixtures; `storage/private-path.ts`; `store/sqlite-store.ts` and tests/README; `steering/inbox.ts` and tests/README; `otel.ts`, tests and telemetry guide; `fork.ts` and `fork.test.ts`; evaluation extensions/corpus and two published implementation fixtures. Focal memory additions in `pieces/{role-turn,verify,ports,project-memory}.ts` and `pieces.test.ts` were coordinated with C6 owner.

Root owns runs, CLI, composition, execution, dependencies, events, invocation context, budgets and efficiency summary. C6 owner owns native implementation compilation, journal snapshot/restore and OpenSpec archive behavior. Do not overwrite their changes.

Persistence uses selected `node:sqlite` on Node >=22.22.3. Terminal markers and LangGraph pending writes commit atomically; whole snapshots follow separately. Public task IDs bind the ledger without parsing opaque checkpoint namespaces. Leases fence late results; read-only opens do not mutate ACLs. Private Windows storage grants owner+SYSTEM, POSIX directories/files use 0700/0600.

Provider usage remains unknown if a call has started without settlement. Reservations survive crashes, recovery and forks. Partially unknown settlement keeps residual bounds for missing dimensions, and never represents bounds as billed usage. `reservationStatus()` exposes running calls, known reservation bounds and unknown bounds. Efficiency events contain actual startedAt/finishedAt. Shared `session:` state uses a validated ancestor owner within one scope, preserving developer/fixer continuation and isolating branches.

Project store is real public BaseStore SQLite with narrow per-piece permissions, no embeddings and no certification reuse. Role notes/session metadata are advisory; verify always executes actual commands. Steering is durable, bounded (20,000 UTF-16 units/80,000 bytes; 128 pending/512 KiB), claimed at attempt admission and idempotent. OTLP export is optional, metadata-only, bounded and best effort.

## Persistence APIs and important invariants

- `RunDatabase.open(filename,{create?,readOnly?})`: private path validation, WAL/FULL, foreign keys, 5-second busy timeout. Read-only access never chmods or sets ACLs. Transactions are synchronous and reject nested promises.
- `RunDatabase.rowsAt(revision)` and `forkAt(destination,{revision,runId,omitPieceStatePrefixes?})`: append-only row postimages/tombstones reproduce the full historical cut. All checkpoint namespaces and serialized blobs remain intact. Source is opened read-only and reserves an inactive writer during the copy; source business rows and bytes remain unchanged. Default omitted state prefix is `session:`; control inbox/provider sessions are not inherited.
- `RunLedger.enter(NodeAdmission)`: public thread/checkpoint/task identity yields a stable visit; physical attempts are durable. Confirmed failed/blocked results replay before fresh budget admission. Identical old terminal digests are no-ops across fork/lease epochs.
- `terminal` proposes evidence; saver `putWrites` confirms pending writes, terminal result, candidate/receipt and ordered events in one transaction. Serializer/provider work is outside that transaction; observer failure cannot roll it back.
- `prepareInterruption` plus actual `__error__` keeps uncertain writes recoverable, never completed. Human `__interrupt__` pauses without repeating physical provider work. `answerInterrupts` persists exact answers before `Command.resume` and rejects changed replies.
- `scopeSnapshot('*')` reads all scopes without N+1 queries. `activeDurationMs` excludes human pause and caps dead-owner activity at lease expiry. `settlePause()` is called after graph invocation so completed siblings cannot leave a human pause marked running.
- `startInvocation` reserves shared budget and returns per-attempt ordinal. `settleInvocation` can atomically persist a bounded provider-result memo. Missing settled cost keeps its cost bound; missing tokens keep the original bound minus known tokens. Fully known dimensions release their reservations. Budget lower bounds never impersonate billing.
- `readScopedPieceState`/`writeScopedPieceState` only share `session:` keys with a validated ancestor owner in the same scope. Other node state remains run/scope/node isolated; immutable `memo:` values are bounded to 2 MiB.
- Only explicit eligible verification from `verify`/`implementation` can install a full valid receipt matching candidate revision/hash, actual commands and no unverified repositories. Invalid/scoped receipts remain evidence; explicit `verified:null` invalidates proof.

## Fork protocol and latest test state

`forkRun(directory,{fromNodePath,runId,scopeId?,visit?,state?,registry?})` exists and root wired CLI flags `--from`, `--run-id`, `--scope-id`, `--visit`, `--state`. It selects the exact visit's `before_revision`, opens source read-only, copies historical rows/checkpoint blobs/namespaces, suppresses inherited accounting, retains spent/reserved budget, omits provider sessions/control inbox and publishes a private destination SQLite file. State patches permit only bounded `$vars`/`$outputs` and invalidate verified state.

- Completed implementations retain original receipts and logical `CandidateState.scope`; do not rebind journals or repeat providers merely for a new run ID. Actual code edits invalidate inherited proof. Root implemented protected scope snapshots and inherited fingerprinting.
- Incomplete implementations restore exact immutable journal snapshots, rebind only the destination and update the real child graph checkpoint. Verification/review/archive are revalidated; completed architect/developer phases are retained.
- Explicit fork restart authorizes inherited unfinished reads/coordinators even when the original retry maximum was one. Repository-writing child tasks still require explicit recovery. This fixed nested branch `retry_exhausted` at a valid historical cut.
- New destination root, child journal and final SQLite directory receive explicit private permissions/ACLs before publication. `mkdir(mode)` alone is insufficient on Windows.

Latest full fork run: **5/6 passed** (source journal bytes unchanged; root patch/resume; lease rejection; nested siblings; late ask and end with zero provider repeats; modified code invalidation; patched inputs invalidate proof). The remaining test is `restores the exact incomplete implementation journal and preserves its completed architect`: architecture is retained and only developer+reviewer execute, but archive conflicted on pinned OpenSpec's autogenerated Purpose containing the new fork change ID.

C6 owner subsequently fixed ONLY the exact autogenerated Purpose normalization using private baseline sourceChange, preserving all-byte conflict guards and authored text. The first fix missed the CLI's collapsed blank line; the final pattern corrects it. Their focused **7/7 tests and typecheck passed**; **the real incomplete fork test still needs rerunning after the final fix**. No `dist` rebuild is necessary for that direct source test. Run it first:

```sh
PATH=/private/tmp/specrails-engine-tools/node-v22.22.3-darwin-arm64/bin:$PATH node_modules/.bin/vitest run src/agent-runtime/engine/fork.test.ts -t 'exact incomplete implementation' --maxWorkers=1
```

## Verified evidence and remaining gates

- Latest ledger/store/inbox run: **25/25 passed** (includes residual cost/token reservation tests).
- Production checkpoint + crash run: **22/22 passed**, including six actual SIGKILL boundaries. Build before crash fixtures; they import production `dist`. Boundaries: before effect, before pending writes, inside pending-write/ledger transaction, after pending writes, after aggregate snapshot, provider started before settlement. POSIX asserts SIGKILL; Windows asserts an immediately durable fault marker and absence of kill-failure/graceful-cleanup markers.
- Earlier actual role/verify memory tests: **20/20 passed**; evaluation tests **3/3 passed**; actual loopback OTLP collector **3/3 passed** with local socket permission.
- Core typecheck and build passed before latest root/C6 changes; root coordinates final checks.
- Full offline native evaluation initially accepted **10/10 outputs** without extra invocations. It exposed lost developer/fixer session continuity; scoped session fix restored it. Root's latest focused correction report `/private/tmp/core-engine-v2-focused-correction/evaluation.json` measures **2879 → 1595 bytes (44.60%)**, both outputs accepted, no extra invocation. Root owns full corpus/CLI acceptance. Synthetic fixture usage does not prove paid monetary savings.
- Prompt captures remain under `/private/tmp/core-engine-v2-correction-prompts/prompts/verification-correction-0-{full,optimized}/`, including `03-developer-fixer.txt` and JSON section-byte breakdown. The earlier 30% report was diagnostic, not target acceptance.
- C1 three-platform binding/packing/Desktop assembly acceptance is separately recorded in C1 PR386. It does not replace production robustness acceptance.

Root has remaining C3 production robustness: real CLI run→SIGKILL before/after/during write→resume/recover; two-process CLI contention; SIGTERM cancellation with resumable checkpoint; production Linux/macOS/Windows CI plus packed runtime. CLI now returns structured fatal EngineError JSON; status includes actual lease and exact recoverable attempt IDs. Do not mark C3 or the entire initiative complete before these and paired integration checks pass.

No commits were made by core_planning in the shared production worktree. Desktop D4 partial code and exact next steps are recorded in the paired Desktop `openspec/changes/core-agent-engine/CHECKPOINT.md`.
