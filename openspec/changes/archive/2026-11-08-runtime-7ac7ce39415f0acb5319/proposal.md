# Proposal

## Why

Guided recovery rejects engine v2 runs that have a valid run.sqlite but no legacy checkpoint, preventing operators from inspecting and repairing preserved work. Recovery must use the saved engine's authority and preserve its original worktree and safety gates.

## What Changes

- Detect v2 and legacy stores at their actual on-disk locations and normalize saved status without converting either format.
- Support inspect, history, list_files, read_file, diff, guarded patch and saved checks for failed v2 implementation runs, sharing existing path protection, write-ahead history, replay and retry guards.
- Use v2's fenced execution lease for mutations; keep observational actions read-only with respect to run.sqlite. Refuse unsafe or ambiguous v2 actions with actionable recovery_unsupported_engine errors.
- Preserve structured unsupported errors through Core CLI and Desktop's subprocess bridge; return HTTP 409 with the distinct recovery_unsupported_engine code and recommendation.
- Preserve legacy recovery and Desktop's idle gate.

## Capabilities

### New Capabilities

- `guided-run-recovery`: Engine-aware inspection and minimal repair of preserved runs, including safe failures and Desktop error propagation. The main capability inventory is empty; this is one cohesive spec covering all seven actions.

### Modified Capabilities

None.

## Impact

Core recovery, a focused engine adapter, CLI error serialization and adjacent tests; Desktop recovery transport/controller and tests; both runtime recovery guides. No provider calls, new dependencies, request actions, schema migrations, checkpoint edits, regenerated worktrees or changes to resume/relaunch/fork. Existing Attempt history shape and location remain unchanged.
