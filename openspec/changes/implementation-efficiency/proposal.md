## Why

Implementation cost includes repeated context, correction cycles and unsuccessful runs, not just the successful model response. The current runtime has sound deterministic gates, but repeatedly sends repository context, cannot admit developer-discovered checks, loses temporary harness evidence and cannot distinguish genuine session continuation from a returned session ID.

## What Changes

- Preserve the five-phase workflow and official OpenSpec role workflows, while making handoffs and correction prompts proportional to the current work and actual transport capabilities.
- Admit additive structured developer verification proposals and persist harnesses and execution evidence outside the deliverable.
- Bind results to the exact plan, candidate, harness and declared execution inputs; reuse only explicitly eligible results and schedule only host-declared independent checks concurrently.
- Add explicit per-role escalation and effort configuration with capability validation, bounded deterministic triggers and unchanged quality gates.
- Record prompt volume, correction causes, actual route choices and executed/reused checks; define a reproducible baseline/candidate evaluation measuring cost per independently accepted implementation.
- Version new behavior and negotiate capabilities; protect saved executions from silent prompt, model or evidence migration.

## Capabilities

### New Capabilities
- `efficient-role-execution`: Capability-aware handoffs, proportional planning, bounded corrections and configured escalation.
- `reproducible-verification`: Additive check proposals, durable harness/evidence, plan binding, conservative reuse and independent scheduling.
- `implementation-efficiency-evaluation`: Versioned measurements and reproducible quality/cost evaluation.

### Modified Capabilities

None. These additive runtime capabilities build on the existing workflow gates; delivery ownership and OpenSpec semantics remain unchanged.

## Impact

TypeScript runtime configuration, schemas, provider adapters, graph state/nodes/prompts, verification receipts and CLI status/capabilities; deterministic fixtures and documentation. Desktop consumes the paired capabilities and projections. No new agent role, inference service or mandatory testing dependency. Browser automation and personal provider-configuration isolation are separate changes.

Planning only in this change preparation. Implementation is requested for GPT-6 Astra with reasoning effort medium; that is the coding assistant selection, not the runtime's per-role model policy.
