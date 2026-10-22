## 1. Scanner

- [x] 1.1 `src/pipeline/spec-trace.ts`: slugs and ids, canonical requirements, change deltas (ADDED/MODIFIED/REMOVED/RENAMED), tag scanning, test discovery, receipts, report, CLI.
- [x] 1.2 `specrails-core pipeline trace` with Core reachability; copy to `.specrails/runtime/spec-trace.mjs` and `trace.mjs`; built-ins-only architecture rule.

## 2. Runtime

- [x] 2.1 Verify node writes `spec-trace.json` bound to the receipt; `VerificationRecord.specTrace`; acceptance finding.
- [x] 2.2 Developer `## Requirement tags`; reviewer check 3 (missing tag is an issue), check 9 and `brief.divergences`; trace in the verification feedback; `ROLE_INSTRUCTIONS_VERSION` 17.
- [x] 2.3 Drift sweep reference definition.

## 3. Contract and docs

- [x] 3.1 `runtime api` capability `specTrace: 1`; `runtime-result.specTrace`; `integration-contract.json` 5.5; parity tests.
- [x] 3.2 `docs/agent-runtime.md` "Requirement traceability".

## 4. Tests

- [x] 4.1 Unit: slugs with accents and symbols, two languages, missing receipt, failing command, renamed requirement, untagged tags, globs, CLI `--check`, context receipts.
- [x] 4.2 Core host: tagged requirement demonstrated and shown to the reviewer; untagged requirement reported without failing verification.
- [x] 4.3 Installed `trace.mjs` and `specrails-core pipeline trace`; drift sweep definition publishes and runs read-only.
- [x] 4.4 `npm run ci`.
