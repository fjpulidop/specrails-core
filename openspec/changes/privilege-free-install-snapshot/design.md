## Context

`withInstallRollback` (`src/installer/util/install-transaction.ts`) protects an install by copying a list of surfaces to a temp directory before running `apply()`, then restoring them if `apply()` throws. It takes that copy with:

```ts
cpSync(row.target, row.saved, {
  recursive: true, dereference: false, verbatimSymlinks: true,
  filter: () => true, mode: constants.COPYFILE_FICLONE,
})
```

With `dereference: false` + `verbatimSymlinks: true`, Node does not copy a link's contents. Its `cp` implementation reads the link and recreates it — `readlinkSync(src)` then `symlinkSync(resolvedSrc, dest)` — and it never passes a `type` argument. Node then autodetects `'file'` or `'dir'`, never `'junction'`. Creating a `'file'`/`'dir'` symlink on Windows requires `SeCreateSymbolicLinkPrivilege`; a junction does not. So on an ordinary Windows account the snapshot raises `EPERM` and the install dies before doing anything.

The surface list (`src/installer/commands/init.ts:343-347`) includes `<frameworkDir>/current`, which Core creates as a junction on Windows (`atomicSymlinkSwap`, `fs.ts:330`), and `<frameworkDir>/<version>`. `current` exists whenever the framework has already been materialized, which makes the failure deterministic rather than occasional:

| Entry point | `current` present at snapshot time | Windows without Developer Mode |
|---|---|---|
| specrails-desktop project add (materializes, then spawns `init`) | yes | always fails |
| `npx specrails-core init`, virgin machine | no | succeeds once |
| `npx specrails-core init`, any later run | yes | fails |
| Re-init over an assembled workspace (provider dirs hold junctions) | yes | fails |
| macOS / Linux | yes | unaffected — symlink creation is unprivileged |

