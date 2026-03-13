---
change: automated-test-writer
type: feature
status: proposed
github_issue: 6
vpc_fit: 70%
---

# Proposal: Automated Test Writer Agent

## Problem

Test coverage is a consistent trailing indicator in AI-driven development pipelines. The current specrails implement pipeline (architect → developer → reviewer) produces working implementations but leaves test authorship to the developer agent — and developers, AI or otherwise, tend to deprioritize tests under time pressure.

The symptoms are predictable:
- **Coverage gaps ship**: The reviewer validates CI conformance but has no mandate to enforce test coverage thresholds.
- **Test writing is interruption-heavy**: When a developer does write tests, context-switching between implementation and test authorship degrades the quality of both.
- **Pattern inconsistency**: Without a dedicated pass, test style diverges from the project's existing test patterns — wrong naming conventions, wrong assertion library imports, missing edge cases.

The net result: test coverage becomes a reviewer concern after the fact, requiring fix cycles, or worse, a permanent gap that accumulates sprint over sprint.

## Solution

Add a `test-writer` agent that runs as a dedicated pipeline phase between the developer and reviewer. The agent:

1. Reads the implemented code and the task description that produced it.
2. Reads the project's existing test patterns to match style, structure, and framework.
3. Detects the target repo's test framework automatically (Jest, pytest, RSpec, Go test, etc.) from standard manifest files.
4. Generates unit tests, integration tests, edge case tests, and error handling tests.
5. Targets >80% coverage for new code.
6. Writes test files following the project's naming and co-location conventions.

Claude already excels at test generation. This agent is primarily orchestration — giving test writing a dedicated phase with the right context and the right mandate.

## Scope

**In scope:**
- New agent template: `templates/agents/test-writer.md`
- Generated specrails instance: `.claude/agents/test-writer.md`
- New pipeline phase: Phase 3c (Test Writing) inserted between Phase 3b (Implement) and Phase 4 (Merge & Review)
- Framework detection: reads `package.json`, `requirements.txt`, `Gemfile`, `go.mod`, `Cargo.toml` to identify test runner and conventions
- Agent memory directory: `.claude/agent-memory/test-writer/MEMORY.md`
- Updates to `templates/commands/implement.md` and `.claude/commands/implement.md`
- Updates to Phase 4e report table (add `Tests` column)

**Out of scope:**
- Mutation testing or coverage instrumentation tools
- Snapshot testing generation
- Load or performance test generation
- End-to-end/browser test generation (UI layer only)
- CI enforcement of coverage thresholds (no CI exists yet)
- Auto-fix of tests that fail post-generation (that is the reviewer's mandate)

## Non-goals

- The test-writer does NOT run or verify test output. It writes tests; the reviewer runs them.
- The test-writer does NOT replace the developer's judgment on what needs testing. It supplements.
- The test-writer does NOT modify implementation code to make it more testable. If code is untestable as written, it flags that as a note in its output.

## Acceptance Criteria

1. `templates/agents/test-writer.md` exists with correct `{{PLACEHOLDER}}` syntax and YAML frontmatter.
2. `.claude/agents/test-writer.md` exists with all placeholders resolved for the specrails repo.
3. Phase 3c is present in `templates/commands/implement.md` and `.claude/commands/implement.md`, positioned after Phase 3b and before Phase 4.
4. The test-writer agent launches after each developer agent completes (or after all developers complete in multi-feature mode).
5. Framework detection logic covers: Jest/Vitest, pytest, RSpec, Go test, Rust (cargo test), PHPUnit.
6. The agent reads existing test files to match patterns before generating new ones.
7. The Phase 4e report table includes a `Tests` column.
8. The `test-writer` is always-on (not a flag). Rationale: skipping tests defeats the purpose of the agent; it should always run.

## Motivation

VPC fit score: 70%. Alex (Lead Dev, 4/5) and Kai (DevOps/Platform, 4/5) both rate this highly. The feature directly addresses the trust gap between "AI generated this code" and "this code is safe to ship" — coverage evidence is the bridge.

Sara (Product Owner, 1/5) gives it low weight, which is expected: test coverage is an engineering concern, not a product discovery concern. The agent adds pipeline phases that the product owner does not see.
