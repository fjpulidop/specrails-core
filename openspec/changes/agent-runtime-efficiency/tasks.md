## 1. Verification ownership
- [x] 1.1 Update and version developer instructions; test the unchanged authoritative Core verification gate.

## 2. API workspace tools
- [x] 2.1 Implement bounded search, numbered range reads, scoped diff and exact-match atomic patches.
- [x] 2.2 Exercise tools through the API executor and test role permissions, ambiguous/stale edits, symlinks and truncation.

## 3. Efficiency accounting
- [x] 3.1 Preserve optional cache counters and record provider invocation duration and tool calls, including failures and repairs.
- [x] 3.2 Derive per-phase metrics from the durable ledger and expose them through status and result; test unknown usage and resume accounting.

## 4. Desktop and validation
- [x] 4.1 Pass optional metrics through Desktop and render localized run totals and phase detail with legacy compatibility.
- [x] 4.2 Document measurement semantics and baseline evaluation procedure; run focused and repository CI checks and review the final diffs.
