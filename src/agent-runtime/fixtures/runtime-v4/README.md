# Original workflow v4 runtime fixture

`core.tgz` was packed from specrails-core main `2427141b`, package 5.3.0, before implementing workflow5 (2026-09-13). Its executable behavior is the original workflow4/instructions6. Optional TypeScript declarations were added during the baseline build; they do not alter the original executable or protocol. This is a test artifact, not a published package or a claim about the provenance of existing customer runs.

The compatibility test creates a real request/checkpoint using this original runtime and records its package identity before continuing through Desktop. It never rewrites checksums or infers an arbitrary legacy run's original package. Dependencies are supplied by the test's installed package tree and copied into the retained snapshot; no provider inference or dependency download is performed.

The file's SHA-256 is pinned in the test. Updating this fixture requires an explicit compatibility decision and a new provenance record; do not regenerate it from the new runtime to make a test pass.
