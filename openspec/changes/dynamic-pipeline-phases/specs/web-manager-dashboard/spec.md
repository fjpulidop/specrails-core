## MODIFIED Requirements

### Requirement: Active job card shows current job status
When a job is running, the Dashboard SHALL display a prominent card at the top showing the command, elapsed time, estimated cost, pipeline phase progress, and action buttons.

#### Scenario: Job is running with phases
- **WHEN** a job has status `running` and its command declares pipeline phases
- **THEN** the active job card SHALL display: command name, elapsed timer (updating every second), cost so far, pipeline phase indicators matching the command's declared phases, a "View Logs" button that navigates to `/jobs/:id`, and a "Cancel Job" button

#### Scenario: Job is running without phases
- **WHEN** a job has status `running` and its command declares no pipeline phases
- **THEN** the active job card SHALL display: command name, elapsed timer, cost so far, a "View Logs" button, and a "Cancel Job" button — with no pipeline progress bar

#### Scenario: Job completes while on dashboard
- **WHEN** the active job transitions to `completed` or `failed`
- **THEN** the active job card SHALL update to show final status, the job SHALL move to the recent jobs list, and a toast notification SHALL appear
