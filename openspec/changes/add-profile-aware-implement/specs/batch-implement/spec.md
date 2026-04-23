## ADDED Requirements

### Requirement: Per-rail profile forwarding
`batch-implement` SHALL support forwarding a distinct profile path to each rail spawned in the batch. The profile path for a rail SHALL be supplied either via an environment variable set by the caller or via a per-rail `--profile <path>` argument in the batch manifest.

#### Scenario: Each rail receives its own profile env
- **WHEN** batch-implement spawns rails for features `A`, `B`, `C` with profile paths `/tmp/pA.json`, `/tmp/pB.json`, `/tmp/pC.json` respectively
- **THEN** each spawned `/specrails:implement` invocation receives `$SPECRAILS_PROFILE_PATH` set to its own rail's path

#### Scenario: Rails run concurrently with distinct profiles
- **WHEN** rail A runs with profile declaring `sr-reviewer: opus` AND rail C runs simultaneously with profile declaring `sr-reviewer: sonnet`
- **THEN** rail A's reviewer invocation uses `opus` AND rail C's reviewer invocation uses `sonnet`, independently

### Requirement: No batch-level profile coupling
`batch-implement` SHALL NOT enforce that all rails share the same profile. Rails with distinct profiles SHALL be supported in the same batch without additional configuration.

#### Scenario: Mixed profiles in single batch
- **WHEN** a batch contains one rail with profile "default" and another with profile "security-heavy"
- **THEN** both rails run to completion using their declared profiles and the batch reports per-rail results

### Requirement: Absent profile forwarding preserves legacy
When no profile path is forwarded to a rail, that rail SHALL run in legacy mode regardless of whether other rails in the same batch have profiles.

#### Scenario: One rail without profile in a mixed batch
- **WHEN** rail A has `$SPECRAILS_PROFILE_PATH` set AND rail B does not AND neither has a project-default file in its cwd
- **THEN** rail A runs in profile mode AND rail B runs in legacy mode
