# Workflow pieces

`createPieceRegistry(dependencies)` binds the reviewed catalog to one execution.
`validationPieceRegistry()` returns the same schemas, outcomes and effect rules
without initializing providers, project state or a pipeline journal. Executing
an effect from that catalog fails with `read_only`.

The compiler owns `component`, `map`, `join` and `implementation` composition.
Their catalog entries describe their contracts; execution always uses actual
LangGraph child graphs and the parent's SQLite saver. Other pieces receive a
bounded state snapshot and narrow provider, evidence, budget, session and
interrupt ports. They cannot add new executable kinds from definition JSON.

## Provider turns and quality

Free prompts set instruction/artifact policy explicitly, including native skill
commands. Declared roles reuse Core's context, compact policy, routing and single
structured-output repair. Provider invocation start and settlement remain the
accounting authority. Missing token/cost measurements stay unknown. Session
state is private to a node except native implementation phases: developer and
fixer share role state within the same implementation scope, preserving legacy
continuation without sharing between map branches.

Apply- and verify-bound turns receive the pinned skill plus real status/apply
context before provider execution. The fresh host-origin trace satisfies these
read-only prerequisites even if a reviewer only reads code and returns its report.
It does not grant writes, certify the review or bypass structured-output,
candidate, verification or acceptance gates. Missing context blocks the turn.

A blocked free prompt commits its provider response and invocation settlement
in one transaction before raising a human interrupt. Resume consumes that result
before sending a continuation. Up to 32 human continuations are admitted in one
visit, with every physical call charged to the same durable budget. The decider
uses actual evidence, declared obligations and no-progress limits; stopping
without proof never marks verification successful. A blocked decider saves its
read-only result before asking a human; answering resumes the continue branch
without calling that decision again, and records the answer in history.
Malformed non-question output keeps the existing single-repair policy.

Captures and expression regexes use a constant VM script, 50 ms timeout, 200
pattern characters and at most 32,000 input characters. User input supplies only
data. Provider text, shell output and history are separately bounded.

A `role-turn` for a role with write access renders the complete host
verification plan in its instructions: the configured checks for the
repositories in scope plus, when the optional `verificationProposalsFrom`
param names a committed node output, that output's `structured.verification`
proposals for repositories without a configured check (the same admission rule
the `verify` piece applies to `additionalCommandsFrom`), deduplicated. Read-only
roles receive no plan block. The turn never runs those commands.

## Verification and OpenSpec

`verify` and shell evidence reuse the real Core command runner, its isolated
verification environment, cancellation, deadlines, immutable evidence and
snapshot-local check reuse. General pieces never create `state.json`. A failed
command routes to `fail`; infrastructure failures route to `failed`. Zero-check
or explicitly uncovered receipts do not install a verified candidate. Ordinary
shell execution and shell evidence never certify the whole workflow.

Before returning `fail`, `verify` classifies an invalid receipt through the
shared host-repair helpers (`src/agent-runtime/verification-repair.ts`, also
used by the legacy graph). A host precondition (registry credentials or
reachability, a missing environment variable, git credentials, a Playwright
browser download that cannot reach its CDN) becomes a structured `HostBlocker`
in `output.blocker` without any install. An environment failure (a missing
tool, module, dependency or Playwright browser build) runs the planned installs
once, narrated on the `verification-output` channel with the `[environment]`
prefix, then re-runs the same plan; the second receipt alone decides the outcome
and the no-progress fingerprint, and `output.environmentRepair` records the
attempt. The `environment-repair` and `lockfile-repair` guardrails switch the
installs off; precondition classification always applies. A blocker routes to
the opt-in `blocked` outcome (`hostBlockers: true`, `status: 'blocked'`,
`verification_host_precondition`) or, without the flag, to `fail` with the same
output so older definitions keep their exact `ends`.

Verification that rewrites candidate files itself (a lint pre-step that
regenerates a tracked mapping) is not a code failure. The receipt names the
files (`selfMutation`, from a manifest diff around the run); when every command
exited 0 and the `verification-output-adoption` guardrail is on, the piece keeps
the files in the candidate and verifies once more. A valid second receipt passes
with `output.adoptedOutputs`, which role turns show the reviewer and fixer as
host-adopted output they must not revert. Output that changes again, or the
guardrail switched off, is a `nondeterministic-output` blocker
(`verification_nondeterministic_output`) routed to `blocked` or `failed`, never
to a correction round.

