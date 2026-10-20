# Original workflow v4 runtime fixture

`core.tgz` was packed from specrails-core main `2427141b`, package 5.3.0, before implementing workflow5 (2026-09-13). Its executable behavior is the original workflow4/instructions6. Optional TypeScript declarations were added during the baseline build; they do not alter the original executable or protocol. This is a test artifact, not a published package or a claim about the provenance of existing customer runs.

The compatibility test creates a real request/checkpoint using this original runtime and records its package identity before continuing through Desktop. It never rewrites checksums or infers an arbitrary legacy run's original package. Dependencies are supplied by the test's installed package tree and copied into the retained snapshot; no provider inference or dependency download is performed.

The file's SHA-256 is pinned in the test. Updating this fixture requires an explicit compatibility decision and a new provenance record; do not regenerate it from the new runtime to make a test pass.

## OpenSpec 1.4.1 dependency fixture

The original runtime pins OpenSpec 1.4.1 exactly and refuses another version. Core now pins 1.14.3, so the test tree no longer provides it. A real retained install keeps its own copy: Desktop retains a run's Core package with its resolved dependency closure. `openspec-1.4.1.tgz` stands in for that copy. It was built on 2026-10-20 with `npm install --omit=dev --ignore-scripts @fission-ai/openspec@1.4.1`, placing in the package's own `node_modules` every dependency whose version the current Core tree does not satisfy and dropping source maps and type declarations. The test extracts it below the original package's `node_modules/@fission-ai/`, so only that package resolves it.

It contains braces 3.0.3 (GHSA-vfj7-8cjw-p6xm, via fast-glob), the advisory that motivated the 1.14.3 upgrade. It is inert test data, outside the npm dependency tree, and the test only runs OpenSpec's fixed spec-driven globs. Its SHA-256 is pinned in the test too.
