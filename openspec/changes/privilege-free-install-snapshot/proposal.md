## Why

`withInstallRollback` snapshots its protected surfaces with `cpSync(..., dereference: false, verbatimSymlinks: true)`. For a symlink or junction, Node does not copy the tree — it recreates the link with `symlinkSync(target, dest)` and never passes `'junction'`. On Windows that requires `SeCreateSymbolicLinkPrivilege` (admin or Developer Mode), so on an ordinary user account the snapshot throws `EPERM` **before** the install does any work, and `init` exits 1.

One of the snapshotted surfaces is `<frameworkDir>/current`, which Core itself creates as a junction on Windows (`atomicSymlinkSwap`, `src/installer/util/fs.ts:330`). Any `init` that runs after the framework has been materialized therefore fails deterministically. That is every specrails-desktop project add — the desktop materializes the framework before spawning `init` — and every repeat `npx specrails-core init`. The module landed in 5.1.0 (PR #334); 5.0.0 has no `install-transaction.ts`, so this is a regression in the version the desktop app now bundles.

The rest of the installer already solves this correctly: `symlinkOrCopy` (`fs.ts:287-300`) tries a junction first on Windows and falls back to a copy, and `copyDir` skips link inodes outright. The transaction layer is the one place that bypassed those primitives — and it has no spec, so nothing flagged the divergence.

## What Changes

- **Snapshot and restore become privilege-independent.** A link is never *recreated* to back it up: the transaction records its target and restores it through the existing junction-aware primitive. Snapshotting requires no filesystem privilege on any platform.
- **The framework version directory leaves the protected surface set.** `<frameworkDir>/<version>` is materialized through a content-hash stamp that already self-repairs a partial tree (`installFramework`, `src/installer/phases/scaffold.ts:673-681`) and already stages through a temp directory. Copying it on every `init` bought no safety and cost a full framework copy per run. `<frameworkDir>/current` stays protected — as a pointer, which is all it ever was.
- **The regression becomes visible to CI.** The existing coverage (`lifecycle-admission.test.ts`) creates a real junction and runs on `windows-latest`, but GitHub's Windows runners are administrators, so `symlinkSync` always succeeds there and the failure mode is invisible. New coverage simulates the denial instead of depending on the host's privileges, so it runs on Linux and fails on the current implementation.
- **The transaction layer gets a spec.** `withInstallRollback` and `withFrameworkLifecycleLock` shipped with no requirements of their own; the privilege rule and the rollback guarantees are written down.

## Capabilities

### New Capabilities
- `install-transaction`: the crash-safety contract around a Core install — which surfaces are protected, how they are snapshotted and restored, what rollback guarantees hold, and the requirement that none of it depend on filesystem privileges the target platform may withhold.

### Modified Capabilities
<!-- None. `update-system` still describes the retired `update.sh` bash era and is not the home for this behaviour. -->

## Impact

- `src/installer/util/install-transaction.ts` — snapshot/restore path (the `cpSync` at the top of `withInstallRollback`).
- `src/installer/util/fs.ts` — gains the link-preserving snapshot/restore primitive alongside `symlinkOrCopy` / `atomicSymlinkSwap`.
- `src/installer/commands/init.ts` — the `surfaces` list.
- `src/installer/commands/lifecycle-admission.test.ts` (+ new tests) — privilege-denial coverage.
- Downstream: unblocks specrails-desktop project add and rail launches on Windows. The desktop bundles an exact Core version (`CORE_BUNDLE_VERSION` in `desktop-release.yml`), so shipping the fix needs a Core release and a re-pin there. No desktop code change is required for the crash itself.
- No behaviour change on macOS/Linux, and no change to the lock protocol, the reserved-path rules, or the `init` success path.
