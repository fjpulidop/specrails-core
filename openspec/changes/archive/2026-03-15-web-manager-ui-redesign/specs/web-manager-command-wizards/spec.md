## ADDED Requirements

### Requirement: Implement wizard offers From Issues and Free Form paths
When user clicks the "Implement" command card, a modal dialog SHALL open presenting two path options: "From Issues" and "Free Form".

#### Scenario: Wizard opens
- **WHEN** user clicks the Implement command card
- **THEN** a modal dialog SHALL appear with two selectable cards: "From Issues" (with description "Select from your issue tracker") and "Free Form" (with description "Describe a new feature")

### Requirement: From Issues path fetches and displays issues
The "From Issues" path SHALL fetch open issues from the configured issue tracker and allow single-selection for Implement.

#### Scenario: GitHub issues loaded
- **WHEN** user selects "From Issues" and GitHub is configured
- **THEN** the wizard SHALL call `GET /api/issues` and display a searchable, filterable list of open issues with: checkbox, issue number, title, and labels

#### Scenario: Issue selected and submitted
- **WHEN** user selects one issue and clicks "Implement"
- **THEN** the wizard SHALL call `POST /api/spawn` with command `/sr:implement #<issue-number>`, close the modal, and show a toast "Job queued"

#### Scenario: No issue tracker configured
- **WHEN** user selects "From Issues" but no tracker is configured
- **THEN** the wizard SHALL display a message "No issue tracker configured" with a link to Settings

### Requirement: Free Form path accepts feature description
The "Free Form" path SHALL present a form for describing a single feature with title and description.

#### Scenario: Feature described and submitted
- **WHEN** user fills in title and description and clicks "Implement Feature"
- **THEN** the wizard SHALL call `POST /api/spawn` with command `/sr:implement <title>: <description>`, close the modal, and show a toast

#### Scenario: Empty submission prevented
- **WHEN** user clicks "Implement Feature" with empty title
- **THEN** the submit button SHALL be disabled and the title field SHALL show a validation hint

### Requirement: Batch Implement wizard supports multi-selection
When user clicks the "Batch Implement" command card, a modal dialog SHALL open with the same two paths but configured for multiple features.

#### Scenario: Batch wizard opens
- **WHEN** user clicks the Batch Implement command card
- **THEN** a modal dialog SHALL appear with "From Issues" and "Free Form" paths, labeled for batch operation

#### Scenario: Batch From Issues with multi-select
- **WHEN** user selects "From Issues" in Batch mode
- **THEN** the issue list SHALL allow multiple checkbox selections, show a count of selected issues, and the submit button SHALL read "Implement N issues"

#### Scenario: Batch From Issues submitted
- **WHEN** user selects multiple issues and clicks submit
- **THEN** the wizard SHALL call `POST /api/spawn` with command `/sr:batch-implement #<n1> #<n2> ...`, close the modal, and show a toast

#### Scenario: Batch Free Form with multiple features
- **WHEN** user selects "Free Form" in Batch mode
- **THEN** the wizard SHALL show a number selector "How many features?", render that many title+description form groups, allow adding/removing features, and show a submit button "Queue N features"

#### Scenario: Batch Free Form submitted
- **WHEN** user fills in multiple features and clicks submit
- **THEN** the wizard SHALL call `POST /api/spawn` with command `/sr:batch-implement "<title1>: <desc1>" "<title2>: <desc2>" ...`, close the modal, and show a toast

### Requirement: All wizard modals have consistent UX
All wizard modals SHALL follow consistent interaction patterns.

#### Scenario: Modal dismissal
- **WHEN** user clicks the X button, presses Escape, or clicks the overlay
- **THEN** the modal SHALL close without queuing any job

#### Scenario: Loading state during submission
- **WHEN** the wizard is submitting a job via API
- **THEN** the submit button SHALL show a loading spinner and be disabled until the response arrives

#### Scenario: Contextual help in modals
- **WHEN** a wizard modal is open
- **THEN** informational text SHALL explain the pipeline: "Each feature runs through the full pipeline: architect → developer → reviewer → ship"
