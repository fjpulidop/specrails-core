# Core CI and publishing

Core's release workflow publishes the **same npm tarball that passed CI**. It does not rebuild a replacement package inside the publish step. These workflows do not run provider models or publish from pull requests.

## Quality gates

`CI` runs for pushes to `main`, pull requests to `main`, and manual dispatches. Feature branches are checked through their PR, avoiding two complete matrix runs for every update. The post-merge main push still runs the entire release gate. It has read-only repository permissions, cancels superseded runs on the same branch/PR, and has bounded job timeouts.

- Typecheck/build on the exact supported Node minimum, **20.19.0**.
- Full Vitest and release-guard tests on **Linux, macOS and Windows**, with **Node 20.19.0, 22 and 24**.
- Windows distributes the two slow runtime integration suites across three jobs by collected test locations; a fourth job runs every other test file. Parameterized cases stay together. The partition runner checks its selected inventory against Vitest before running, failing if any assigned test is missing or extra. Linux/macOS and coverage run the complete suite without partitioning.
- Coverage on Node 24 with the existing configured thresholds (not lowered).
- A checksum-verified actionlint binary validates workflow syntax, expressions and action inputs (shellcheck is not included).
- A checksum-verified Gitleaks binary scans Git history with redacted output.
- On Node 24 on each OS, `scripts/verify-package.mjs` packs the built package, checks its file inventory, installs the tarball into an isolated temporary consumer with lifecycle scripts disabled, and executes both published CLI entry points. It materializes/assembles all four providers and runs the assembled pipeline helper against four frozen fixture scopes. No global install, real project registry, provider login or model call is used.
- C1 adds a separate `engine-spikes` matrix on Linux x64, macOS arm64 (`macos-15`) and Windows x64, using Desktop's exact Node **22.22.3**. It runs the [engine decision probes](engine-v2/spikes/README.md), checks that prototypes stay out of the package, and exercises the real npm tarball on that Node. This lane does not repeat coverage or replace the supported Node/OS matrix. Evidence is retained for 14 days even on failure; a green local probe does not substitute for all platform artifacts or paired Desktop assembly acceptance. Runner architectures follow the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) and are asserted in the job.

The Linux package smoke uploads `core-package` for 14 days, containing the `.tgz` and `release-manifest.json` (package/version, Git SHA and SHA-512 integrity). The manifest is only written after the consumer smoke succeeds.

Local checks, after installing dependencies:

```sh
npm run ci                 # typecheck, guard regressions, coverage, packaged-consumer smoke
npm run test:scripts       # hermetic release and CI partition regressions
npm run check:package      # build and consumer smoke; prints its temporary artifact directory
# To choose where the verified tarball is kept:
node scripts/verify-package.mjs /absolute/path/to/temporary-package-output
# C1 experiments only, after build, using Node exactly 22.22.3:
npm run test:engine-spikes -- --output /absolute/path/to/engine-spike-evidence
```

To reproduce a Windows test partition locally, run `node scripts/ci-tests.mjs runtime-1` (or `runtime-2`, `runtime-3`, `general`). Add `--list-only` to a runtime partition to verify its inventory without executing tests.

The package check reuses the npm dependency cache (including the cache populated by `npm ci` and setup-node) with `--prefer-offline`; it may download missing production dependencies from npm. The temporary consumer, user configuration and credential isolation remain in place. Its generated output directory should be outside the checkout. Release-guard unit tests are hermetic and do not access npm or GitHub.

## Automatic release

