## ADDED Requirements

### Requirement: Archives maintain a capability map

The archive step SHALL merge the files an archived change touched into every capability of its delta specs in `openspec/capability-map.json`, idempotently, and the file SHALL NOT be part of the reviewed candidate of new runs.

#### Scenario: First archive

- **WHEN** a change with capability `feature` that edited `code.cjs` is archived
- **THEN** the map lists `code.cjs` under `feature` with the change name

### Requirement: Uncovered code is detected after planning

With `baselineOnTouch` enabled, Core SHALL treat an existing code file of the design's Blast radius as uncovered when the capability map does not list it and no canonical spec names its path or a specific parent directory.

#### Scenario: Covered module

- **WHEN** a spec already names the touched file
- **THEN** no Baseline is added and the record says `not-needed`

#### Scenario: Uncovered module

- **WHEN** the touched file is in no map entry and no spec
- **THEN** the architect adds a Baseline task group and an as-built spec in the same session

### Requirement: Characterization passes on the base code first

The developer's first turn SHALL complete only the Baseline group; Core SHALL refuse non-test edits and SHALL run the verification plan on the unchanged code, and the run SHALL stop with the blocker `baseline_characterization_failed` unless that run passes with a receipt.

#### Scenario: Characterization fails on base

- **WHEN** a characterization test fails against the unchanged code
- **THEN** the run is blocked before the developer edits the module and `baseline.json` records `failed` with the receipt

#### Scenario: Module edited too early

- **WHEN** the baseline stage changes a non-test file
- **THEN** the run is blocked and `baseline.json` records `violated`

### Requirement: Baseline cost is attributed apart

Baseline turns SHALL run with invocation kind `baseline`, and the efficiency summary SHALL report their invocations, roles and usage separately.

#### Scenario: Baseline run

- **WHEN** a run plans and passes a baseline
- **THEN** `efficiencySummary.baseline` counts the architect and developer baseline turns and their spend
