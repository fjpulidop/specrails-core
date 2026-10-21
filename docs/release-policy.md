# Release channels and API policy

This policy lets a team upgrade specrails-core without surprises. It covers the npm
channels, how the Desktop ⇄ Core contract is versioned and how features are retired.
The release machinery itself is described in [CI and publishing](ci-cd.md).

## Channels

| npm dist-tag | What it points at | Who should use it |
|---|---|---|
| `latest` | Every release, published automatically by the `Release` workflow after a green CI run on `main`. | Desktop development builds and anyone who wants fixes first. |
| `stable` | A release published at least **7 days** ago, with no follow-up patch of the same minor in that week, and whose tag CI is green. Promoted **monthly**, by hand. | Teams that prefer fewer, settled upgrades. The Desktop `stable` channel pins this tag. |

```sh
npm install specrails-core@stable
npm view specrails-core dist-tags
```

### Promoting `stable`

Once a month, a maintainer runs **Actions → Promote stable → Run workflow** with the version
to promote. Leave **dry_run** checked first. That run reports the guard results and does not
change npm. Then run it again with **dry_run** unchecked. The workflow
([promote-stable.yml](../.github/workflows/promote-stable.yml), script
[promote-stable.mjs](../scripts/promote-stable.mjs)) never publishes, rebuilds or tags. It
only runs `npm dist-tag add specrails-core@<version> stable`, and only when all of these hold:

- The version is a published `X.Y.Z` release and is not deprecated.
- It is not newer than `latest` and not older than the current `stable`, so `stable` never moves backwards.
- It was published at least 7 days ago.
- No newer patch of the same minor was published within 7 days of it. A quick follow-up
  patch signals an incident. For example, 6.6.4 is not eligible if 6.6.5 followed it within
  that week. A newer minor does not disqualify it.
- The `CI` push run on `main` for its `vX.Y.Z` tag commit completed successfully.

The workflow reads publish times from the npm registry document, the same data as
`npm view specrails-core time --json`.
Pick the newest version that passes. If no version qualifies, skip that month. The job shares the
`core-release` concurrency group with publication, so the two never race on npm dist-tags.
It uses the `NPM_TOKEN` secret. The token needs permission to manage dist-tags for
`specrails-core`, and is not exposed during a dry run.

A security fix can be promoted outside the monthly cadence. The 7-day window still applies.
If a vulnerability needs a faster fix, release a patch and point `stable` users to `latest` in
the advisory instead of bypassing the guard.

## Contract versioning

`integration-contract.json` is the contract Desktop reads to negotiate with Core. Its
`schemaVersion` is `MAJOR.MINOR`:

| Change | Required bump | Commit |
|---|---|---|
| Additive: new key, provider, capability, node kind, event type, CLI operation or optional field | minor (`5.2` → `5.3`) | normal `feat:`/`fix:` |
| Removal of any key or array member (capability, node kind, event type, provider, builtin…) | major (`5.3` → `6.0`) | `!` in the header **or** a `BREAKING CHANGE:` footer |
| Change of a value's type, or a value whose meaning narrows (fewer accepted values, stricter pattern, different default behaviour) | major | `!` or `BREAKING CHANGE:` |
| Editing, adding or removing a free-text annotation: a value under a `description`, `note`, `notes` or `documentation` key | none required | normal |

Every other content change bumps `schemaVersion`. The bump tells Desktop to re-read the
contract. Annotations are documentation for humans. Desktop never parses them, so they are
exempt. Any other string is a contract value, however prose-like it reads. For example,
`agentRuntime.specificationFormat` states how specs are archived. Changing that meaning needs
at least a minor bump, and a major bump when it narrows what Desktop can rely on.

The `contract-policy` CI job runs [check-contract-bump.mjs](../scripts/check-contract-bump.mjs)
on every pull request. It compares the contract at the PR base and head:

- Content changed but `schemaVersion` did not increase: the job **fails**.
- A key or array member was removed, or a value changed type, and the major was not bumped:
  the job **fails**.
- The same breaking change with a major bump, but no `!`/`BREAKING CHANGE:` in any commit of
  the range or in the PR title: the job **fails**. The PR title counts because squash merges
  use it as the commit header.
- Other changed values are listed in the job log for review. The script cannot tell whether
  a new value narrows semantics. The author and the reviewer decide, and choose the major
  rule when in doubt.

To run the same check locally:

```sh
node scripts/check-contract-bump.mjs --base origin/main --head HEAD
```

### What Desktop can rely on

- **Gate on capabilities, not versions.** Before using a feature, Desktop checks that the
  contract advertises it, for example `agentRuntime.sessions.capabilities`,
  `agentRuntime.nodeKinds`, `agentRuntime.sessions.eventTypes` or `agentRuntime.cliOperations`.
  It degrades gracefully when the entry is absent. Unknown additions are ignored, so a
  minor bump never breaks an older Desktop.
- **Treat a higher major as incompatible.** When `schemaVersion` has a higher major than the
  one Desktop was built for, Desktop refuses that Core or falls back to its bundled Core.
- **Pair the change.** Any contract change needs a paired Desktop change (see
  [CONTRIBUTING.md](../CONTRIBUTING.md)). Desktop validates the contract in the PR that
  advances its Core pin.

## Deprecations

A capability, CLI flag, contract entry or runtime output that Desktop or users depend on is
not removed without warning:

1. Announce it in a release under a **Deprecations** heading in `CHANGELOG.md`. Use a
   `deprecate(<scope>): …` commit, which release-please lists in that section. Name the
   replacement and the earliest version that may remove it.
2. Keep it working for at least **two minor versions** after the announcement. For example,
   a feature deprecated in 6.7.0 still works in 6.8.x and 6.9.x. The removal is breaking, so
   it ships with `!`/`BREAKING CHANGE:` and release-please makes it a new major. Contract
   entries also need a major `schemaVersion` bump, as described above.
3. Do not promote to `stable` a release that removes something `stable` users were never warned about.
