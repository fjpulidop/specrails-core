# Engine v2 decision spikes (C1)

These experiments inform the proposed engine; they do not enable it. Production Core still supports Node 20.19.0 and uses the unchanged legacy runner. Prototypes live in `src/agent-runtime/engine/__spikes__/` as directly executable `.mjs` files, outside TypeScript build input, package files and production coverage. This makes the exact Node 22.22.3 experiment reproducible without introducing a production SQLite dependency.

Run `npm run test:engine-spikes -- --output <directory>` with Node 22.22.3. The JSON evidence records OS, architecture, versions, timing and assertions. The existing `npm run ci` remains mandatory. CI additionally verifies the real npm package on each spike platform; Desktop assembly acceptance remains a paired check and must be attached separately.

| Question | Report | Acceptance |
| --- | --- | --- |
| SQLite binding and real graph persistence | [01-sqlite.md](01-sqlite.md) | Every boundary of 200 nodes survives a killed process; actual graph pending writes and ledger stay atomic; WAL/private permissions; mean checkpoint put below 5 ms; packed/assembled runtime on three platforms |
| Nested graph APIs | [02-subgraphs.md](02-subgraphs.md) | Executable probes of interrupt/resume, fan-out, namespaces/history, internal fork, deferred join, retry, subgraph streams and transition limits |
| Post-commit event source | [03-streaming.md](03-streaming.md) | Measured fixture event timing and volume, comparison of streaming and committed ledger lifecycle, explicit mapping/decision |

The required platforms are macOS arm64, Linux x64 and Windows x64. A report file or successful local execution alone does not complete C1. All three platform artifacts plus Desktop assembly evidence are required before an accepted binding decision or C3 implementation. No CI lane calls a real provider.

Paired first-wave changes: [Core C0](https://github.com/fjpulidop/specrails-core/pull/385), [Desktop D0](https://github.com/fjpulidop/specrails-desktop/pull/706) and [Web documentation rollout](https://github.com/fjpulidop/specrails-web/pull/218). On 2026-09-26, the real Desktop bridge/Core legacy fixture passed with exact Node 22.22.3: twelve model calls, 120 initial tokens, 24 resume tokens, zero terminal replay tokens, malformed-review escalation, verification reuse, archive approval and unchanged host Git HEAD. This is legacy pairing evidence; it does not establish assembled v2 runtime acceptance.
