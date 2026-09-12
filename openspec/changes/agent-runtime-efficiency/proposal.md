## Why

The runtime asks the developer to repeat the full verification that Core subsequently owns, while API agents must read and rewrite entire files. Existing aggregate usage cannot explain retry costs, cache reuse or time per phase. Remove this avoidable work before changing models or quality gates.

## What Changes

- Reserve complete verification for Core; developers run focused tests during iteration.
- Add bounded text search, line-range reads, workspace diff and exact-match patches to the API workspace tools.
- Preserve optional cache usage and provider invocation measurements through attempts, failures and resumes; expose a compact per-phase efficiency report in Core and Desktop.
- Keep the runtime opt-in, evidence gates and existing provider configuration compatible.

## Capabilities

### New Capabilities
- `agent-runtime-efficiency`: Efficient workspace operations, host-owned final verification, and durable usage and timing reports.

### Modified Capabilities
None. The initial programmatic runtime specification remains in its active change; these are additive requirements.

## Impact

Core agent prompts, workspace tools, executors, workflow attempt records and CLI status/results; Desktop runtime run summaries and settings UI. No new runtime dependency or model calls. Later work includes adaptive model selection, structured review severity, incremental review and parallel verification; these require separate evaluation.
