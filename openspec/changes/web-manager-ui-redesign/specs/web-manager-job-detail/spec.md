## ADDED Requirements

### Requirement: Job Detail view accessible via URL
Each job SHALL have a dedicated detail view at `/jobs/:id` that displays full job information, pipeline progress, and logs.

#### Scenario: Navigate to job detail
- **WHEN** user clicks "View" on a job in the dashboard or navigates to `/jobs/:id`
- **THEN** the Job Detail view SHALL load showing: job command, status badge, start time, duration (live-updating if running), cost, pipeline progress, and a log viewer

#### Scenario: Job not found
- **WHEN** user navigates to `/jobs/:id` with an invalid ID
- **THEN** a "Job not found" message SHALL be displayed with a link back to Dashboard

#### Scenario: Back navigation
- **WHEN** user clicks "← Dashboard" in the navbar
- **THEN** the browser SHALL navigate back to the Dashboard view

### Requirement: Pipeline progress visualization
The Job Detail view SHALL display the 4-phase pipeline (Architect → Developer → Reviewer → Ship) with visual status indicators.

#### Scenario: Phase in progress
- **WHEN** a pipeline phase has state `running`
- **THEN** the phase indicator SHALL show an animated pulse, the phase name, and elapsed time for that phase

#### Scenario: Phase completed
- **WHEN** a pipeline phase has state `done`
- **THEN** the phase indicator SHALL show a checkmark, the phase name, and the duration it took

#### Scenario: Phase pending
- **WHEN** a pipeline phase has state `idle`
- **THEN** the phase indicator SHALL show an empty circle and the phase name in muted color

#### Scenario: Phase errored
- **WHEN** a pipeline phase has state `error`
- **THEN** the phase indicator SHALL show a red X and the phase name in error color

### Requirement: Formatted log viewer with syntax coloring
The Job Detail view SHALL display job logs with formatting based on event type, using distinct visual treatment for each log category.

#### Scenario: Logs displayed on demand
- **WHEN** user is on the Job Detail view
- **THEN** logs SHALL be displayed in a scrollable container with formatted, colored lines

#### Scenario: Phase header logs
- **WHEN** a log line represents a phase transition
- **THEN** it SHALL render as a bold header with a `▸` prefix and distinct styling

#### Scenario: Tool call logs
- **WHEN** a log line represents a `tool_use` event
- **THEN** it SHALL render with the tool name in brackets and a distinctive color (e.g., cyan), with the input truncated

#### Scenario: Assistant text logs
- **WHEN** a log line represents `assistant` text output
- **THEN** it SHALL render in the primary text color as readable paragraphs

#### Scenario: Error logs
- **WHEN** a log line comes from `stderr`
- **THEN** it SHALL render in a warning/error color (orange/red)

#### Scenario: Log filtering
- **WHEN** user types in the filter input
- **THEN** only log lines containing the filter text SHALL be visible, case-insensitive

#### Scenario: Auto-scroll behavior
- **WHEN** new logs arrive and user has not scrolled up
- **THEN** the log viewer SHALL auto-scroll to the bottom

#### Scenario: User scrolls up
- **WHEN** user scrolls up in the log viewer
- **THEN** auto-scroll SHALL pause and a "Jump to bottom" button SHALL appear

### Requirement: Historical logs loaded from SQLite
The Job Detail view SHALL load historical log events from the server, not just the in-memory buffer.

#### Scenario: Page load for completed job
- **WHEN** user navigates to a completed job's detail page
- **THEN** the client SHALL fetch events from `GET /api/jobs/:id` and render all historical logs

#### Scenario: Page load for running job
- **WHEN** user navigates to a running job's detail page
- **THEN** the client SHALL fetch existing events from the API AND subscribe to WebSocket for new live events, merging both into the log view

### Requirement: Job actions available in detail view
The Job Detail view SHALL provide action buttons appropriate to the job's status.

#### Scenario: Running job actions
- **WHEN** viewing a running job
- **THEN** a "Cancel Job" button SHALL be visible; clicking it SHALL call `DELETE /api/jobs/:id` and show a toast

#### Scenario: Terminal job actions
- **WHEN** viewing a completed/failed/canceled job
- **THEN** no action buttons SHALL be displayed (job is immutable)