1. A push to `main` starts `Release`. It waits for a successful `CI` **push run on the exact same main commit**, including the entire matrix, coverage, secret scan and package check. A success on an older commit or a PR does not qualify. Failed/cancelled CI fails the gate; waiting is bounded to 30 minutes.
2. An additional current-main check skips obsolete pushes before changing release metadata. Release Please opens/updates the release PR, or creates the release/tag after that PR was merged. It has only the repository/PR write permissions it needs. The CI jobs do not receive those permissions.
3. Before publishing, the workflow verifies that the stable `vX.Y.Z` tag points at the tested commit, that this commit is in `origin/main`, and that the tag, package.json, both root lockfile version fields and Release Please manifest agree. If main advanced while Release Please was working and it tagged a different SHA, publication fails closed.
4. It downloads the tarball from that successful CI run and verifies its identity and integrity. It refuses to move npm `latest` backwards. An existing version is accepted only when its published integrity matches the verified artifact exactly.
5. It publishes the `.tgz` with `--ignore-scripts --provenance --access public`, then sends downstream notifications. Only the publication job has `id-token: write`; the npm token is exposed only to the final publish step.

All automatic and manual releases share one non-cancelling concurrency group, so simultaneous runs cannot race the stable dist-tag.

## Credentials and notifications

- `RELEASE_PAT` (recommended): a repository-scoped token with permission to maintain release branches, PRs and releases (Contents and Pull requests write). Release Please prefers this secret, allowing its generated PR events to start the normal required CI. A GitHub App installation token with equivalent permissions is also suitable if the workflow is configured to mint one; this workflow does not create an App or credentials.
- `GITHUB_TOKEN` fallback: retained so existing installations can maintain release metadata without a new secret. GitHub currently creates runs for token-generated PR `opened`, `synchronize` and `reopened` events **in an approval-required state**. The workflow warns when using this fallback: a maintainer with write access must select **Approve workflows to run** on the release PR after bot updates. Configure `RELEASE_PAT` for automatic CI without that approval prompt; do not bypass required checks or branch protection. Other token-generated events, including tag pushes, remain suppressed. Repository settings must permit Actions to create PRs. Publication is in this same workflow and does not depend on a new tag-triggered run. See [GitHub's current event-triggering rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow). [Release Please also recommends a separate CI-capable credential](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs).
- `NPM_TOKEN`: existing token authentication remains supported; use a narrowly scoped token that can publish `specrails-core`. Do not remove it until npm trusted publishing has been configured for this repository and **`release.yml`**. Publishing runs on Node 24 and enforces npm >=11.5.1. The workflow requests OIDC and provenance but does not change npm account settings. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
- `CROSS_REPO_TOKEN`: must permit repository dispatch to `fjpulidop/specrails-desktop` and `fjpulidop/specrails-web`. It is available only to the notification job.

Both consumers receive `repository_dispatch` event `specrails-core-released`. Desktop receives `{"core_version":"X.Y.Z"}` and validates the exact released integration contract; the website retains its historical `{"core_version":"vX.Y.Z"}` convention. Notification failure leaves a visible failed workflow, even when npm publication already succeeded.

## Recover a failed publication or notification

Use **Actions → Release → Run workflow**, from the trusted main workflow, and provide an **existing** stable tag (`vX.Y.Z`). This path does not create a tag or bump versions. It checks main ancestry/version agreement, runs typecheck, release-guard tests and the full suite with coverage, then rebuilds, packs and consumer-tests that exact tag on Linux/Node 24 in a read-only preparation job. A separate publication job downloads those verified bytes; dependency installs and tests never have OIDC or npm credentials.

Manual recovery deliberately works without an old CI artifact. It does not rerun the full historical OS/Node matrix; normal automatic releases require that matrix. Tags predating these validation scripts cannot use this recovery path. If an identical version is already on npm, publication is skipped and both notifications are retried. Different bytes at that version, an older version than `latest`, missing tags or incompatible versions stop the run. npm versions are immutable; do not force around a mismatch.

For a failed initial CI gate, first repair/rerun CI for that commit, then rerun Release. Expired artifacts or a tag created at another main SHA can be recovered with the existing-tag manual path. If downstream notification failed, rerunning only its job is also sufficient and does not touch npm.

The workflows and hermetic fixtures validate the release machinery locally; successful native Windows/macOS CI, token permissions, OIDC configuration and a real publication can only be confirmed by their respective hosted runs.
