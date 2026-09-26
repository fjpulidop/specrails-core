# Engine v2 decision spikes (C1)

These experiments inform the proposed engine; they do not enable it. Production Core still supports Node 20.19.0 and uses the unchanged legacy runner. Prototypes live in `src/agent-runtime/engine/__spikes__/` as directly executable `.mjs` files, outside TypeScript build input, package files and production coverage. This makes the exact Node 22.22.3 experiment reproducible without introducing a production SQLite dependency.

Run `npm run test:engine-spikes -- --output <directory>` with Node 22.22.3. It rebuilds the legacy runtime before measuring its callback baseline, so stale `dist` output cannot qualify. The JSON evidence records OS, architecture, versions, timing and assertions. The existing `npm run ci` remains mandatory. CI also verifies the real npm package and paired Desktop assembly on each spike platform.

The same CI job checks out Desktop at `70c9e8a4a7fbc26b89ed5ac724aed97dfcc27d9f`, installs its locked production dependencies without lifecycle scripts and runs `scripts/check-engine-spike-assembly.mjs --desktop <checkout> --dest <outside Core source> --output <assembly-evidence.json>`. The wrapper verifies the exact assembler inputs, invokes Desktop's real source assembly and records Desktop/Core commits, source-bundle and lock hashes, and the staged runtime identity. This checks a locked development source assembly, not a fabricated registry release or v2 shipment.

On Windows the spike creates a protected ACL for its disposable directory containing only the current user's SID and SYSTEM. It then inspects the actual SQLite database ACL and rejects broad access. The policy is experimental and applies only to test directories; production private-storage policy remains an engine implementation responsibility. POSIX uses and verifies 0700/0600 modes.

| Question | Report | Acceptance |
| --- | --- | --- |
| SQLite binding and real graph persistence | [01-sqlite.md](01-sqlite.md) | Every boundary of 200 nodes survives a killed process; actual graph pending writes and ledger stay atomic; WAL/private permissions; mean checkpoint put below 5 ms; packed/assembled runtime on three platforms |
| Nested graph APIs | [02-subgraphs.md](02-subgraphs.md) | Executable probes of interrupt/resume, fan-out, namespaces/history, internal fork, deferred join, retry, subgraph streams and transition limits |
| Post-commit event source | [03-streaming.md](03-streaming.md) | Measured fixture event timing and volume, comparison of streaming and committed ledger lifecycle, explicit mapping/decision |

The required platforms are macOS arm64, Linux x64 and Windows x64. A report file or successful local execution alone does not complete C1. All three platform artifacts plus Desktop assembly evidence are required before an accepted binding decision or C3 implementation. No CI lane calls a real provider.

## Accepted evidence (2026-09-26)

[CI run 36230546712](https://github.com/fjpulidop/specrails-core/actions/runs/36230546712) passed every spike, real package and pinned Desktop assembly gate on all three platforms. The tested merge commit is `72323bf9d62dbf856cdc6d60471b8c0b2a0fe8a9` for PR head `e1e25589fb89660aaa9d80cd73980401050f0a54`; each artifact records a clean checkout and the identical measured source digest `8df8b11980d708efa9d04349fcfd2788822ec1e5916f1f24ba8ef087cf2a7990`.

| Platform | Completed crash boundaries | Mean checkpoint put | Private storage | Package / Desktop assembly |
| --- | ---: | ---: | --- | --- |
| macOS arm64 | 200 | 0.282 ms | Directory 0700, SQLite 0600 | Passed / passed |
| Linux x64 | 200 | 0.721 ms | Directory 0700, SQLite 0600 | Passed / passed |
| Windows x64 | 200 | 4.164 ms | Protected ACL; owner SID equals current user; only owner and SYSTEM have FullControl | Passed / passed |

Select candidate A, `node:sqlite`, for C3 and set its minimum to **Node >=22.22.3**, the exact version exercised here. Do not infer acceptance of earlier Node 22 releases. Candidate B was unnecessary because A met every exit criterion; no unmeasured comparison is claimed. This experiment PR preserves production Node 20 support; the Node minimum changes with the production v2 implementation.

Complete local `npm run ci` also passed: 66 files, 998 tests passed and one pre-existing skip; statements 86.60%, branches 78.78%, functions 91.02%, lines 92.29%. The actual tarball passed both CLI entries, four provider assemblies and four frozen runtime journals. Coverage thresholds were unchanged. C3 still owns production attempt identities, leases, fork history, receipts and concurrency acceptance.

Paired first-wave changes: [Core C0](https://github.com/fjpulidop/specrails-core/pull/385), [Desktop D0](https://github.com/fjpulidop/specrails-desktop/pull/706) and [Web documentation rollout](https://github.com/fjpulidop/specrails-web/pull/218). On 2026-09-26, the real Desktop bridge/Core legacy fixture passed with exact Node 22.22.3: twelve model calls, 120 initial tokens, 24 resume tokens, zero terminal replay tokens, malformed-review escalation, verification reuse, archive approval and unchanged host Git HEAD. This is legacy pairing evidence; it does not establish assembled v2 runtime acceptance.
