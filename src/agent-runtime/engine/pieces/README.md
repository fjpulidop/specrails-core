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

A blocked free prompt commits its provider response and invocation settlement
in one transaction before raising a human interrupt. Resume consumes that result
before sending a continuation. Up to 32 human continuations are admitted in one
visit, with every physical call charged to the same durable budget. The decider
uses actual evidence, declared obligations and no-progress limits; stopping
without proof never marks verification successful.

Captures and expression regexes use a constant VM script, 50 ms timeout, 200
pattern characters and at most 32,000 input characters. User input supplies only
data. Provider text, shell output and history are separately bounded.

## Verification and OpenSpec

`verify` and shell evidence reuse the real Core command runner, its isolated
verification environment, cancellation, deadlines, immutable evidence and
snapshot-local check reuse. General pieces never create `state.json`. A failed
command routes to `fail`; infrastructure failures route to `failed`. Zero-check
or explicitly uncovered receipts do not install a verified candidate. Ordinary
shell execution and shell evidence never certify the whole workflow.

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
