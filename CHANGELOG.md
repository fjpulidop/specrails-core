# Changelog

## [3.3.1](https://github.com/fjpulidop/specrails-core/compare/v3.3.0...v3.3.1) (2026-03-27)


### Bug Fixes

* configure release-please with config file and sync VERSION ([#197](https://github.com/fjpulidop/specrails-core/issues/197)) ([3d70bf1](https://github.com/fjpulidop/specrails-core/commit/3d70bf1fc06d4f4f80c9be5d148bf18b6afa742f))
* set include-component-in-tag to false for release-please ([#199](https://github.com/fjpulidop/specrails-core/issues/199)) ([49566eb](https://github.com/fjpulidop/specrails-core/commit/49566eb7b15f0eee37ed2f497cfc4e008ea4e5fb))


### Code Refactoring

* remove hub/dashboard-only openspec archives and specs ([#195](https://github.com/fjpulidop/specrails-core/issues/195)) ([eca985a](https://github.com/fjpulidop/specrails-core/commit/eca985a700f5fef67d2ca8e57bfa8e0b795ac3bb))
* remove sr:health-check skill template and references ([#193](https://github.com/fjpulidop/specrails-core/issues/193)) ([be7ca61](https://github.com/fjpulidop/specrails-core/commit/be7ca611bb4ca41563ebc36fe77c94d689aea3ae))
* remove web-manager template and hub integration artifacts ([#191](https://github.com/fjpulidop/specrails-core/issues/191)) ([0c6782c](https://github.com/fjpulidop/specrails-core/commit/0c6782c2d3c15242dd52e3e0bd1d83a4afccd2db))
* resolve unresolved stack placeholders and update gitignore (SPEA-709) ([#196](https://github.com/fjpulidop/specrails-core/issues/196)) ([354c20e](https://github.com/fjpulidop/specrails-core/commit/354c20e23a153df0eeafc685eed1eec0c964c4ea))


### Documentation

* consolidate getting-started guides and fix prerequisite contradictions ([#194](https://github.com/fjpulidop/specrails-core/issues/194)) ([a368bd8](https://github.com/fjpulidop/specrails-core/commit/a368bd8d11a5584af29d023261e7920decb04c30))
* fix documentation inconsistencies and stale content ([#192](https://github.com/fjpulidop/specrails-core/issues/192)) ([adaeb70](https://github.com/fjpulidop/specrails-core/commit/adaeb707b1744214a63fca349e40e76d88ac3169))
* remove hub and dashboard references from documentation ([#190](https://github.com/fjpulidop/specrails-core/issues/190)) ([fdcb046](https://github.com/fjpulidop/specrails-core/commit/fdcb046ae4ab4c7732e020d2f9361853b23dc1a8))

## [3.3.0](https://github.com/fjpulidop/specrails-core/compare/v3.2.0...v3.3.0) (2026-03-27)


### Features

* full wizard as /setup default, --lite for quick mode (SPEA-697/698) ([#188](https://github.com/fjpulidop/specrails-core/issues/188)) ([96a7e6c](https://github.com/fjpulidop/specrails-core/commit/96a7e6cd7884ec15d454e7f74998c752ad1f465e))

## [3.2.0](https://github.com/fjpulidop/specrails-core/compare/v3.1.0...v3.2.0) (2026-03-23)


### Features

* add local ticket management system (Phase 1.1-1.2) ([#183](https://github.com/fjpulidop/specrails-core/issues/183)) ([8fb4dce](https://github.com/fjpulidop/specrails-core/commit/8fb4dce4bc31d7622ac11f963431a99a02a256d2))
* add local ticket provider to command templates (Phase 1.4) ([#184](https://github.com/fjpulidop/specrails-core/issues/184)) ([73e3ef5](https://github.com/fjpulidop/specrails-core/commit/73e3ef536371d4c50a1c6e05f25ddd1d176c3c64))

## [3.1.0](https://github.com/fjpulidop/specrails-core/compare/v3.0.0...v3.1.0) (2026-03-22)


### Features

* add coverage tooling + expand test coverage ([#177](https://github.com/fjpulidop/specrails-core/issues/177)) ([1e0eab4](https://github.com/fjpulidop/specrails-core/commit/1e0eab4dbaef323b3435114df991c28106d6dca5))
* Codex skills installer + Agent Teams commands ([#176](https://github.com/fjpulidop/specrails-core/issues/176)) ([a4ef830](https://github.com/fjpulidop/specrails-core/commit/a4ef83003548acadf00b27f400dea04243f8c7bf))

## [3.0.0](https://github.com/fjpulidop/specrails-core/compare/v2.1.3...v3.0.0) (2026-03-22)


### ⚠ BREAKING CHANGES

* All commands renamed from /<name> to /specrails:<name>. All agent files renamed from <name>.md to sr-<name>.md. Existing installations are auto-migrated by update.sh.

### Features

* add --provider CLI flag to install.sh arg parser (SPEA-517) ([44dac30](https://github.com/fjpulidop/specrails-core/commit/44dac30b6bd5de7a3bfa94da3625f2246c659c1a))
* add --root-dir parameter to install.sh for monorepo support ([77cd24b](https://github.com/fjpulidop/specrails-core/commit/77cd24bdc805c884532c8e25b028ee0ed210a031))
* add --yes flag to install.sh for non-interactive mode ([29173cd](https://github.com/fjpulidop/specrails-core/commit/29173cdca11c9b02f0a91eb59efd7dd64ae4ff79))
* add /specrails:propose-feature command template for Feature Proposal Modal ([756ed30](https://github.com/fjpulidop/specrails-core/commit/756ed3061091bd532f8e7c6558cfa52fa5297ae9))
* add agent confidence scoring & validation framework ([#37](https://github.com/fjpulidop/specrails-core/issues/37)) ([b95f97f](https://github.com/fjpulidop/specrails-core/commit/b95f97fda91f8fedd4b9f75dcebe327023a73e23))
* add agent personality customization (backlog [#15](https://github.com/fjpulidop/specrails-core/issues/15)) ([#115](https://github.com/fjpulidop/specrails-core/issues/115)) ([f87e2dd](https://github.com/fjpulidop/specrails-core/commit/f87e2dd8520331e2b9662ae74f49a444386a7d0e))
* add agent post-mortem & failure learning loop ([#39](https://github.com/fjpulidop/specrails-core/issues/39)) ([e6c519a](https://github.com/fjpulidop/specrails-core/commit/e6c519a3e5e349293dfb7b7365b861269ff4e7e5))
* add agent workflow system and product-driven development setup ([98ab9f5](https://github.com/fjpulidop/specrails-core/commit/98ab9f520b9559ac059234e0d5a21ceb347d918d))
* add AI-powered in-context help system ([#45](https://github.com/fjpulidop/specrails-core/issues/45)) ([bd0a337](https://github.com/fjpulidop/specrails-core/commit/bd0a3373f4cf4e16aaed56a703d2351f41be1c18))
* add automated test writer agent (Phase 3c in implement pipeline) ([959b485](https://github.com/fjpulidop/specrails-core/commit/959b48530f9954940810654c8b98447bed5f5af3))
* add backlog sync conflict detection ([#41](https://github.com/fjpulidop/specrails-core/issues/41)) ([0bb1421](https://github.com/fjpulidop/specrails-core/commit/0bb14211c16a5e53e7497589c36b30cc99afcaff))
* add backwards compatibility impact analyzer ([#44](https://github.com/fjpulidop/specrails-core/issues/44)) ([13255d8](https://github.com/fjpulidop/specrails-core/commit/13255d8af4cc6ebe9d506d936d1d0e8ab754788f))
* add batch implementation orchestrator (/batch-implement) ([eb2a81b](https://github.com/fjpulidop/specrails-core/commit/eb2a81b0d757789f0e40f8e31a451dcd3a62b5d3))
* add column headers to RecentJobs table ([42c33de](https://github.com/fjpulidop/specrails-core/commit/42c33de52440c7ae6c6362786810157628e3a80f))
* add date range filter to RecentJobs ([6151321](https://github.com/fjpulidop/specrails-core/commit/6151321d2eb90d3871dd4accccef1e775ea2bbea))
* add doc-sync agent for automated documentation updates ([#7](https://github.com/fjpulidop/specrails-core/issues/7)) ([66f18ac](https://github.com/fjpulidop/specrails-core/commit/66f18ac0bdfd7603fe4dd545459816ad934493bb))
* add dual permissions config generation for Codex support (SPEA-508) ([7d32bcf](https://github.com/fjpulidop/specrails-core/commit/7d32bcff647abec7b1a5076f28b2439658ea5f6d))
* add dual-format agent generation for Codex compatibility (SPEA-509) ([7b398fd](https://github.com/fjpulidop/specrails-core/commit/7b398fd483d12e34362a678a03a877af9da754d3))
* add health-check dashboard command for quality monitoring ([#9](https://github.com/fjpulidop/specrails-core/issues/9)) ([4b1e846](https://github.com/fjpulidop/specrails-core/commit/4b1e8468d7edf89af569d149f0039319d13d7aa8))
* add JIRA integration for project labels and epic grouping ([ec054a4](https://github.com/fjpulidop/specrails-core/commit/ec054a4e5647c7536c3d43beb4755f8a734e5882))
* add job queueing with kill support to web-manager ([#59](https://github.com/fjpulidop/specrails-core/issues/59)) ([d5f735c](https://github.com/fjpulidop/specrails-core/commit/d5f735c4a772f6759d39e008d3ae13aade000834))
* add npm package distribution channel ([c26f11e](https://github.com/fjpulidop/specrails-core/commit/c26f11ef70117c3e7d763c9906298242c562f058))
* add provider detection and directory abstraction for Codex support (SPEA-506) ([a8a06f5](https://github.com/fjpulidop/specrails-core/commit/a8a06f502e4727ee5d7151cc49972f0076eae693))
* add refactor-recommender command for tech debt analysis ([#11](https://github.com/fjpulidop/specrails-core/issues/11)) ([48d5611](https://github.com/fjpulidop/specrails-core/commit/48d5611336fb447c39a3f444dadb9aadd766bf2e))
* add smart failure recovery and retry to implement pipeline ([a86dd6d](https://github.com/fjpulidop/specrails-core/commit/a86dd6d8108630418487ff1f70409696af890818))
* add smart feature ordering & dependency detection ([#38](https://github.com/fjpulidop/specrails-core/issues/38)) ([ada7d2c](https://github.com/fjpulidop/specrails-core/commit/ada7d2c6dc0ccd9d55e2137d7e361c2dd3ab4610))
* add smart merge conflict resolver for multi-feature pipelines ([a4c97ad](https://github.com/fjpulidop/specrails-core/commit/a4c97ad4c9a6086f634f45249e41286a02f194fa)), closes [#3](https://github.com/fjpulidop/specrails-core/issues/3)
* add specialized layer reviewers for frontend, backend, and security ([#40](https://github.com/fjpulidop/specrails-core/issues/40)) ([91ea217](https://github.com/fjpulidop/specrails-core/commit/91ea217fc2a0a9b1d71815cb3f83255ae917b908))
* add SQLite persistence and stream-json parsing to web-manager ([#57](https://github.com/fjpulidop/specrails-core/issues/57)) ([85a68b8](https://github.com/fjpulidop/specrails-core/commit/85a68b8332048d2e38e0b722a48cb76583ac4cd5))
* add sr- prefix namespace to all agents and sr: namespace to commands ([e86f0ed](https://github.com/fjpulidop/specrails-core/commit/e86f0ede6037a066a9259be50e846981dd8159e4))
* add srm CLI wrapper for terminal-to-web-manager bridge ([#58](https://github.com/fjpulidop/specrails-core/issues/58)) ([4e6dc58](https://github.com/fjpulidop/specrails-core/commit/4e6dc58652de8b05223ac93f48c9d4552e0c9113))
* add standalone /specrails:test command and test writer integration ([#166](https://github.com/fjpulidop/specrails-core/issues/166)) ([c315363](https://github.com/fjpulidop/specrails-core/commit/c315363aa39f11b5d9fc1d6b7ae3e123e7dcf301)), closes [#6](https://github.com/fjpulidop/specrails-core/issues/6)
* add status filter, job details, and clear jobs modal to RecentJobs ([f75f123](https://github.com/fjpulidop/specrails-core/commit/f75f123bd21b61f327da22c20bdd2028182dcc74))
* add versioning and update system for specrails installations ([b4a6a16](https://github.com/fjpulidop/specrails-core/commit/b4a6a16b496695ef71df2b04eec8e4a21c9938e6))
* add web manager MVP - Pipeline Monitor dashboard ([54b8e68](https://github.com/fjpulidop/specrails-core/commit/54b8e683057c076b05ae14d82aba7d0c04d884d3)), closes [#29](https://github.com/fjpulidop/specrails-core/issues/29)
* **agents:** add performance regression detector agent and CI workflow ([#133](https://github.com/fjpulidop/specrails-core/issues/133)) ([693d6ef](https://github.com/fjpulidop/specrails-core/commit/693d6efce2ab854063759db13fa234f9a6663fa5))
* **agents:** enhance sr-doc-sync with drift detection and severity ([56e9280](https://github.com/fjpulidop/specrails-core/commit/56e9280462bbf1afc64eff4fc8f1e2d063c24359))
* chat panel ([#79](https://github.com/fjpulidop/specrails-core/issues/79)) and analytics dashboard ([#80](https://github.com/fjpulidop/specrails-core/issues/80)) ([1a4bea5](https://github.com/fjpulidop/specrails-core/commit/1a4bea51c4b14d9bd9acb2b39ce1621cdf413c73))
* **commands:** add /specrails:memory-inspect agent memory inspector ([#119](https://github.com/fjpulidop/specrails-core/issues/119)) ([e81bc29](https://github.com/fjpulidop/specrails-core/commit/e81bc29b15b2698dc8aaaee1c94db9a4da755eb5))
* **commands:** add /specrails:opsx-diff change diff visualizer (backlog [#16](https://github.com/fjpulidop/specrails-core/issues/16)) ([#122](https://github.com/fjpulidop/specrails-core/issues/122)) ([5109726](https://github.com/fjpulidop/specrails-core/commit/5109726a81efc18b93fce3334f3d0f9e4bd4cd8f))
* **commands:** add /specrails:retry smart failure recovery ([#117](https://github.com/fjpulidop/specrails-core/issues/117)) ([2cf08d4](https://github.com/fjpulidop/specrails-core/commit/2cf08d4fcf8de7c27e4257ac040838af235b821d))
* **commands:** add /specrails:telemetry agent telemetry & cost tracking ([#123](https://github.com/fjpulidop/specrails-core/issues/123)) ([38eea04](https://github.com/fjpulidop/specrails-core/commit/38eea04dbb1d3ed5d5a5b13eb8819e9b96853d90))
* **commands:** add /specrails:vpc-drift VPC persona drift detection (backlog [#12](https://github.com/fjpulidop/specrails-core/issues/12)) ([#120](https://github.com/fjpulidop/specrails-core/issues/120)) ([49ac863](https://github.com/fjpulidop/specrails-core/commit/49ac863fbc88f7eab9a5fdff2942d1df85130b18))
* **commands:** add smart merge conflict resolver (backlog [#3](https://github.com/fjpulidop/specrails-core/issues/3)) ([#134](https://github.com/fjpulidop/specrails-core/issues/134)) ([562b237](https://github.com/fjpulidop/specrails-core/commit/562b23720a5d35f703effb830ddbdc22590fda6e))
* **commands:** add VPC context-aware scoring to refactor-recommender ([5c6fbfa](https://github.com/fjpulidop/specrails-core/commit/5c6fbfa1a2521dd64b191dbdb815b25bc3b1d3b7))
* **commands:** add VPC context-aware scoring to refactor-recommender ([#135](https://github.com/fjpulidop/specrails-core/issues/135)) ([ad0c195](https://github.com/fjpulidop/specrails-core/commit/ad0c1953059309906d76125f5bef615a54cc5e1c))
* **commands:** extend /specrails:health-check with static code analysis ([#109](https://github.com/fjpulidop/specrails-core/issues/109)) ([3ab3fde](https://github.com/fjpulidop/specrails-core/commit/3ab3fdee48f97e07a9005bab96116c5536257a60))
* complete UI/UX redesign of web-manager with Tailwind + shadcn/ui ([#69](https://github.com/fjpulidop/specrails-core/issues/69)) ([2993e8b](https://github.com/fjpulidop/specrails-core/commit/2993e8bedaacd4d0b1794b0c8d33f88b2aecd4b4))
* dynamic pipeline phases per command and fix log streaming ([bc1ef91](https://github.com/fjpulidop/specrails-core/commit/bc1ef912ab2470661127d65fd975e39df46842ea))
* implement security reviewer agent, dry-run mode, and OSS maintainer persona ([2a17c68](https://github.com/fjpulidop/specrails-core/commit/2a17c6811d8779a140057ab56ea5acfc56bf8805))
* integrate web manager notifications into implement pipeline ([a64e7c2](https://github.com/fjpulidop/specrails-core/commit/a64e7c2aeb1b7ef9cb39bc8a5b8511847e91fe60))
* migrate /specrails:* commands to Skills format for Codex compatibility (SPEA-507) ([c080b31](https://github.com/fjpulidop/specrails-core/commit/c080b310c1934316577406028fc5067ddb141944))
* **onboarding:** specrails-core Onboarding v1 (RFC-001) ([e08dda5](https://github.com/fjpulidop/specrails-core/commit/e08dda520a23060a8af89bd2047661cd1f9b1b95))
* **product:** formalize OSS Maintainer persona Kai (backlog [#13](https://github.com/fjpulidop/specrails-core/issues/13)) ([#124](https://github.com/fjpulidop/specrails-core/issues/124)) ([f3d58e1](https://github.com/fjpulidop/specrails-core/commit/f3d58e1071307b200178d59940543bebfcfc47fb))
* rename package to specrails-core, add CI/CD release pipeline ([def4013](https://github.com/fjpulidop/specrails-core/commit/def40135e58b2ae52d47109faff228081b4ec77f))
* **setup:** extend /setup --update to check command template checksums ([#126](https://github.com/fjpulidop/specrails-core/issues/126)) ([55c9743](https://github.com/fjpulidop/specrails-core/commit/55c97439ad9b250abcf0bd2bd945a60b33759969))
* sync dynamic pipeline + markdown log viewer to templates ([12cc945](https://github.com/fjpulidop/specrails-core/commit/12cc9455b3e42ff8f5863c2b53dbd0b4e0f41a89))
* upgrade integration-contract to v2.0 for dual-CLI support (SPEA-510) ([f92168d](https://github.com/fjpulidop/specrails-core/commit/f92168d9bbc289a2e5df94df499019e147d5b7f1))
* **web-manager:** add zombie job detection and auto-termination ([#128](https://github.com/fjpulidop/specrails-core/issues/128)) ([0f8c718](https://github.com/fjpulidop/specrails-core/commit/0f8c71876d4e191eb2c9cbbfc67c73de0eb9a462))
* wire sr-security-reviewer into /setup command ([3bdc229](https://github.com/fjpulidop/specrails-core/commit/3bdc229a8aa8306451ec0ca918943c37b5777300))
* wire sr-test-writer into /setup command ([dcb82ec](https://github.com/fjpulidop/specrails-core/commit/dcb82ec25f3d93b1e578d0963339af405d71e717))


### Bug Fixes

* add border-radius to glass-card utility ([5b7deb3](https://github.com/fjpulidop/specrails-core/commit/5b7deb398ba424d5ac67a6400cfe468559ca28c1))
* add card background and border-radius to RecentJobs ([7213288](https://github.com/fjpulidop/specrails-core/commit/72132883ca61ea118308e1d128d661df5a3c3312))
* add gap-check logic to /setup for idempotent re-runs (SPEA-472) ([3bdc7c2](https://github.com/fjpulidop/specrails-core/commit/3bdc7c25bbff2db8b508dacfb69239fd69f7613e))
* add missing -e flag to echo in installer prompt ([#35](https://github.com/fjpulidop/specrails-core/issues/35)) ([68c3e1b](https://github.com/fjpulidop/specrails-core/commit/68c3e1b70bc26e6337d612710be38f42bea2d010))
* add missing deps to web-manager template causing broken styles ([5ca88d0](https://github.com/fjpulidop/specrails-core/commit/5ca88d0d8d8a25b7864f8b9b8ecaec0cd5a09906))
* add missing Dracula color variables and utility classes to globals.css ([2e8f745](https://github.com/fjpulidop/specrails-core/commit/2e8f745840965742e98e364f4ba74a625621bb39))
* add propose-spec command to setup installation flow ([e34ac4b](https://github.com/fjpulidop/specrails-core/commit/e34ac4b0ee25c49ffdc10148878d9afe40eb1f89))
* adjust collapsed chat icon to pt-6 ([a186f59](https://github.com/fjpulidop/specrails-core/commit/a186f59c9f9d08372a77353fbd83cef55d7a92c4))
* align collapsed chat icon to top with breathing room ([517026c](https://github.com/fjpulidop/specrails-core/commit/517026c8e5bc3ad0fe4f1f97456010158a0d842d))
* align collapsed chat icon with page content header height ([a7dae7d](https://github.com/fjpulidop/specrails-core/commit/a7dae7db0d8e0f9ece1f9195aaa91859650353c5))
* auto-close GitHub issues when implement pipeline ships ([68ffd11](https://github.com/fjpulidop/specrails-core/commit/68ffd11a567b5eb2599a69381db5df0fb8583b59))
* cache dashboard data at module level to prevent flicker on navigation ([6fb4faa](https://github.com/fjpulidop/specrails-core/commit/6fb4faa8fb26367b94d2664b018285b027a4d45c))
* change default ports to 4200 (server) and 4201 (client) ([fb3a83f](https://github.com/fjpulidop/specrails-core/commit/fb3a83fc6306aa78fcfa666502a373a23d1fde55))
* **ci:** remove non-existent test-doctor.sh from test runner ([d84f6bf](https://github.com/fjpulidop/specrails-core/commit/d84f6bf85b1bb5fa132d528857f2049831ddaf60))
* **ci:** run actual test suite instead of suppressing all errors ([bc20972](https://github.com/fjpulidop/specrails-core/commit/bc20972f95c267b578ab16c42086b2e69313e766))
* clean up setup-templates after update when no /setup re-run needed ([e605027](https://github.com/fjpulidop/specrails-core/commit/e60502710602a77a432bcea8105ea1c3e2c9409d))
* **cli:** replace execSync with spawnSync to eliminate command injection ([32631d9](https://github.com/fjpulidop/specrails-core/commit/32631d98b19b17d8a4b91153a416a57d7fc673e6))
* **core:** detect OAuth sessions in auth check (Claude Pro/Max users) ([be10d18](https://github.com/fjpulidop/specrails-core/commit/be10d18ae89b9de1d62906ccd49339b846b124b1))
* detect when update.sh runs from specrails source repo ([acc6d3e](https://github.com/fjpulidop/specrails-core/commit/acc6d3efdb8d479f6121312632d14f88ac4a8841))
* **docs:** remove DeckDex-contaminated documentation files ([#129](https://github.com/fjpulidop/specrails-core/issues/129)) ([0785f05](https://github.com/fjpulidop/specrails-core/commit/0785f05ae6386f2c2e2b2ce832a8217a3458cf08))
* **docs:** remove DeckDex-contaminated documentation files ([#131](https://github.com/fjpulidop/specrails-core/issues/131)) ([69aa4e9](https://github.com/fjpulidop/specrails-core/commit/69aa4e902532c5dbbd52d22de103fa17eea10ab5))
* expose phasesForCommand as public method on QueueManager ([b573964](https://github.com/fjpulidop/specrails-core/commit/b5739649c69981f87f955fe5819f928836f7956b))
* ImplementWizard always uses /specrails:implement, never batch-implement ([3fc1626](https://github.com/fjpulidop/specrails-core/commit/3fc1626f0d13e4f4f1bdf6d123ff0192baa05774))
* ImplementWizard sends single command with all issues instead of one per issue ([9e7a701](https://github.com/fjpulidop/specrails-core/commit/9e7a701b590ff3223c514a3265412a5255886798))
* ImplementWizard uses /specrails:batch-implement when multiple issues selected ([61d6154](https://github.com/fjpulidop/specrails-core/commit/61d6154346c3ef3002ce872bb58dd978a3c458f2))
* install Codex commands as Agent Skills ([#173](https://github.com/fjpulidop/specrails-core/issues/173)) ([0ae617c](https://github.com/fjpulidop/specrails-core/commit/0ae617c7b45c1f1239898386d43db2c0b97ceeaf))
* JobDetailPage uses shared WS_URL and stable useCallback for live logs ([ef53ddd](https://github.com/fjpulidop/specrails-core/commit/ef53ddd353effd83732119c4f4c2f70be24d5ede))
* LogViewer only renders log and result events to prevent duplicates ([9dda2d4](https://github.com/fjpulidop/specrails-core/commit/9dda2d41b377709fcd70b832d82b872a29c8fa53))
* lower collapsed chat icon padding to pt-8 ([44fb60d](https://github.com/fjpulidop/specrails-core/commit/44fb60df7a8ea45511839e4521f2fc226cc61841))
* make do_core and do_web_manager selective updates ([56f185c](https://github.com/fjpulidop/specrails-core/commit/56f185cdef7759bb1fec9e5881b23081214755ae))
* make job rows clickable instead of showing a View button ([eca7239](https://github.com/fjpulidop/specrails-core/commit/eca72396bbc162d230ce3b8dcd4c2a6e099fb85b))
* move propose-feature.md to templates/commands/specrails/ ([fa78822](https://github.com/fjpulidop/specrails-core/commit/fa78822de6a9e06fe09ec67345745f01ced5454d))
* navbar tooltips render above chat panel with z-50 ([40c64ff](https://github.com/fjpulidop/specrails-core/commit/40c64ffbda754084b5d483332c1d72f2951d14f2))
* pass command as single -p argument to claude CLI ([4a36d87](https://github.com/fjpulidop/specrails-core/commit/4a36d870e5e6b59aea76dc3030697d6137e09bc4))
* persist display text from structured events as log entries in DB ([eaa8770](https://github.com/fjpulidop/specrails-core/commit/eaa87702a0204f21a716508e221944434bdf6296))
* prompt for target repo when installer runs from specrails source ([#33](https://github.com/fjpulidop/specrails-core/issues/33)) ([165390e](https://github.com/fjpulidop/specrails-core/commit/165390ed7d26ddcb80ec1b8e41415575fcf3af29))
* pull --rebase before push in Sync VERSION step (SPEA-438) ([b4408ed](https://github.com/fjpulidop/specrails-core/commit/b4408edb688344a2cf75936b1de3006def7a7b63))
* remove Active Job section from DashboardPage home ([b06192b](https://github.com/fjpulidop/specrails-core/commit/b06192bbe5ffdd5ad20e6521631edd9ebb7d98db))
* remove duplicate log entries by only using 'log' messages for live streaming ([1976680](https://github.com/fjpulidop/specrails-core/commit/19766809a0bb3b1545ce114febe229a776d93638))
* remove local keyword outside functions and add test suite ([9294a42](https://github.com/fjpulidop/specrails-core/commit/9294a42a51c61a1d12f3746db211b7fad1ebfa90))
* remove npm ci from workflows — package has no dependencies ([32b65e4](https://github.com/fjpulidop/specrails-core/commit/32b65e47bece78c6870ad806db7f787b5cdb7a90))
* remove unused destructured vars from DashboardPage after ActiveJob removal ([140ed17](https://github.com/fjpulidop/specrails-core/commit/140ed171e1dfc44fe1adea1d27d37ddd469edd44))
* replace generic Activity icon with Dracula-styled specrails wordmark ([9046d19](https://github.com/fjpulidop/specrails-core/commit/9046d196d4e645903da739d1cb0b09ce379ef720))
* replace generic dark theme with authentic Dracula colors ([acc6cd8](https://github.com/fjpulidop/specrails-core/commit/acc6cd8d7d7660d8009adabceda9f6c3170eb4c6))
* replace specrails.dev link with Docs button pointing to /docs ([f3dfc38](https://github.com/fjpulidop/specrails-core/commit/f3dfc38be19c5fe913557b996675defa999a0eaa))
* replace ugly rotated CHAT text with centered Dracula-styled icon ([da29d54](https://github.com/fjpulidop/specrails-core/commit/da29d54362f332ff05245ef5e7f6b5b8626473d4))
* resolve slash commands by reading skill markdown and substituting \$ARGUMENTS ([17ab964](https://github.com/fjpulidop/specrails-core/commit/17ab96475098823b8ef7ed980763307a91ce0b7f))
* route /jobs/:id to JobDetailPage instead of DashboardPage ([6fec149](https://github.com/fjpulidop/specrails-core/commit/6fec149aa2e06d68916797042aa74175818033f9))
* **security:** replace execSync+string-concat with spawnSync+argv array (HIGH-01) ([01e7b44](https://github.com/fjpulidop/specrails-core/commit/01e7b44391c31d01c0d7e007fb38fc4e5f3f7707))
* setup wizard missing 5 commands from selection and generation ([176c8ad](https://github.com/fjpulidop/specrails-core/commit/176c8ad769fb9a5a5f3d364c7793c84a9709382e))
* stop closing issues at PR creation, rely on Closes #N on merge ([d945060](https://github.com/fjpulidop/specrails-core/commit/d945060fa055aa3d94d0d2c472c5c3fcad07e187))
* support Codex OAuth login in installer auth check ([#171](https://github.com/fjpulidop/specrails-core/issues/171)) ([dd286d2](https://github.com/fjpulidop/specrails-core/commit/dd286d238bcf5d76f4bd761de2402363f01dace1))
* support curl-pipe installation by detecting BASH_SOURCE absence ([3471f09](https://github.com/fjpulidop/specrails-core/commit/3471f09bf9538e6037dad6c5ad70ed3290bb9eed))
* suppress raw JSON noise from user/system events in log viewer ([409c315](https://github.com/fjpulidop/specrails-core/commit/409c31545893f3df403bcd8eb0494d16adf97d71))
* sync VERSION to 2.1.0 and move version tracking to release-please ([#168](https://github.com/fjpulidop/specrails-core/issues/168)) ([b26c9f0](https://github.com/fjpulidop/specrails-core/commit/b26c9f0c8247d519918a74b443679dca4576b679))
* **tests:** bypass Claude CLI/API key prereqs in install.sh test suite ([4d6bdb6](https://github.com/fjpulidop/specrails-core/commit/4d6bdb6a82a2c2a25c0735d9d5bf98694f8eb900))
* **tests:** replace ((X++)) with POSIX-safe arithmetic to fix CI ([c43c28c](https://github.com/fjpulidop/specrails-core/commit/c43c28c6283c5e5b6d8ec3e245eb289e1814e947))
* toast uses glass-card style instead of Sonner's default black background ([0d85c4a](https://github.com/fjpulidop/specrails-core/commit/0d85c4ab3413ad979b62f474b3d70e8efedb897b))
* update README and CLAUDE.md for specrails-core rename ([a3b21b1](https://github.com/fjpulidop/specrails-core/commit/a3b21b1bafcb653414195aab315a9ccde0198561))
* update remaining unprefixed /implement and /why refs in templates ([6495d4e](https://github.com/fjpulidop/specrails-core/commit/6495d4ecb2c67a439eba2e1292c94a647d8918ad))
* update.sh prompts/skills not tracked in manifest causing false "changed" reports ([24cdeff](https://github.com/fjpulidop/specrails-core/commit/24cdeff08d4a951150b5bf0c7f4a994d2327864d))
* update.sh skipped web-manager sync due to early version check exit ([c7854ac](https://github.com/fjpulidop/specrails-core/commit/c7854ac2c76fa6ed7ff26e370f21f919e8e17727))
* use content-aware checksums instead of version-only comparison ([f0c7826](https://github.com/fjpulidop/specrails-core/commit/f0c7826765598b465cf06995661f7dd95e55c146))
* use harmonious Dracula colors for status pie chart ([d67f616](https://github.com/fjpulidop/specrails-core/commit/d67f6163da307b0924703213c31dc8d6e2d9dd2d))
* use purple/pink/orange for DailyThroughput bar chart ([e4fb50b](https://github.com/fjpulidop/specrails-core/commit/e4fb50b6be5bacd1cc1830d177646cffecbb286f))
* use SharedWebSocket in JobDetailPage to prevent duplicate logs ([c2a8ff2](https://github.com/fjpulidop/specrails-core/commit/c2a8ff23bfbaf10d124e20b7d5ecb3446279eb0d))
* web-manager build script path and PostCSS parent conflict ([bba6a38](https://github.com/fjpulidop/specrails-core/commit/bba6a38e286a2f9ef9add6410f03485a7bba3295))
* widen RecentJobs column headers to prevent text overlap ([8d1b959](https://github.com/fjpulidop/specrails-core/commit/8d1b959ee0da0092b172c7ad7807ed4c27af6742))

## [2.1.3](https://github.com/fjpulidop/specrails-core/compare/v2.1.2...v2.1.3) (2026-03-22)


### Bug Fixes

* install Codex commands as Agent Skills ([#173](https://github.com/fjpulidop/specrails-core/issues/173)) ([0ae617c](https://github.com/fjpulidop/specrails-core/commit/0ae617c7b45c1f1239898386d43db2c0b97ceeaf))

## [2.1.2](https://github.com/fjpulidop/specrails-core/compare/v2.1.1...v2.1.2) (2026-03-21)


### Bug Fixes

* support Codex OAuth login in installer auth check ([#171](https://github.com/fjpulidop/specrails-core/issues/171)) ([dd286d2](https://github.com/fjpulidop/specrails-core/commit/dd286d238bcf5d76f4bd761de2402363f01dace1))

## [2.1.1](https://github.com/fjpulidop/specrails-core/compare/v2.1.0...v2.1.1) (2026-03-21)


### Bug Fixes

* sync VERSION to 2.1.0 and move version tracking to release-please ([#168](https://github.com/fjpulidop/specrails-core/issues/168)) ([b26c9f0](https://github.com/fjpulidop/specrails-core/commit/b26c9f0c8247d519918a74b443679dca4576b679))

## [2.1.0](https://github.com/fjpulidop/specrails-core/compare/v2.0.0...v2.1.0) (2026-03-21)


### Features

* add standalone /specrails:test command and test writer integration ([#166](https://github.com/fjpulidop/specrails-core/issues/166)) ([c315363](https://github.com/fjpulidop/specrails-core/commit/c315363aa39f11b5d9fc1d6b7ae3e123e7dcf301)), closes [#6](https://github.com/fjpulidop/specrails-core/issues/6)

## [2.0.0](https://github.com/fjpulidop/specrails-core/compare/v1.8.0...v2.0.0) (2026-03-21)


### ⚠ BREAKING CHANGES

* All commands renamed from /<name> to /specrails:<name>. All agent files renamed from <name>.md to sr-<name>.md. Existing installations are auto-migrated by update.sh.

### Features

* add --provider CLI flag to install.sh arg parser (SPEA-517) ([44dac30](https://github.com/fjpulidop/specrails-core/commit/44dac30b6bd5de7a3bfa94da3625f2246c659c1a))
* add --root-dir parameter to install.sh for monorepo support ([77cd24b](https://github.com/fjpulidop/specrails-core/commit/77cd24bdc805c884532c8e25b028ee0ed210a031))
* add --yes flag to install.sh for non-interactive mode ([29173cd](https://github.com/fjpulidop/specrails-core/commit/29173cdca11c9b02f0a91eb59efd7dd64ae4ff79))
* add /specrails:propose-feature command template for Feature Proposal Modal ([756ed30](https://github.com/fjpulidop/specrails-core/commit/756ed3061091bd532f8e7c6558cfa52fa5297ae9))
* add agent confidence scoring & validation framework ([#37](https://github.com/fjpulidop/specrails-core/issues/37)) ([b95f97f](https://github.com/fjpulidop/specrails-core/commit/b95f97fda91f8fedd4b9f75dcebe327023a73e23))
* add agent personality customization (backlog [#15](https://github.com/fjpulidop/specrails-core/issues/15)) ([#115](https://github.com/fjpulidop/specrails-core/issues/115)) ([f87e2dd](https://github.com/fjpulidop/specrails-core/commit/f87e2dd8520331e2b9662ae74f49a444386a7d0e))
* add agent post-mortem & failure learning loop ([#39](https://github.com/fjpulidop/specrails-core/issues/39)) ([e6c519a](https://github.com/fjpulidop/specrails-core/commit/e6c519a3e5e349293dfb7b7365b861269ff4e7e5))
* add agent workflow system and product-driven development setup ([98ab9f5](https://github.com/fjpulidop/specrails-core/commit/98ab9f520b9559ac059234e0d5a21ceb347d918d))
* add AI-powered in-context help system ([#45](https://github.com/fjpulidop/specrails-core/issues/45)) ([bd0a337](https://github.com/fjpulidop/specrails-core/commit/bd0a3373f4cf4e16aaed56a703d2351f41be1c18))
* add automated test writer agent (Phase 3c in implement pipeline) ([959b485](https://github.com/fjpulidop/specrails-core/commit/959b48530f9954940810654c8b98447bed5f5af3))
* add backlog sync conflict detection ([#41](https://github.com/fjpulidop/specrails-core/issues/41)) ([0bb1421](https://github.com/fjpulidop/specrails-core/commit/0bb14211c16a5e53e7497589c36b30cc99afcaff))
* add backwards compatibility impact analyzer ([#44](https://github.com/fjpulidop/specrails-core/issues/44)) ([13255d8](https://github.com/fjpulidop/specrails-core/commit/13255d8af4cc6ebe9d506d936d1d0e8ab754788f))
* add batch implementation orchestrator (/batch-implement) ([eb2a81b](https://github.com/fjpulidop/specrails-core/commit/eb2a81b0d757789f0e40f8e31a451dcd3a62b5d3))
* add column headers to RecentJobs table ([42c33de](https://github.com/fjpulidop/specrails-core/commit/42c33de52440c7ae6c6362786810157628e3a80f))
* add date range filter to RecentJobs ([6151321](https://github.com/fjpulidop/specrails-core/commit/6151321d2eb90d3871dd4accccef1e775ea2bbea))
* add doc-sync agent for automated documentation updates ([#7](https://github.com/fjpulidop/specrails-core/issues/7)) ([66f18ac](https://github.com/fjpulidop/specrails-core/commit/66f18ac0bdfd7603fe4dd545459816ad934493bb))
* add dual permissions config generation for Codex support (SPEA-508) ([7d32bcf](https://github.com/fjpulidop/specrails-core/commit/7d32bcff647abec7b1a5076f28b2439658ea5f6d))
* add dual-format agent generation for Codex compatibility (SPEA-509) ([7b398fd](https://github.com/fjpulidop/specrails-core/commit/7b398fd483d12e34362a678a03a877af9da754d3))
* add health-check dashboard command for quality monitoring ([#9](https://github.com/fjpulidop/specrails-core/issues/9)) ([4b1e846](https://github.com/fjpulidop/specrails-core/commit/4b1e8468d7edf89af569d149f0039319d13d7aa8))
* add JIRA integration for project labels and epic grouping ([ec054a4](https://github.com/fjpulidop/specrails-core/commit/ec054a4e5647c7536c3d43beb4755f8a734e5882))
* add job queueing with kill support to web-manager ([#59](https://github.com/fjpulidop/specrails-core/issues/59)) ([d5f735c](https://github.com/fjpulidop/specrails-core/commit/d5f735c4a772f6759d39e008d3ae13aade000834))
* add npm package distribution channel ([c26f11e](https://github.com/fjpulidop/specrails-core/commit/c26f11ef70117c3e7d763c9906298242c562f058))
* add provider detection and directory abstraction for Codex support (SPEA-506) ([a8a06f5](https://github.com/fjpulidop/specrails-core/commit/a8a06f502e4727ee5d7151cc49972f0076eae693))
* add refactor-recommender command for tech debt analysis ([#11](https://github.com/fjpulidop/specrails-core/issues/11)) ([48d5611](https://github.com/fjpulidop/specrails-core/commit/48d5611336fb447c39a3f444dadb9aadd766bf2e))
* add smart failure recovery and retry to implement pipeline ([a86dd6d](https://github.com/fjpulidop/specrails-core/commit/a86dd6d8108630418487ff1f70409696af890818))
* add smart feature ordering & dependency detection ([#38](https://github.com/fjpulidop/specrails-core/issues/38)) ([ada7d2c](https://github.com/fjpulidop/specrails-core/commit/ada7d2c6dc0ccd9d55e2137d7e361c2dd3ab4610))
* add smart merge conflict resolver for multi-feature pipelines ([a4c97ad](https://github.com/fjpulidop/specrails-core/commit/a4c97ad4c9a6086f634f45249e41286a02f194fa)), closes [#3](https://github.com/fjpulidop/specrails-core/issues/3)
* add specialized layer reviewers for frontend, backend, and security ([#40](https://github.com/fjpulidop/specrails-core/issues/40)) ([91ea217](https://github.com/fjpulidop/specrails-core/commit/91ea217fc2a0a9b1d71815cb3f83255ae917b908))
* add SQLite persistence and stream-json parsing to web-manager ([#57](https://github.com/fjpulidop/specrails-core/issues/57)) ([85a68b8](https://github.com/fjpulidop/specrails-core/commit/85a68b8332048d2e38e0b722a48cb76583ac4cd5))
* add sr- prefix namespace to all agents and sr: namespace to commands ([e86f0ed](https://github.com/fjpulidop/specrails-core/commit/e86f0ede6037a066a9259be50e846981dd8159e4))
* add srm CLI wrapper for terminal-to-web-manager bridge ([#58](https://github.com/fjpulidop/specrails-core/issues/58)) ([4e6dc58](https://github.com/fjpulidop/specrails-core/commit/4e6dc58652de8b05223ac93f48c9d4552e0c9113))
* add status filter, job details, and clear jobs modal to RecentJobs ([f75f123](https://github.com/fjpulidop/specrails-core/commit/f75f123bd21b61f327da22c20bdd2028182dcc74))
* add versioning and update system for specrails installations ([b4a6a16](https://github.com/fjpulidop/specrails-core/commit/b4a6a16b496695ef71df2b04eec8e4a21c9938e6))
* add web manager MVP - Pipeline Monitor dashboard ([54b8e68](https://github.com/fjpulidop/specrails-core/commit/54b8e683057c076b05ae14d82aba7d0c04d884d3)), closes [#29](https://github.com/fjpulidop/specrails-core/issues/29)
* **agents:** add performance regression detector agent and CI workflow ([#133](https://github.com/fjpulidop/specrails-core/issues/133)) ([693d6ef](https://github.com/fjpulidop/specrails-core/commit/693d6efce2ab854063759db13fa234f9a6663fa5))
* **agents:** enhance sr-doc-sync with drift detection and severity ([56e9280](https://github.com/fjpulidop/specrails-core/commit/56e9280462bbf1afc64eff4fc8f1e2d063c24359))
* chat panel ([#79](https://github.com/fjpulidop/specrails-core/issues/79)) and analytics dashboard ([#80](https://github.com/fjpulidop/specrails-core/issues/80)) ([1a4bea5](https://github.com/fjpulidop/specrails-core/commit/1a4bea51c4b14d9bd9acb2b39ce1621cdf413c73))
* **commands:** add /specrails:memory-inspect agent memory inspector ([#119](https://github.com/fjpulidop/specrails-core/issues/119)) ([e81bc29](https://github.com/fjpulidop/specrails-core/commit/e81bc29b15b2698dc8aaaee1c94db9a4da755eb5))
* **commands:** add /specrails:opsx-diff change diff visualizer (backlog [#16](https://github.com/fjpulidop/specrails-core/issues/16)) ([#122](https://github.com/fjpulidop/specrails-core/issues/122)) ([5109726](https://github.com/fjpulidop/specrails-core/commit/5109726a81efc18b93fce3334f3d0f9e4bd4cd8f))
* **commands:** add /specrails:retry smart failure recovery ([#117](https://github.com/fjpulidop/specrails-core/issues/117)) ([2cf08d4](https://github.com/fjpulidop/specrails-core/commit/2cf08d4fcf8de7c27e4257ac040838af235b821d))
* **commands:** add /specrails:telemetry agent telemetry & cost tracking ([#123](https://github.com/fjpulidop/specrails-core/issues/123)) ([38eea04](https://github.com/fjpulidop/specrails-core/commit/38eea04dbb1d3ed5d5a5b13eb8819e9b96853d90))
* **commands:** add /specrails:vpc-drift VPC persona drift detection (backlog [#12](https://github.com/fjpulidop/specrails-core/issues/12)) ([#120](https://github.com/fjpulidop/specrails-core/issues/120)) ([49ac863](https://github.com/fjpulidop/specrails-core/commit/49ac863fbc88f7eab9a5fdff2942d1df85130b18))
* **commands:** add smart merge conflict resolver (backlog [#3](https://github.com/fjpulidop/specrails-core/issues/3)) ([#134](https://github.com/fjpulidop/specrails-core/issues/134)) ([562b237](https://github.com/fjpulidop/specrails-core/commit/562b23720a5d35f703effb830ddbdc22590fda6e))
* **commands:** add VPC context-aware scoring to refactor-recommender ([5c6fbfa](https://github.com/fjpulidop/specrails-core/commit/5c6fbfa1a2521dd64b191dbdb815b25bc3b1d3b7))
* **commands:** add VPC context-aware scoring to refactor-recommender ([#135](https://github.com/fjpulidop/specrails-core/issues/135)) ([ad0c195](https://github.com/fjpulidop/specrails-core/commit/ad0c1953059309906d76125f5bef615a54cc5e1c))
* **commands:** extend /specrails:health-check with static code analysis ([#109](https://github.com/fjpulidop/specrails-core/issues/109)) ([3ab3fde](https://github.com/fjpulidop/specrails-core/commit/3ab3fdee48f97e07a9005bab96116c5536257a60))
* complete UI/UX redesign of web-manager with Tailwind + shadcn/ui ([#69](https://github.com/fjpulidop/specrails-core/issues/69)) ([2993e8b](https://github.com/fjpulidop/specrails-core/commit/2993e8bedaacd4d0b1794b0c8d33f88b2aecd4b4))
* dynamic pipeline phases per command and fix log streaming ([bc1ef91](https://github.com/fjpulidop/specrails-core/commit/bc1ef912ab2470661127d65fd975e39df46842ea))
* implement security reviewer agent, dry-run mode, and OSS maintainer persona ([2a17c68](https://github.com/fjpulidop/specrails-core/commit/2a17c6811d8779a140057ab56ea5acfc56bf8805))
* integrate web manager notifications into implement pipeline ([a64e7c2](https://github.com/fjpulidop/specrails-core/commit/a64e7c2aeb1b7ef9cb39bc8a5b8511847e91fe60))
* migrate /specrails:* commands to Skills format for Codex compatibility (SPEA-507) ([c080b31](https://github.com/fjpulidop/specrails-core/commit/c080b310c1934316577406028fc5067ddb141944))
* **onboarding:** specrails-core Onboarding v1 (RFC-001) ([e08dda5](https://github.com/fjpulidop/specrails-core/commit/e08dda520a23060a8af89bd2047661cd1f9b1b95))
* **product:** formalize OSS Maintainer persona Kai (backlog [#13](https://github.com/fjpulidop/specrails-core/issues/13)) ([#124](https://github.com/fjpulidop/specrails-core/issues/124)) ([f3d58e1](https://github.com/fjpulidop/specrails-core/commit/f3d58e1071307b200178d59940543bebfcfc47fb))
* rename package to specrails-core, add CI/CD release pipeline ([def4013](https://github.com/fjpulidop/specrails-core/commit/def40135e58b2ae52d47109faff228081b4ec77f))
* **setup:** extend /setup --update to check command template checksums ([#126](https://github.com/fjpulidop/specrails-core/issues/126)) ([55c9743](https://github.com/fjpulidop/specrails-core/commit/55c97439ad9b250abcf0bd2bd945a60b33759969))
* sync dynamic pipeline + markdown log viewer to templates ([12cc945](https://github.com/fjpulidop/specrails-core/commit/12cc9455b3e42ff8f5863c2b53dbd0b4e0f41a89))
* upgrade integration-contract to v2.0 for dual-CLI support (SPEA-510) ([f92168d](https://github.com/fjpulidop/specrails-core/commit/f92168d9bbc289a2e5df94df499019e147d5b7f1))
* **web-manager:** add zombie job detection and auto-termination ([#128](https://github.com/fjpulidop/specrails-core/issues/128)) ([0f8c718](https://github.com/fjpulidop/specrails-core/commit/0f8c71876d4e191eb2c9cbbfc67c73de0eb9a462))
* wire sr-security-reviewer into /setup command ([3bdc229](https://github.com/fjpulidop/specrails-core/commit/3bdc229a8aa8306451ec0ca918943c37b5777300))
* wire sr-test-writer into /setup command ([dcb82ec](https://github.com/fjpulidop/specrails-core/commit/dcb82ec25f3d93b1e578d0963339af405d71e717))


### Bug Fixes

* add border-radius to glass-card utility ([5b7deb3](https://github.com/fjpulidop/specrails-core/commit/5b7deb398ba424d5ac67a6400cfe468559ca28c1))
* add card background and border-radius to RecentJobs ([7213288](https://github.com/fjpulidop/specrails-core/commit/72132883ca61ea118308e1d128d661df5a3c3312))
* add gap-check logic to /setup for idempotent re-runs (SPEA-472) ([3bdc7c2](https://github.com/fjpulidop/specrails-core/commit/3bdc7c25bbff2db8b508dacfb69239fd69f7613e))
* add missing -e flag to echo in installer prompt ([#35](https://github.com/fjpulidop/specrails-core/issues/35)) ([68c3e1b](https://github.com/fjpulidop/specrails-core/commit/68c3e1b70bc26e6337d612710be38f42bea2d010))
* add missing deps to web-manager template causing broken styles ([5ca88d0](https://github.com/fjpulidop/specrails-core/commit/5ca88d0d8d8a25b7864f8b9b8ecaec0cd5a09906))
* add missing Dracula color variables and utility classes to globals.css ([2e8f745](https://github.com/fjpulidop/specrails-core/commit/2e8f745840965742e98e364f4ba74a625621bb39))
* add propose-spec command to setup installation flow ([e34ac4b](https://github.com/fjpulidop/specrails-core/commit/e34ac4b0ee25c49ffdc10148878d9afe40eb1f89))
* adjust collapsed chat icon to pt-6 ([a186f59](https://github.com/fjpulidop/specrails-core/commit/a186f59c9f9d08372a77353fbd83cef55d7a92c4))
* align collapsed chat icon to top with breathing room ([517026c](https://github.com/fjpulidop/specrails-core/commit/517026c8e5bc3ad0fe4f1f97456010158a0d842d))
* align collapsed chat icon with page content header height ([a7dae7d](https://github.com/fjpulidop/specrails-core/commit/a7dae7db0d8e0f9ece1f9195aaa91859650353c5))
* auto-close GitHub issues when implement pipeline ships ([68ffd11](https://github.com/fjpulidop/specrails-core/commit/68ffd11a567b5eb2599a69381db5df0fb8583b59))
* cache dashboard data at module level to prevent flicker on navigation ([6fb4faa](https://github.com/fjpulidop/specrails-core/commit/6fb4faa8fb26367b94d2664b018285b027a4d45c))
* change default ports to 4200 (server) and 4201 (client) ([fb3a83f](https://github.com/fjpulidop/specrails-core/commit/fb3a83fc6306aa78fcfa666502a373a23d1fde55))
* **ci:** remove non-existent test-doctor.sh from test runner ([d84f6bf](https://github.com/fjpulidop/specrails-core/commit/d84f6bf85b1bb5fa132d528857f2049831ddaf60))
* **ci:** run actual test suite instead of suppressing all errors ([bc20972](https://github.com/fjpulidop/specrails-core/commit/bc20972f95c267b578ab16c42086b2e69313e766))
* clean up setup-templates after update when no /setup re-run needed ([e605027](https://github.com/fjpulidop/specrails-core/commit/e60502710602a77a432bcea8105ea1c3e2c9409d))
* **cli:** replace execSync with spawnSync to eliminate command injection ([32631d9](https://github.com/fjpulidop/specrails-core/commit/32631d98b19b17d8a4b91153a416a57d7fc673e6))
* **core:** detect OAuth sessions in auth check (Claude Pro/Max users) ([be10d18](https://github.com/fjpulidop/specrails-core/commit/be10d18ae89b9de1d62906ccd49339b846b124b1))
* detect when update.sh runs from specrails source repo ([acc6d3e](https://github.com/fjpulidop/specrails-core/commit/acc6d3efdb8d479f6121312632d14f88ac4a8841))
* **docs:** remove DeckDex-contaminated documentation files ([#129](https://github.com/fjpulidop/specrails-core/issues/129)) ([0785f05](https://github.com/fjpulidop/specrails-core/commit/0785f05ae6386f2c2e2b2ce832a8217a3458cf08))
* **docs:** remove DeckDex-contaminated documentation files ([#131](https://github.com/fjpulidop/specrails-core/issues/131)) ([69aa4e9](https://github.com/fjpulidop/specrails-core/commit/69aa4e902532c5dbbd52d22de103fa17eea10ab5))
* expose phasesForCommand as public method on QueueManager ([b573964](https://github.com/fjpulidop/specrails-core/commit/b5739649c69981f87f955fe5819f928836f7956b))
* ImplementWizard always uses /specrails:implement, never batch-implement ([3fc1626](https://github.com/fjpulidop/specrails-core/commit/3fc1626f0d13e4f4f1bdf6d123ff0192baa05774))
* ImplementWizard sends single command with all issues instead of one per issue ([9e7a701](https://github.com/fjpulidop/specrails-core/commit/9e7a701b590ff3223c514a3265412a5255886798))
* ImplementWizard uses /specrails:batch-implement when multiple issues selected ([61d6154](https://github.com/fjpulidop/specrails-core/commit/61d6154346c3ef3002ce872bb58dd978a3c458f2))
* JobDetailPage uses shared WS_URL and stable useCallback for live logs ([ef53ddd](https://github.com/fjpulidop/specrails-core/commit/ef53ddd353effd83732119c4f4c2f70be24d5ede))
* LogViewer only renders log and result events to prevent duplicates ([9dda2d4](https://github.com/fjpulidop/specrails-core/commit/9dda2d41b377709fcd70b832d82b872a29c8fa53))
* lower collapsed chat icon padding to pt-8 ([44fb60d](https://github.com/fjpulidop/specrails-core/commit/44fb60df7a8ea45511839e4521f2fc226cc61841))
* make do_core and do_web_manager selective updates ([56f185c](https://github.com/fjpulidop/specrails-core/commit/56f185cdef7759bb1fec9e5881b23081214755ae))
* make job rows clickable instead of showing a View button ([eca7239](https://github.com/fjpulidop/specrails-core/commit/eca72396bbc162d230ce3b8dcd4c2a6e099fb85b))
* move propose-feature.md to templates/commands/specrails/ ([fa78822](https://github.com/fjpulidop/specrails-core/commit/fa78822de6a9e06fe09ec67345745f01ced5454d))
* navbar tooltips render above chat panel with z-50 ([40c64ff](https://github.com/fjpulidop/specrails-core/commit/40c64ffbda754084b5d483332c1d72f2951d14f2))
* pass command as single -p argument to claude CLI ([4a36d87](https://github.com/fjpulidop/specrails-core/commit/4a36d870e5e6b59aea76dc3030697d6137e09bc4))
* persist display text from structured events as log entries in DB ([eaa8770](https://github.com/fjpulidop/specrails-core/commit/eaa87702a0204f21a716508e221944434bdf6296))
* prompt for target repo when installer runs from specrails source ([#33](https://github.com/fjpulidop/specrails-core/issues/33)) ([165390e](https://github.com/fjpulidop/specrails-core/commit/165390ed7d26ddcb80ec1b8e41415575fcf3af29))
* pull --rebase before push in Sync VERSION step (SPEA-438) ([b4408ed](https://github.com/fjpulidop/specrails-core/commit/b4408edb688344a2cf75936b1de3006def7a7b63))
* remove Active Job section from DashboardPage home ([b06192b](https://github.com/fjpulidop/specrails-core/commit/b06192bbe5ffdd5ad20e6521631edd9ebb7d98db))
* remove duplicate log entries by only using 'log' messages for live streaming ([1976680](https://github.com/fjpulidop/specrails-core/commit/19766809a0bb3b1545ce114febe229a776d93638))
* remove local keyword outside functions and add test suite ([9294a42](https://github.com/fjpulidop/specrails-core/commit/9294a42a51c61a1d12f3746db211b7fad1ebfa90))
* remove npm ci from workflows — package has no dependencies ([32b65e4](https://github.com/fjpulidop/specrails-core/commit/32b65e47bece78c6870ad806db7f787b5cdb7a90))
* remove unused destructured vars from DashboardPage after ActiveJob removal ([140ed17](https://github.com/fjpulidop/specrails-core/commit/140ed171e1dfc44fe1adea1d27d37ddd469edd44))
* replace generic Activity icon with Dracula-styled specrails wordmark ([9046d19](https://github.com/fjpulidop/specrails-core/commit/9046d196d4e645903da739d1cb0b09ce379ef720))
* replace generic dark theme with authentic Dracula colors ([acc6cd8](https://github.com/fjpulidop/specrails-core/commit/acc6cd8d7d7660d8009adabceda9f6c3170eb4c6))
* replace specrails.dev link with Docs button pointing to /docs ([f3dfc38](https://github.com/fjpulidop/specrails-core/commit/f3dfc38be19c5fe913557b996675defa999a0eaa))
* replace ugly rotated CHAT text with centered Dracula-styled icon ([da29d54](https://github.com/fjpulidop/specrails-core/commit/da29d54362f332ff05245ef5e7f6b5b8626473d4))
* resolve slash commands by reading skill markdown and substituting \$ARGUMENTS ([17ab964](https://github.com/fjpulidop/specrails-core/commit/17ab96475098823b8ef7ed980763307a91ce0b7f))
* route /jobs/:id to JobDetailPage instead of DashboardPage ([6fec149](https://github.com/fjpulidop/specrails-core/commit/6fec149aa2e06d68916797042aa74175818033f9))
* **security:** replace execSync+string-concat with spawnSync+argv array (HIGH-01) ([01e7b44](https://github.com/fjpulidop/specrails-core/commit/01e7b44391c31d01c0d7e007fb38fc4e5f3f7707))
* setup wizard missing 5 commands from selection and generation ([176c8ad](https://github.com/fjpulidop/specrails-core/commit/176c8ad769fb9a5a5f3d364c7793c84a9709382e))
* stop closing issues at PR creation, rely on Closes #N on merge ([d945060](https://github.com/fjpulidop/specrails-core/commit/d945060fa055aa3d94d0d2c472c5c3fcad07e187))
* support curl-pipe installation by detecting BASH_SOURCE absence ([3471f09](https://github.com/fjpulidop/specrails-core/commit/3471f09bf9538e6037dad6c5ad70ed3290bb9eed))
* suppress raw JSON noise from user/system events in log viewer ([409c315](https://github.com/fjpulidop/specrails-core/commit/409c31545893f3df403bcd8eb0494d16adf97d71))
* **tests:** bypass Claude CLI/API key prereqs in install.sh test suite ([4d6bdb6](https://github.com/fjpulidop/specrails-core/commit/4d6bdb6a82a2c2a25c0735d9d5bf98694f8eb900))
* **tests:** replace ((X++)) with POSIX-safe arithmetic to fix CI ([c43c28c](https://github.com/fjpulidop/specrails-core/commit/c43c28c6283c5e5b6d8ec3e245eb289e1814e947))
* toast uses glass-card style instead of Sonner's default black background ([0d85c4a](https://github.com/fjpulidop/specrails-core/commit/0d85c4ab3413ad979b62f474b3d70e8efedb897b))
* update README and CLAUDE.md for specrails-core rename ([a3b21b1](https://github.com/fjpulidop/specrails-core/commit/a3b21b1bafcb653414195aab315a9ccde0198561))
* update remaining unprefixed /implement and /why refs in templates ([6495d4e](https://github.com/fjpulidop/specrails-core/commit/6495d4ecb2c67a439eba2e1292c94a647d8918ad))
* update.sh prompts/skills not tracked in manifest causing false "changed" reports ([24cdeff](https://github.com/fjpulidop/specrails-core/commit/24cdeff08d4a951150b5bf0c7f4a994d2327864d))
* update.sh skipped web-manager sync due to early version check exit ([c7854ac](https://github.com/fjpulidop/specrails-core/commit/c7854ac2c76fa6ed7ff26e370f21f919e8e17727))
* use content-aware checksums instead of version-only comparison ([f0c7826](https://github.com/fjpulidop/specrails-core/commit/f0c7826765598b465cf06995661f7dd95e55c146))
* use harmonious Dracula colors for status pie chart ([d67f616](https://github.com/fjpulidop/specrails-core/commit/d67f6163da307b0924703213c31dc8d6e2d9dd2d))
* use purple/pink/orange for DailyThroughput bar chart ([e4fb50b](https://github.com/fjpulidop/specrails-core/commit/e4fb50b6be5bacd1cc1830d177646cffecbb286f))
* use SharedWebSocket in JobDetailPage to prevent duplicate logs ([c2a8ff2](https://github.com/fjpulidop/specrails-core/commit/c2a8ff23bfbaf10d124e20b7d5ecb3446279eb0d))
* web-manager build script path and PostCSS parent conflict ([bba6a38](https://github.com/fjpulidop/specrails-core/commit/bba6a38e286a2f9ef9add6410f03485a7bba3295))
* widen RecentJobs column headers to prevent text overlap ([8d1b959](https://github.com/fjpulidop/specrails-core/commit/8d1b959ee0da0092b172c7ad7807ed4c27af6742))

## [1.8.0](https://github.com/fjpulidop/specrails-core/compare/v1.7.3...v1.8.0) (2026-03-21)


### Features

* add --provider CLI flag to install.sh arg parser (SPEA-517) ([44dac30](https://github.com/fjpulidop/specrails-core/commit/44dac30b6bd5de7a3bfa94da3625f2246c659c1a))
* add dual permissions config generation for Codex support (SPEA-508) ([7d32bcf](https://github.com/fjpulidop/specrails-core/commit/7d32bcff647abec7b1a5076f28b2439658ea5f6d))
* add dual-format agent generation for Codex compatibility (SPEA-509) ([7b398fd](https://github.com/fjpulidop/specrails-core/commit/7b398fd483d12e34362a678a03a877af9da754d3))
* add provider detection and directory abstraction for Codex support (SPEA-506) ([a8a06f5](https://github.com/fjpulidop/specrails-core/commit/a8a06f502e4727ee5d7151cc49972f0076eae693))
* migrate /specrails:* commands to Skills format for Codex compatibility (SPEA-507) ([c080b31](https://github.com/fjpulidop/specrails-core/commit/c080b310c1934316577406028fc5067ddb141944))
* upgrade integration-contract to v2.0 for dual-CLI support (SPEA-510) ([f92168d](https://github.com/fjpulidop/specrails-core/commit/f92168d9bbc289a2e5df94df499019e147d5b7f1))


### Bug Fixes

* add gap-check logic to /setup for idempotent re-runs (SPEA-472) ([3bdc7c2](https://github.com/fjpulidop/specrails-core/commit/3bdc7c25bbff2db8b508dacfb69239fd69f7613e))
* pull --rebase before push in Sync VERSION step (SPEA-438) ([b4408ed](https://github.com/fjpulidop/specrails-core/commit/b4408edb688344a2cf75936b1de3006def7a7b63))

## [1.7.3](https://github.com/fjpulidop/specrails-core/compare/v1.7.2...v1.7.3) (2026-03-20)


### Bug Fixes

* **core:** detect OAuth sessions in auth check (Claude Pro/Max users) ([be10d18](https://github.com/fjpulidop/specrails-core/commit/be10d18ae89b9de1d62906ccd49339b846b124b1))

## [1.7.2](https://github.com/fjpulidop/specrails-core/compare/v1.7.1...v1.7.2) (2026-03-20)


### Bug Fixes

* **ci:** remove non-existent test-doctor.sh from test runner ([d84f6bf](https://github.com/fjpulidop/specrails-core/commit/d84f6bf85b1bb5fa132d528857f2049831ddaf60))
* **ci:** run actual test suite instead of suppressing all errors ([bc20972](https://github.com/fjpulidop/specrails-core/commit/bc20972f95c267b578ab16c42086b2e69313e766))
* **cli:** replace execSync with spawnSync to eliminate command injection ([32631d9](https://github.com/fjpulidop/specrails-core/commit/32631d98b19b17d8a4b91153a416a57d7fc673e6))
* **security:** replace execSync+string-concat with spawnSync+argv array (HIGH-01) ([01e7b44](https://github.com/fjpulidop/specrails-core/commit/01e7b44391c31d01c0d7e007fb38fc4e5f3f7707))
* **tests:** replace ((X++)) with POSIX-safe arithmetic to fix CI ([c43c28c](https://github.com/fjpulidop/specrails-core/commit/c43c28c6283c5e5b6d8ec3e245eb289e1814e947))

## [1.7.1](https://github.com/fjpulidop/specrails-core/compare/v1.7.0...v1.7.1) (2026-03-20)


### Bug Fixes

* **tests:** bypass Claude CLI/API key prereqs in install.sh test suite ([1641212](https://github.com/fjpulidop/specrails-core/commit/16412129ef9faa3115d6136e29506ea2c5ee7973))
* **tests:** bypass Claude CLI/API key prereqs in install.sh test suite ([4d6bdb6](https://github.com/fjpulidop/specrails-core/commit/4d6bdb6a82a2c2a25c0735d9d5bf98694f8eb900))

## [1.7.0](https://github.com/fjpulidop/specrails-core/compare/v1.6.1...v1.7.0) (2026-03-20)


### Features

* **agents:** add performance regression detector agent and CI workflow ([#133](https://github.com/fjpulidop/specrails-core/issues/133)) ([693d6ef](https://github.com/fjpulidop/specrails-core/commit/693d6efce2ab854063759db13fa234f9a6663fa5))
* **commands:** add smart merge conflict resolver (backlog [#3](https://github.com/fjpulidop/specrails-core/issues/3)) ([#134](https://github.com/fjpulidop/specrails-core/issues/134)) ([562b237](https://github.com/fjpulidop/specrails-core/commit/562b23720a5d35f703effb830ddbdc22590fda6e))
* **commands:** add VPC context-aware scoring to refactor-recommender ([#135](https://github.com/fjpulidop/specrails-core/issues/135)) ([ad0c195](https://github.com/fjpulidop/specrails-core/commit/ad0c1953059309906d76125f5bef615a54cc5e1c))
* **web-manager:** add zombie job detection and auto-termination ([#128](https://github.com/fjpulidop/specrails-core/issues/128)) ([0f8c718](https://github.com/fjpulidop/specrails-core/commit/0f8c71876d4e191eb2c9cbbfc67c73de0eb9a462))

## [1.6.1](https://github.com/fjpulidop/specrails-core/compare/v1.6.0...v1.6.1) (2026-03-20)


### Bug Fixes

* **docs:** remove DeckDex-contaminated documentation files ([#129](https://github.com/fjpulidop/specrails-core/issues/129)) ([0785f05](https://github.com/fjpulidop/specrails-core/commit/0785f05ae6386f2c2e2b2ce832a8217a3458cf08))
* **docs:** remove DeckDex-contaminated documentation files ([#131](https://github.com/fjpulidop/specrails-core/issues/131)) ([69aa4e9](https://github.com/fjpulidop/specrails-core/commit/69aa4e902532c5dbbd52d22de103fa17eea10ab5))

## [1.6.0](https://github.com/fjpulidop/specrails-core/compare/v1.5.0...v1.6.0) (2026-03-20)


### Features

* **setup:** extend /setup --update to check command template checksums ([#126](https://github.com/fjpulidop/specrails-core/issues/126)) ([55c9743](https://github.com/fjpulidop/specrails-core/commit/55c97439ad9b250abcf0bd2bd945a60b33759969))

## [1.5.0](https://github.com/fjpulidop/specrails-core/compare/v1.4.0...v1.5.0) (2026-03-20)


### Features

* **commands:** add /specrails:opsx-diff change diff visualizer (backlog [#16](https://github.com/fjpulidop/specrails-core/issues/16)) ([#122](https://github.com/fjpulidop/specrails-core/issues/122)) ([5109726](https://github.com/fjpulidop/specrails-core/commit/5109726a81efc18b93fce3334f3d0f9e4bd4cd8f))
* **commands:** add /specrails:telemetry agent telemetry & cost tracking ([#123](https://github.com/fjpulidop/specrails-core/issues/123)) ([38eea04](https://github.com/fjpulidop/specrails-core/commit/38eea04dbb1d3ed5d5a5b13eb8819e9b96853d90))
* **product:** formalize OSS Maintainer persona Kai (backlog [#13](https://github.com/fjpulidop/specrails-core/issues/13)) ([#124](https://github.com/fjpulidop/specrails-core/issues/124)) ([f3d58e1](https://github.com/fjpulidop/specrails-core/commit/f3d58e1071307b200178d59940543bebfcfc47fb))

## [1.4.0](https://github.com/fjpulidop/specrails-core/compare/v1.3.0...v1.4.0) (2026-03-20)


### Features

* **commands:** add /specrails:memory-inspect agent memory inspector ([#119](https://github.com/fjpulidop/specrails-core/issues/119)) ([e81bc29](https://github.com/fjpulidop/specrails-core/commit/e81bc29b15b2698dc8aaaee1c94db9a4da755eb5))
* **commands:** add /specrails:vpc-drift VPC persona drift detection (backlog [#12](https://github.com/fjpulidop/specrails-core/issues/12)) ([#120](https://github.com/fjpulidop/specrails-core/issues/120)) ([49ac863](https://github.com/fjpulidop/specrails-core/commit/49ac863fbc88f7eab9a5fdff2942d1df85130b18))

## [1.3.0](https://github.com/fjpulidop/specrails-core/compare/v1.2.0...v1.3.0) (2026-03-20)


### Features

* add agent personality customization (backlog [#15](https://github.com/fjpulidop/specrails-core/issues/15)) ([#115](https://github.com/fjpulidop/specrails-core/issues/115)) ([f87e2dd](https://github.com/fjpulidop/specrails-core/commit/f87e2dd8520331e2b9662ae74f49a444386a7d0e))
* **commands:** add /specrails:retry smart failure recovery ([#117](https://github.com/fjpulidop/specrails-core/issues/117)) ([2cf08d4](https://github.com/fjpulidop/specrails-core/commit/2cf08d4fcf8de7c27e4257ac040838af235b821d))

## [1.2.0](https://github.com/fjpulidop/specrails-core/compare/v1.1.0...v1.2.0) (2026-03-20)


### Features

* **commands:** extend /specrails:health-check with static code analysis ([#109](https://github.com/fjpulidop/specrails-core/issues/109)) ([3ab3fde](https://github.com/fjpulidop/specrails-core/commit/3ab3fdee48f97e07a9005bab96116c5536257a60))

## [1.1.0](https://github.com/fjpulidop/specrails-core/compare/v1.0.1...v1.1.0) (2026-03-20)


### Features

* **agents:** enhance sr-doc-sync with drift detection and severity ([56e9280](https://github.com/fjpulidop/specrails-core/commit/56e9280462bbf1afc64eff4fc8f1e2d063c24359))
* **onboarding:** specrails-core Onboarding v1 (RFC-001) ([e08dda5](https://github.com/fjpulidop/specrails-core/commit/e08dda520a23060a8af89bd2047661cd1f9b1b95))
* wire sr-security-reviewer into /setup command ([3bdc229](https://github.com/fjpulidop/specrails-core/commit/3bdc229a8aa8306451ec0ca918943c37b5777300))
* wire sr-test-writer into /setup command ([dcb82ec](https://github.com/fjpulidop/specrails-core/commit/dcb82ec25f3d93b1e578d0963339af405d71e717))

## [1.0.1](https://github.com/fjpulidop/specrails-core/compare/v1.0.0...v1.0.1) (2026-03-19)


### Bug Fixes

* update README and CLAUDE.md for specrails-core rename ([a3b21b1](https://github.com/fjpulidop/specrails-core/commit/a3b21b1bafcb653414195aab315a9ccde0198561))

## 1.0.0 (2026-03-19)


### ⚠ BREAKING CHANGES

* All commands renamed from /<name> to /specrails:<name>. All agent files renamed from <name>.md to sr-<name>.md. Existing installations are auto-migrated by update.sh.

### Features

* /specrails:propose-feature command template ([85ce947](https://github.com/fjpulidop/specrails-core/commit/85ce947f0c35c977549cd222d6da2367b1d7e4f7))
* add --root-dir param to install.sh for monorepos ([#27](https://github.com/fjpulidop/specrails-core/issues/27)) ([e74ef84](https://github.com/fjpulidop/specrails-core/commit/e74ef846baaeaf2230e9a152f1b9e133255714cf))
* add --root-dir parameter to install.sh for monorepo support ([77cd24b](https://github.com/fjpulidop/specrails-core/commit/77cd24bdc805c884532c8e25b028ee0ed210a031))
* add --yes flag to install.sh for non-interactive mode ([29173cd](https://github.com/fjpulidop/specrails-core/commit/29173cdca11c9b02f0a91eb59efd7dd64ae4ff79))
* add /specrails:propose-feature command template for Feature Proposal Modal ([756ed30](https://github.com/fjpulidop/specrails-core/commit/756ed3061091bd532f8e7c6558cfa52fa5297ae9))
* add agent confidence scoring & validation framework ([c8db883](https://github.com/fjpulidop/specrails-core/commit/c8db883b4fe4b1c2fbbfaa499462cc288084ce72))
* add agent confidence scoring & validation framework ([#37](https://github.com/fjpulidop/specrails-core/issues/37)) ([b95f97f](https://github.com/fjpulidop/specrails-core/commit/b95f97fda91f8fedd4b9f75dcebe327023a73e23))
* add agent post-mortem & failure learning loop ([047e20c](https://github.com/fjpulidop/specrails-core/commit/047e20cbaa2fff0af5e6f1f9c2a19f2ac87408c7))
* add agent post-mortem & failure learning loop ([#39](https://github.com/fjpulidop/specrails-core/issues/39)) ([e6c519a](https://github.com/fjpulidop/specrails-core/commit/e6c519a3e5e349293dfb7b7365b861269ff4e7e5))
* add agent workflow system and product-driven development setup ([98ab9f5](https://github.com/fjpulidop/specrails-core/commit/98ab9f520b9559ac059234e0d5a21ceb347d918d))
* add agent workflow system for product-driven development ([2fe2071](https://github.com/fjpulidop/specrails-core/commit/2fe20717af77877d44cf7284ed6afd121fd13667))
* add AI-powered in-context help system ([17a0a8c](https://github.com/fjpulidop/specrails-core/commit/17a0a8c7558f391a390ed09bfc7885fc80571512))
* add AI-powered in-context help system ([#45](https://github.com/fjpulidop/specrails-core/issues/45)) ([bd0a337](https://github.com/fjpulidop/specrails-core/commit/bd0a3373f4cf4e16aaed56a703d2351f41be1c18))
* add automated test writer agent (Phase 3c in implement pipeline) ([959b485](https://github.com/fjpulidop/specrails-core/commit/959b48530f9954940810654c8b98447bed5f5af3))
* add backlog sync conflict detection ([241849b](https://github.com/fjpulidop/specrails-core/commit/241849b9834e90ea0b7d1281fac85985a7f2e75d))
* add backlog sync conflict detection ([#41](https://github.com/fjpulidop/specrails-core/issues/41)) ([0bb1421](https://github.com/fjpulidop/specrails-core/commit/0bb14211c16a5e53e7497589c36b30cc99afcaff))
* add backwards compatibility impact analyzer ([4108c1c](https://github.com/fjpulidop/specrails-core/commit/4108c1cbb64bbff43a02e35c3290b2ea12be3584))
* add backwards compatibility impact analyzer ([#44](https://github.com/fjpulidop/specrails-core/issues/44)) ([13255d8](https://github.com/fjpulidop/specrails-core/commit/13255d8af4cc6ebe9d506d936d1d0e8ab754788f))
* add batch implementation orchestrator (/batch-implement) ([eb2a81b](https://github.com/fjpulidop/specrails-core/commit/eb2a81b0d757789f0e40f8e31a451dcd3a62b5d3))
* add column headers to RecentJobs table ([42c33de](https://github.com/fjpulidop/specrails-core/commit/42c33de52440c7ae6c6362786810157628e3a80f))
* add date range filter to RecentJobs ([6151321](https://github.com/fjpulidop/specrails-core/commit/6151321d2eb90d3871dd4accccef1e775ea2bbea))
* add doc-sync agent for automated documentation updates ([#7](https://github.com/fjpulidop/specrails-core/issues/7)) ([66f18ac](https://github.com/fjpulidop/specrails-core/commit/66f18ac0bdfd7603fe4dd545459816ad934493bb))
* add doc-sync agent, refactor-recommender, and health-check commands ([daa9e81](https://github.com/fjpulidop/specrails-core/commit/daa9e81b5051de4fa3e0dd0df22e5799657a70b4))
* add health-check dashboard command for quality monitoring ([#9](https://github.com/fjpulidop/specrails-core/issues/9)) ([4b1e846](https://github.com/fjpulidop/specrails-core/commit/4b1e8468d7edf89af569d149f0039319d13d7aa8))
* add JIRA integration for project labels and epic grouping ([ec054a4](https://github.com/fjpulidop/specrails-core/commit/ec054a4e5647c7536c3d43beb4755f8a734e5882))
* add job queueing with kill support to web-manager ([#59](https://github.com/fjpulidop/specrails-core/issues/59)) ([d5f735c](https://github.com/fjpulidop/specrails-core/commit/d5f735c4a772f6759d39e008d3ae13aade000834))
* add npm package distribution channel ([c26f11e](https://github.com/fjpulidop/specrails-core/commit/c26f11ef70117c3e7d763c9906298242c562f058))
* add refactor-recommender command for tech debt analysis ([#11](https://github.com/fjpulidop/specrails-core/issues/11)) ([48d5611](https://github.com/fjpulidop/specrails-core/commit/48d5611336fb447c39a3f444dadb9aadd766bf2e))
* add smart failure recovery and retry to implement pipeline ([a86dd6d](https://github.com/fjpulidop/specrails-core/commit/a86dd6d8108630418487ff1f70409696af890818))
* add smart feature ordering & dependency detection ([fad212f](https://github.com/fjpulidop/specrails-core/commit/fad212f4ac418aab0b3fe16c9c25caeff8e2f92d))
* add smart feature ordering & dependency detection ([#38](https://github.com/fjpulidop/specrails-core/issues/38)) ([ada7d2c](https://github.com/fjpulidop/specrails-core/commit/ada7d2c6dc0ccd9d55e2137d7e361c2dd3ab4610))
* add smart merge conflict resolver for multi-feature pipelines ([a4c97ad](https://github.com/fjpulidop/specrails-core/commit/a4c97ad4c9a6086f634f45249e41286a02f194fa)), closes [#3](https://github.com/fjpulidop/specrails-core/issues/3)
* add specialized layer reviewers ([f0263e6](https://github.com/fjpulidop/specrails-core/commit/f0263e657cf6370422819a9b449200bbba2ff35f))
* add specialized layer reviewers for frontend, backend, and security ([#40](https://github.com/fjpulidop/specrails-core/issues/40)) ([91ea217](https://github.com/fjpulidop/specrails-core/commit/91ea217fc2a0a9b1d71815cb3f83255ae917b908))
* add SQLite persistence and stream-json parsing to web-manager ([#57](https://github.com/fjpulidop/specrails-core/issues/57)) ([85a68b8](https://github.com/fjpulidop/specrails-core/commit/85a68b8332048d2e38e0b722a48cb76583ac4cd5))
* add sr- prefix namespace for Volt agent compatibility ([49e39c4](https://github.com/fjpulidop/specrails-core/commit/49e39c423d490099baaf17bc6210bf622fad2f87))
* add sr- prefix namespace to all agents and sr: namespace to commands ([e86f0ed](https://github.com/fjpulidop/specrails-core/commit/e86f0ede6037a066a9259be50e846981dd8159e4))
* add srm CLI wrapper for terminal-to-web-manager bridge ([#58](https://github.com/fjpulidop/specrails-core/issues/58)) ([4e6dc58](https://github.com/fjpulidop/specrails-core/commit/4e6dc58652de8b05223ac93f48c9d4552e0c9113))
* add status filter, job details, and clear jobs modal to RecentJobs ([f75f123](https://github.com/fjpulidop/specrails-core/commit/f75f123bd21b61f327da22c20bdd2028182dcc74))
* add versioning and update system for specrails installations ([b4a6a16](https://github.com/fjpulidop/specrails-core/commit/b4a6a16b496695ef71df2b04eec8e4a21c9938e6))
* add web manager MVP - Pipeline Monitor dashboard ([54b8e68](https://github.com/fjpulidop/specrails-core/commit/54b8e683057c076b05ae14d82aba7d0c04d884d3)), closes [#29](https://github.com/fjpulidop/specrails-core/issues/29)
* automated test writer agent ([25afcc5](https://github.com/fjpulidop/specrails-core/commit/25afcc5c9cc403156ff40f97a6c7082eb8b4defd))
* batch orchestrator and smart failure recovery ([#8](https://github.com/fjpulidop/specrails-core/issues/8), [#17](https://github.com/fjpulidop/specrails-core/issues/17)) ([3d8667d](https://github.com/fjpulidop/specrails-core/commit/3d8667d2056362a480fcfe0d4ac197f4e1bec721))
* chat panel ([#79](https://github.com/fjpulidop/specrails-core/issues/79)) and analytics dashboard ([#80](https://github.com/fjpulidop/specrails-core/issues/80)) ([1a4bea5](https://github.com/fjpulidop/specrails-core/commit/1a4bea51c4b14d9bd9acb2b39ce1621cdf413c73))
* Chat panel + Analytics dashboard ([bd58406](https://github.com/fjpulidop/specrails-core/commit/bd58406191764eea8cc57aa2f9bf9a3e358cf8cb))
* complete UI/UX redesign of web-manager with Tailwind + shadcn/ui ([#69](https://github.com/fjpulidop/specrails-core/issues/69)) ([2993e8b](https://github.com/fjpulidop/specrails-core/commit/2993e8bedaacd4d0b1794b0c8d33f88b2aecd4b4))
* dynamic pipeline phases per command and fix log streaming ([bc1ef91](https://github.com/fjpulidop/specrails-core/commit/bc1ef912ab2470661127d65fd975e39df46842ea))
* dynamic pipeline phases, live log streaming, and markdown log viewer ([5b7bc39](https://github.com/fjpulidop/specrails-core/commit/5b7bc39a3d6e90f4305ee5f984b61a51df90d82e))
* implement security reviewer agent, dry-run mode, and OSS maintainer persona ([2a17c68](https://github.com/fjpulidop/specrails-core/commit/2a17c6811d8779a140057ab56ea5acfc56bf8805))
* integrate web manager notifications into implement pipeline ([a64e7c2](https://github.com/fjpulidop/specrails-core/commit/a64e7c2aeb1b7ef9cb39bc8a5b8511847e91fe60))
* JIRA integration for project labels and epic grouping ([b72a610](https://github.com/fjpulidop/specrails-core/commit/b72a610d9f7cc007215e7c449aa002fb838ff15c))
* rename package to specrails-core, add CI/CD release pipeline ([def4013](https://github.com/fjpulidop/specrails-core/commit/def40135e58b2ae52d47109faff228081b4ec77f))
* security reviewer agent, dry-run mode, and OSS maintainer persona ([60f4ad0](https://github.com/fjpulidop/specrails-core/commit/60f4ad088db8815c86bbba59bd65ef7bc2dc8220))
* smart merge conflict resolver for multi-feature pipelines ([5472fa5](https://github.com/fjpulidop/specrails-core/commit/5472fa5cca98b370996b53568328fe76f3be9dcc))
* sprint 1 - security reviewer, dry-run mode, OSS persona + auto-close issues ([e71e8f2](https://github.com/fjpulidop/specrails-core/commit/e71e8f2d1b1d8eafeed1b1dc1fc64fbc755958aa))
* sync dynamic pipeline + markdown log viewer to templates ([12cc945](https://github.com/fjpulidop/specrails-core/commit/12cc9455b3e42ff8f5863c2b53dbd0b4e0f41a89))
* web manager MVP + versioning & update system ([75b8b7d](https://github.com/fjpulidop/specrails-core/commit/75b8b7dfe58e3eb7f9b2b2cef01c304ed3d68c9e))
* web-manager v2 — SQLite, CLI, queueing, and UI redesign ([3478ca4](https://github.com/fjpulidop/specrails-core/commit/3478ca4d2fb205dfe9ecc05181a015d7e2bd23ed))


### Bug Fixes

* add /specrails:propose-spec to setup installation flow (v0.7.1) ([d1cb459](https://github.com/fjpulidop/specrails-core/commit/d1cb45959a3324cb03d5dda500b9cb7590c4fe8d))
* add border-radius to glass-card utility ([5b7deb3](https://github.com/fjpulidop/specrails-core/commit/5b7deb398ba424d5ac67a6400cfe468559ca28c1))
* add card background and border-radius to RecentJobs ([7213288](https://github.com/fjpulidop/specrails-core/commit/72132883ca61ea118308e1d128d661df5a3c3312))
* add missing -e flag to echo in installer prompt ([3a3fed4](https://github.com/fjpulidop/specrails-core/commit/3a3fed4cecf55c1e108f406811eafd95c9748a04))
* add missing -e flag to echo in installer prompt ([#35](https://github.com/fjpulidop/specrails-core/issues/35)) ([68c3e1b](https://github.com/fjpulidop/specrails-core/commit/68c3e1b70bc26e6337d612710be38f42bea2d010))
* add missing deps to web-manager template ([2236764](https://github.com/fjpulidop/specrails-core/commit/22367645d0895eba149236aa14a932fcf525bca3))
* add missing deps to web-manager template causing broken styles ([5ca88d0](https://github.com/fjpulidop/specrails-core/commit/5ca88d0d8d8a25b7864f8b9b8ecaec0cd5a09906))
* add missing Dracula color variables and utility classes to globals.css ([2e8f745](https://github.com/fjpulidop/specrails-core/commit/2e8f745840965742e98e364f4ba74a625621bb39))
* add propose-spec command to setup installation flow ([e34ac4b](https://github.com/fjpulidop/specrails-core/commit/e34ac4b0ee25c49ffdc10148878d9afe40eb1f89))
* adjust collapsed chat icon to pt-6 ([a186f59](https://github.com/fjpulidop/specrails-core/commit/a186f59c9f9d08372a77353fbd83cef55d7a92c4))
* align collapsed chat icon to top with breathing room ([517026c](https://github.com/fjpulidop/specrails-core/commit/517026c8e5bc3ad0fe4f1f97456010158a0d842d))
* align collapsed chat icon with page content header height ([a7dae7d](https://github.com/fjpulidop/specrails-core/commit/a7dae7db0d8e0f9ece1f9195aaa91859650353c5))
* auto-close GitHub issues when implement pipeline ships ([68ffd11](https://github.com/fjpulidop/specrails-core/commit/68ffd11a567b5eb2599a69381db5df0fb8583b59))
* cache dashboard data at module level to prevent flicker on navigation ([6fb4faa](https://github.com/fjpulidop/specrails-core/commit/6fb4faa8fb26367b94d2664b018285b027a4d45c))
* change default ports to 4200 (server) and 4201 (client) ([fb3a83f](https://github.com/fjpulidop/specrails-core/commit/fb3a83fc6306aa78fcfa666502a373a23d1fde55))
* clean up setup-templates after update when no /setup re-run needed ([e605027](https://github.com/fjpulidop/specrails-core/commit/e60502710602a77a432bcea8105ea1c3e2c9409d))
* content-aware selective updates in update.sh ([6681552](https://github.com/fjpulidop/specrails-core/commit/6681552493945a2077d8d546b2a851857f52cac2))
* detect when update.sh runs from specrails source repo ([6898171](https://github.com/fjpulidop/specrails-core/commit/689817160da4f32f70f6b02f1e14a08cb0420bb8))
* detect when update.sh runs from specrails source repo ([acc6d3e](https://github.com/fjpulidop/specrails-core/commit/acc6d3efdb8d479f6121312632d14f88ac4a8841))
* expose phasesForCommand as public method on QueueManager ([b573964](https://github.com/fjpulidop/specrails-core/commit/b5739649c69981f87f955fe5819f928836f7956b))
* ImplementWizard always uses /specrails:implement, never batch-implement ([3fc1626](https://github.com/fjpulidop/specrails-core/commit/3fc1626f0d13e4f4f1bdf6d123ff0192baa05774))
* ImplementWizard sends single command with all issues instead of one per issue ([9e7a701](https://github.com/fjpulidop/specrails-core/commit/9e7a701b590ff3223c514a3265412a5255886798))
* ImplementWizard uses /specrails:batch-implement when multiple issues selected ([61d6154](https://github.com/fjpulidop/specrails-core/commit/61d6154346c3ef3002ce872bb58dd978a3c458f2))
* JobDetailPage uses shared WS_URL and stable useCallback for live logs ([ef53ddd](https://github.com/fjpulidop/specrails-core/commit/ef53ddd353effd83732119c4f4c2f70be24d5ede))
* LogViewer only renders log and result events to prevent duplicates ([9dda2d4](https://github.com/fjpulidop/specrails-core/commit/9dda2d41b377709fcd70b832d82b872a29c8fa53))
* lower collapsed chat icon padding to pt-8 ([44fb60d](https://github.com/fjpulidop/specrails-core/commit/44fb60df7a8ea45511839e4521f2fc226cc61841))
* make do_core and do_web_manager selective updates ([56f185c](https://github.com/fjpulidop/specrails-core/commit/56f185cdef7759bb1fec9e5881b23081214755ae))
* make job rows clickable instead of showing a View button ([eca7239](https://github.com/fjpulidop/specrails-core/commit/eca72396bbc162d230ce3b8dcd4c2a6e099fb85b))
* move propose-feature.md to templates/commands/specrails/ ([fa78822](https://github.com/fjpulidop/specrails-core/commit/fa78822de6a9e06fe09ec67345745f01ced5454d))
* navbar tooltips render above chat panel with z-50 ([40c64ff](https://github.com/fjpulidop/specrails-core/commit/40c64ffbda754084b5d483332c1d72f2951d14f2))
* pass command as single -p argument to claude CLI ([4a36d87](https://github.com/fjpulidop/specrails-core/commit/4a36d870e5e6b59aea76dc3030697d6137e09bc4))
* persist display text from structured events as log entries in DB ([eaa8770](https://github.com/fjpulidop/specrails-core/commit/eaa87702a0204f21a716508e221944434bdf6296))
* prompt for target repo when installer runs from source ([b97bc48](https://github.com/fjpulidop/specrails-core/commit/b97bc4819d0ac94ce0e5839c1f7cc6876b55c59f))
* prompt for target repo when installer runs from specrails source ([#33](https://github.com/fjpulidop/specrails-core/issues/33)) ([165390e](https://github.com/fjpulidop/specrails-core/commit/165390ed7d26ddcb80ec1b8e41415575fcf3af29))
* remove Active Job section from DashboardPage home ([b06192b](https://github.com/fjpulidop/specrails-core/commit/b06192bbe5ffdd5ad20e6521631edd9ebb7d98db))
* remove duplicate log entries by only using 'log' messages for live streaming ([1976680](https://github.com/fjpulidop/specrails-core/commit/19766809a0bb3b1545ce114febe229a776d93638))
* remove local keyword outside functions and add test suite ([9294a42](https://github.com/fjpulidop/specrails-core/commit/9294a42a51c61a1d12f3746db211b7fad1ebfa90))
* remove npm ci from workflows — package has no dependencies ([32b65e4](https://github.com/fjpulidop/specrails-core/commit/32b65e47bece78c6870ad806db7f787b5cdb7a90))
* remove unused destructured vars from DashboardPage after ActiveJob removal ([140ed17](https://github.com/fjpulidop/specrails-core/commit/140ed171e1dfc44fe1adea1d27d37ddd469edd44))
* replace generic Activity icon with Dracula-styled specrails wordmark ([9046d19](https://github.com/fjpulidop/specrails-core/commit/9046d196d4e645903da739d1cb0b09ce379ef720))
* replace generic dark theme with authentic Dracula colors ([acc6cd8](https://github.com/fjpulidop/specrails-core/commit/acc6cd8d7d7660d8009adabceda9f6c3170eb4c6))
* replace specrails.dev link with Docs button pointing to /docs ([f3dfc38](https://github.com/fjpulidop/specrails-core/commit/f3dfc38be19c5fe913557b996675defa999a0eaa))
* replace ugly rotated CHAT text with centered Dracula-styled icon ([da29d54](https://github.com/fjpulidop/specrails-core/commit/da29d54362f332ff05245ef5e7f6b5b8626473d4))
* resolve slash commands by reading skill markdown and substituting \$ARGUMENTS ([17ab964](https://github.com/fjpulidop/specrails-core/commit/17ab96475098823b8ef7ed980763307a91ce0b7f))
* route /jobs/:id to JobDetailPage instead of DashboardPage ([6fec149](https://github.com/fjpulidop/specrails-core/commit/6fec149aa2e06d68916797042aa74175818033f9))
* setup wizard missing 5 commands from selection and generation ([176c8ad](https://github.com/fjpulidop/specrails-core/commit/176c8ad769fb9a5a5f3d364c7793c84a9709382e))
* stop closing issues at PR creation, rely on Closes #N on merge ([d945060](https://github.com/fjpulidop/specrails-core/commit/d945060fa055aa3d94d0d2c472c5c3fcad07e187))
* support curl-pipe installation (BASH_SOURCE unbound) ([8109f91](https://github.com/fjpulidop/specrails-core/commit/8109f91b23fd83117c188a1a7305b59ff7516de0))
* support curl-pipe installation by detecting BASH_SOURCE absence ([3471f09](https://github.com/fjpulidop/specrails-core/commit/3471f09bf9538e6037dad6c5ad70ed3290bb9eed))
* suppress raw JSON noise from user/system events in log viewer ([409c315](https://github.com/fjpulidop/specrails-core/commit/409c31545893f3df403bcd8eb0494d16adf97d71))
* toast uses glass-card style instead of Sonner's default black background ([0d85c4a](https://github.com/fjpulidop/specrails-core/commit/0d85c4ab3413ad979b62f474b3d70e8efedb897b))
* update remaining unprefixed /implement and /why refs in templates ([6495d4e](https://github.com/fjpulidop/specrails-core/commit/6495d4ecb2c67a439eba2e1292c94a647d8918ad))
* update.sh prompts/skills not tracked in manifest causing false "changed" reports ([24cdeff](https://github.com/fjpulidop/specrails-core/commit/24cdeff08d4a951150b5bf0c7f4a994d2327864d))
* update.sh skipped web-manager sync due to early version check exit ([c7854ac](https://github.com/fjpulidop/specrails-core/commit/c7854ac2c76fa6ed7ff26e370f21f919e8e17727))
* use content-aware checksums instead of version-only comparison ([f0c7826](https://github.com/fjpulidop/specrails-core/commit/f0c7826765598b465cf06995661f7dd95e55c146))
* use harmonious Dracula colors for status pie chart ([d67f616](https://github.com/fjpulidop/specrails-core/commit/d67f6163da307b0924703213c31dc8d6e2d9dd2d))
* use purple/pink/orange for DailyThroughput bar chart ([e4fb50b](https://github.com/fjpulidop/specrails-core/commit/e4fb50b6be5bacd1cc1830d177646cffecbb286f))
* use SharedWebSocket in JobDetailPage to prevent duplicate logs ([c2a8ff2](https://github.com/fjpulidop/specrails-core/commit/c2a8ff23bfbaf10d124e20b7d5ecb3446279eb0d))
* web-manager build script path and PostCSS parent conflict ([bba6a38](https://github.com/fjpulidop/specrails-core/commit/bba6a38e286a2f9ef9add6410f03485a7bba3295))
* widen RecentJobs column headers to prevent text overlap ([8d1b959](https://github.com/fjpulidop/specrails-core/commit/8d1b959ee0da0092b172c7ad7807ed4c27af6742))
