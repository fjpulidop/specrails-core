## 1. Schema and parsing

- [x] 1.1 Add `graph/review-brief.ts`: `REVIEW_BRIEF_SCHEMA`, `parseReviewBrief` (validation, bounds, severity sort, cap 5, overflow), `riskFinding`, `settleReviewBrief`.
- [x] 1.2 Add `brief` to `REVIEW_OUTPUT_SCHEMA` and the reviewer output-contract instructions; bump `ROLE_INSTRUCTIONS_VERSION` to 15.

## 2. Reviewer node and exposure

- [x] 2.1 Reviewer `accept`: strict on the first reply, drop-with-diagnostic after the repair; overflow risks to `acceptance.findings`; gate untouched.
- [x] 2.2 `ReviewRecord.brief` / `briefDiagnostic`; `confidence-score.json` `brief` on approval.
- [x] 2.3 `graph/review-brief-record.ts`: write `review-brief.json` at every verdict; `runtime-result.reviewBrief`.
- [x] 2.4 Compact reviewer passes a `brief` through.

## 3. Contract and docs

- [x] 3.1 `runtime api` capability `reviewBrief: 1`; `integration-contract.json` 5.3 with `agentRuntime.reviewBrief` and instructions 15; parity tests.
- [x] 3.2 `docs/agent-runtime.md` "Reviewer risk brief" section with the exact host locations.

## 4. Tests

- [x] 4.1 Unit: absent/empty/full brief, malformed cases, sort/cap, bounds, Codex strict round-trip, gate unchanged, record read/write.
- [x] 4.2 Integration (core host): full brief, absent brief, repaired brief, dropped after repair with diagnostic, high risks still approve with overflow findings, rejected verdict recorded.
- [x] 4.3 `npm run ci`.
