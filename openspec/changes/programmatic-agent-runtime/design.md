## Context

Core owns verified domain state; Desktop owns workspaces and delivery. The programmatic path will invoke isolated roles while retaining the legacy pipeline. New infrastructure is LangGraph.js (MIT), Node filesystem persistence and native HTTP tooling. macOS and Windows and all four existing CLI providers are release requirements.

## Goals / Non-Goals

**Goals:** reusable typed runtime; durable, bounded phase execution; real provider extensibility including local OpenAI-compatible models; existing Core gates; CLI and Desktop entry points; offline tests.

**Non-Goals:** paid orchestration services, automatic deployment, importing ai-agent-dev's Jira/Kubernetes coupling, replacing every legacy chat/loop transport, claiming an OS sandbox for ordinary Node file tools.

## Decisions

- Keep engine, executors and Core host separate under src/agent-runtime. LangGraph owns traversal; one run lease owns mutation. Store explicit versioned step receipts and events atomically; no implicit remote tracing.
- A generic workflow callback API lets the Core host invoke architect, developer, deterministic verification, reviewer and archive. Never nest the complete implement command inside a phase.
- Core pipeline gates remain the approval authority. On resume, recheck domain evidence; committed engine outputs cannot waive invalidated receipts. Interrupted writes require explicit recovery; read-only steps may retry within limits. Version/input mismatches reject resume.
- Config schemaVersion 1 has enabled, providers, agents (architect/developer/reviewer), limits, verification commands and optional approvalBeforeArchive. Providers are CLI (claude/codex/gemini/kimi) or openai-compatible with URL and optional apiKeyEnv reference. Custom executors register programmatically. New runtime config is distinct from legacy profile v1.
- API tool loop uses portable Node fs with canonical allowed roots and read/write policies; arbitrary shell is not model-accessible. Only configured check commands can execute. Model names are opaque provider identifiers; local endpoints need no API key.
- The CLI exposes config validation, run, status and resume with structured JSONL events. Domain host preserves frozen repository scope and existing delivery ownership. Environment secrets never enter run snapshots or logs.

## Risks / Trade-offs

- Crash after edits before receipt -> explicit interrupted recovery, stable attempt IDs, domain gate revalidation.
- CLI usage availability differs -> preserve unknown values; no fabricated zero spend or strict dollar guarantee for opaque CLIs.
- Framework update -> pin dependencies and workflow version, reject incompatible resumes.
- Endpoint tool support differs -> fail explicitly on invalid results/tool arguments/turn exhaustion.
- Windows processes and spaces -> platform-aware argv transport and process-tree cancellation tests; no POSIX-only scripts.

## Migration Plan

Legacy commands remain intact. Projects activate runtime config explicitly. Package runtime with Core; Desktop discovers a compatible local/bundled runtime and fails clearly if enabled but missing. Runs pin configuration and resume from stored scope. Existing projects can disable for future runs without reassigning active run ownership.