The rest of the installer already encodes the correct rule. `symlinkOrCopy` (`fs.ts:287-300`) tries `'junction'` first on Windows for directories, copies files outright rather than attempting a privileged file symlink, and falls back to a copy; `copyDir` (`fs.ts:144`) skips link inodes by design. `install-transaction.ts` arrived in 5.1.0 (PR #334) and reached for `cpSync` instead, with no spec to hold it to the house rule.

Two constraints shape the fix. Node's `fs.cp` cannot express "copy this tree but recreate links as junctions", so the traversal has to be ours. And the snapshot must be safe to take on a machine that will never be able to create a link at all — a copy fallback at snapshot time is not sufficient, because restoring a copied stand-in over a junction would silently convert the framework pointer into a stale duplicate tree.

## Goals / Non-Goals

**Goals:**

- An install transaction that begins, protects, and rolls back without ever needing a privilege the platform may withhold.
- Restore that puts a pointer back as a pointer, using the mechanism the installer already uses to place one.
- A protected-surface set that matches what actually needs protecting, so the snapshot cost stops scaling with the size of the framework store.
- Regression coverage that fails on the current implementation while running on any OS, including the Linux jobs.

**Non-Goals:**

- Reworking the lifecycle lock, the reserved-path rules, or the `init` success path — this change touches how surfaces are captured and put back, nothing else.
- Making rollback restore link *identity* (inode, reparse-point flavour) rather than link *meaning*. A junction restored as a junction pointing at the same target is the contract; byte-level reparse fidelity is not.
- Changing behaviour on macOS or Linux.
- Fixing this on the desktop side. The desktop pins an exact Core version; a Core release plus a re-pin is the delivery path. The desktop's own diagnostic defects (a stderr tail that keeps the last five lines, so a stacked error arrives as five `at …` frames with the message discarded; a failed assemble degrading silently to the legacy path, which is why the user saw `Unknown command: /specrails:implement`) are real but belong to a separate change in that repo.

## Decisions

### Record links, don't reproduce them

The snapshot walks each surface itself instead of delegating to `cpSync`:

```
lstat(entry)
  ├─ symlink/junction → write the target path as a sidecar record next to the backup entry
  ├─ directory        → mkdir + recurse (a linked child hits the branch above)
  └─ file             → copyFile
```

Writing a text file is the only operation the snapshot performs for a link, so the snapshot phase becomes privilege-free by construction on every platform. Restore reads the record and calls the existing junction-aware primitive (`atomicSymlinkSwap` for the pointer shape, `symlinkOrCopy` for the general case), which already carries the Windows junction attempt and the copy fallback.

*Alternative — copy the link's contents at snapshot time.* Rejected: it destroys the distinction between "a pointer at version X" and "a tree that happens to look like version X". Restoring the copy would leave `current` as a real directory, and the next version swap would either fail or silently orphan it.

*Resolved during implementation:* the records are neither sidecars nor a manifest file. `snapshotTree` RETURNS them and the transaction holds them in memory for the lifetime of the call, which is the only lifetime they have. That removes the collision question entirely (nothing extra is written into the backup tree) and keeps the primitive usable outside a transaction. They still reach disk in the one case a human needs them: `recovery.json`, written when a restore fails, now carries each surface's links alongside its path.

*Alternative — keep `cpSync` and pre-check the privilege, degrading to a warning.* Rejected: it turns a deterministic bug into a machine-dependent one, and leaves Windows users with an install that silently cannot roll back.

### Stop copying `<frameworkDir>/<version>`, without stopping protecting it

`installFramework` (`scaffold.ts:673-681`) reuses a materialized provider tree only when the stamp matches on version, provider, source hash, and a content hash over the managed files; anything else falls through to a clean rebuild, and the rebuild itself stages into a temp directory before publishing. A half-written version directory therefore repairs itself on the next run — the snapshot was insuring a risk that is already covered, at the price of copying the whole framework store on every `init`.

What genuinely needs transactional protection is the *pointer*: `current` must not be left aimed at a version whose install failed. That stays in the set, and under the decision above it costs one recorded string.

*Resolved during implementation:* removing the version directory from the surface list outright would also have dropped a behaviour worth keeping — a rollback deletes a version directory the failed install CREATED. So the surface stays, marked `snapshotContents: false`: absent-then-created is still removed on rollback, and a pre-existing one is left alone instead of being copied and restored. That is strictly more conservative than deleting the entry, and it preserves the existing lifecycle test unchanged.

*Alternative — keep the version directory but snapshot it link-aware.* Correct but wasteful, and it keeps a multi-second copy on the critical path of every project add.

*Alternative — drop `current` too and let `ensureFramework` re-point it.* Rejected: the failure window is exactly the case where `ensureFramework` did not finish.

### Prove the denial instead of inheriting it

`lifecycle-admission.test.ts:40-44` already builds a real junction and drives it through `withInstallRollback`, and `ci.yml:73` already runs `windows-latest`. Both are green today, because GitHub's Windows runners execute as an administrator and `symlinkSync` therefore succeeds there. The blind spot is structural: no test that depends on the host's privileges can observe this class of bug, because the hosts that CI can rent are privileged.

Coverage moves to simulating the refusal — stub `fs.symlinkSync` to throw `EPERM` for every type except `'junction'`, then assert that a transaction over a linked surface still snapshots, still rolls back, and puts the pointer back at its original target. That runs on Linux, fails against the current implementation, and keeps testing the rule rather than the runner.

The existing junction test stays: it is still the real-filesystem check on Windows, and it now also documents that the privileged path must keep working.

## Risks / Trade-offs

- **A restore that falls back to copying leaves a real directory where a link belonged** → The fallback only triggers when no link mechanism at all is available, which is also a machine where the original could not have been a link. The stamped materializer replaces it on the next run; the rollback reports success because the *contents* are correct, which is what the caller needs.
- **Dropping the version directory from the protected set widens the blast radius if the stamp logic ever regresses** → The stamp is the mechanism the installer already trusts for reuse across projects and repeat installs; if it regresses, snapshotting `init`'s copy would not have saved a concurrent install anyway. The spec pins the self-repair expectation so a regression there is a spec violation, not a silent one.
- **Sidecar records could collide with a real file of the same name inside a snapshotted tree** → Records live in the backup directory, which is freshly created by `mkdtempSync` per transaction, and the naming needs a scheme that cannot collide with a copied entry. Worth deciding explicitly during implementation rather than assuming.
- **Windows path length** → The backup lives under `%TEMP%` and adds an index segment; deep provider trees plus a long temp path can approach `MAX_PATH`. Not introduced by this change, but the traversal is now ours, so long-path handling becomes our problem to keep working.

## Migration Plan

1. Land the fix in Core, released as a patch. There is no data migration and no on-disk format change — a backup directory only lives for the duration of one transaction.
2. Cut a Core release; the desktop bumps `CORE_BUNDLE_VERSION` in `.github/workflows/desktop-release.yml` and the vendored `scripts/assemble-bundled-core.lock.json` together, and ships a Windows build.
3. Rollback strategy: the change is contained to the snapshot/restore path and the surface list. Reverting restores the 5.1.0 behaviour, which is broken on Windows — so the real fallback if the fix misbehaves is the desktop pinning Core 5.0.0, which predates `install-transaction.ts` entirely and has no snapshot to fail.
4. No user action is required. A user currently blocked will see `init` succeed on the next attempt after updating.

## Open Questions

- ~~**Does the staging copy in `installFramework` (`scaffold.ts:692`) carry the same defect?**~~ Resolved: it uses the identical `cpSync` flags, but over the framework store, which holds real files only. Left as `cpSync` with an explicit invariant comment naming the trap and pointing at `snapshotTree`/`restoreTree` for the day the store gains a link.
- ~~**Sidecar naming.**~~ Resolved — see the Decisions section: the records are returned, not written.
- **Should the transaction refuse to start when it cannot protect a surface at all?** Today a snapshot failure aborts the install, which is what surfaced this bug. After the fix, snapshot failure should be genuinely exceptional — worth confirming that the remaining failure modes (unreadable directory, out of space) still deserve an abort rather than a degraded "install without rollback". Left open: nothing in this change alters that behaviour.
