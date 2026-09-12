## Context

LangGraph coordinates durable roles, but the architect is read-only and Core manufactures architecture documents. CLI providers have different skill discovery and permission surfaces. OpenSpec 1.4.1 is the supported external version; its CLI, generated skills and project rules are the source of truth.

## Goals / Non-Goals

**Goals:** Run authentic ff/apply/verify workflows within the roles, enforce scope, validate real artifacts and preserve durable recovery and acceptance evidence.

**Non-Goals:** Restore legacy command orchestration or interpret old full-document archives as deltas. OpenSpec structural validation does not replace implementation tests or review.

## Decisions

- Pin the external OpenSpec dependency. Generate official skills with its CLI in an isolated preparation directory and record content/version identity.
- Add an explicit OpenSpec role execution context to the executor request. Each adapter explicitly loads the exact official skill document through scoped tools. Current headless transports use documented skill-document adaptation; they do not claim native slash-command activation.
- Expose bounded OpenSpec operations over a local stdio tool bridge for CLI roles. This is necessary because granting unrestricted shell/write tools to ff would break the architect's read-only code boundary. The tools execute the real CLI and author-selected writes; Core does not generate document content.
- Keep architect repository tools read-only; allow artifact writes through the bounded bridge. Developers retain their existing repository boundary; reviewers cannot author artifacts.
- Replace architect document output with summary/confidence/verification metadata. Gate advancement on framework status, apply instructions, structural validation and nonempty artifacts, retaining candidate-bound tests and acceptance.
- Archive using OpenSpec itself; verify/reconcile partial archive effects before retrying. Freeze CLI/skill identity with durable state and reject incompatible old checkpoints explicitly.

## Risks / Trade-offs

- Provider capabilities differ: preflight and adapter tests must fail clearly when scoped tools cannot be exposed.
- A skill may ask a question: map that to the existing role question result and LangGraph interruption rather than an unavailable interactive UI.
- The CLI discovers planning roots: reject roots outside the admitted context; do not silently redirect to another project.
- External updates may alter generated skills: exact pin plus frozen digests prevent silent drift.

## Local reference patterns

Use `graph/roles.ts` for invocation accounting and recovery, `cli-executor.ts` for provider argv, `workspace-tools.ts` for confined paths, and Desktop `providers/kimi-skill-prompt.ts` for expanded skill activation. Existing `verifyPipeline` receipts and `recordAcceptance` remain independent gates.