Optional `setup` commands (`'configured'` reads `config.setup`; an inline list
has the `verification` shape) run sequentially in the admitted workspace before
the first verification of every visit. Their scoped receipt is evidence only:
it never installs `$verified` or feeds the no-progress counter. A failing setup
command is a `setup` blocker and no verification command runs for that visit.
An `end` with `blockerFrom: <nodeId>` copies that node's committed blocker
(`output.blocker`, or a correction role's `output.structured.blocker`) into
`completion.blocker`.

Failed check outputs include bounded verbatim failure facts and immutable evidence
IDs. Native/legacy implementation feedback uses the same fact extractor, retaining
the expected assertion and application location even when a suite's source dump
or passing tail fills its output excerpt. Full evidence remains available through
the scoped evidence tool; summaries never alter exit codes or receipt validity.

OpenSpec validation and archive call Core's pinned CLI. Archive prepares a
write set and checks every preimage before publication; a replay checks the
saved write set and archive tree. The Quick SDD fixture validates, applies,
verifies, archives and verifies the final candidate again. It does not infer
success from a provider sentinel alone.

## Native implementation and recovery

`implementation.ts` adapts the existing six Core nodes and their acceptance,
verification, review, convergence and archive gates. `implementation-compiler.ts`
registers them individually on the parent's saver. No nested legacy JSON
workflow host exists. Every native child state update and its durable terminal
marker share the SQLite checkpoint transaction.

Explicit archive approval resumes by checking completed nodes and repeating
verification/review as the legacy host does. Unchanged approved work can reuse
that consent; changed work must pass the gates and obtain fresh consent.

Standalone implementation retains the original journal and change identity.
Component/map instances derive identities from the parent run, scope and node;
ticket/repository items narrow only the frozen admitted context. These journals
remain sibling directories under the original backlog root. Registered runtime
and OpenSpec artifact exclusions prevent sibling metadata and project-store
writes from changing a candidate. No unregistered run or source path is ignored.
Native scoped receipts retain their original evidence and cannot certify the
parent candidate. Component and Batch examples verify globally after the child
or join and enforce `delivery.requiresVerified` at the root.

Each native terminal also publishes `childUpdate.journal`, a manifest for
immutable content-addressed journal, verification, change and main-spec bytes.
Objects are flushed before the terminal transaction; unused objects after a
crash are harmless. The manifest is capped at 1 MiB, with at most 8192 files and
256 MiB of referenced bytes. Native child checkpoint state is capped at
1,750,000 bytes and fails explicitly instead of truncating recovery state.

For an unfinished native implementation, fork reads only objects referenced by
the selected checkpoint manifest. It creates a fresh journal/change, rebinds the verification plan, retains completed
architecture/development and invalidates verification, review and archive
approval. `projectImplementationFork` supplies the actual child state reset for
public LangGraph checkpoint APIs. A private main-spec baseline lets the pinned
CLI prepare the new archive while publication still refuses conflicting current
preimages. Only the pinned CLI's exact autogenerated Purpose placeholder retains
the source change ID, including recursive forks; authored text is never normalized.
Completed implementations at the selected parent cut inherit historical evidence
without restoring a journal or repeating providers. Source journal, database,
events and evidence bytes are unchanged.
The shared worktree can change as the fork runs; a fresh inspection or later
resume of the original must detect those changes and reverify them.

Focused tests cover real native/legacy parity, approval replay, immutable fork
cuts, branch bindings, candidate isolation, Quick SDD, actual command evidence,
provider accounting, bounded captures and the published example definitions.

## Scoped control variables

The non-AI assign piece sets JSON values and increments initialized safe integer
counters. It produces one atomic vars update through the existing terminal
commit; it never writes a parallel state store. Invalid or overlapping updates
fail before commit, and map scopes do not share mutable variable objects.
This supports bounded workflow controls without multiplying provider nodes.
