## 1. Drift detection

- [x] 1.1 Add `semver` (and `@types/semver` as a dev dependency) to `package.json`, then regenerate the lockfile.
- [x] 1.2 Add `driftedNodeDependencies(root)` to `src/agent-runtime/compact/environment.ts`, following the spec:
  - direct dependency fields only;
  - skip non-semver specifiers;
  - read the installed `package.json` version;
  - `semver.satisfies` with `includePrerelease: false`;
  - never throw, and return at most 20 entries.
- [x] 1.3 Unit tests in `environment.test.ts` for each case:
  - a stale minor version, and a satisfied range;
  - `workspace:*`, `file:`, `npm:` aliases, git URLs and dist-tags;
  - an absent package (not reported), and an unreadable installed manifest;
  - a `||` range;
  - a prerelease installed against a stable range.

## 2. Install planning

- [x] 2.1 Make `plannedInstalls` plan the runner install when `driftedNodeDependencies(root)` is non-empty, in addition to the existing missing and absent conditions. Name up to five drifted packages in the outcome detail.
- [x] 2.2 Add tests: `prepareEnvironment` installs once for a drifted tree, and plans nothing for a healthy tree. Assert the outcome detail text.

## 3. Verify-time repair

- [x] 3.1 In `verification-repair.ts` and `engine/pieces/verify.ts`, treat a failed receipt as an environment failure when any failing command's `cwd` lies in a root with drift, behind the `environment-repair` guardrail. Reuse the single install and re-verify, and record the drifted packages in `environmentRepair`.
- [x] 3.2 Engine tests in `engine/pieces/verify.test.ts`:
  - lint fails with drift, so the host installs, re-verifies and passes;
  - drift persists after the install, so there is no second install and the progress line names the lockfile;
  - with the guardrail off, behaviour is unchanged;
  - with no drift, behaviour is unchanged.
- [x] 3.3 Integration test with a symlinked package entry inside `node_modules` (the warm-link shape) that resolves outside the root. After the install, the link target directory's contents must be unchanged.

## 4. Docs and checks

- [x] 4.1 Document drift repair next to environment repair in the runtime docs.
- [x] 4.2 Run `npm run typecheck`, the affected vitest suites and the full suite. Note in the Desktop follow-up that the next Core pin must regenerate the bundled lockfile (`scripts/assemble-bundled-core.mjs`).
