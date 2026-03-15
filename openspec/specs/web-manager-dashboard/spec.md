### Requirement: Dashboard is the default view
The root URL (`/`) SHALL render the Dashboard view containing an active job card, a command grid, and a recent jobs list.

#### Scenario: User opens web-manager
- **WHEN** user navigates to `localhost:4200/`
- **THEN** the Dashboard view is displayed with navbar, command grid, recent jobs, and status bar

#### Scenario: No active job
- **WHEN** no job is currently running
- **THEN** the active job area SHALL display an empty state with the message "No jobs running" and guidance text "Pick a command below to get started"

### Requirement: Active job card shows current job status
When a job is running, the Dashboard SHALL display a prominent card at the top showing the command, elapsed time, estimated cost, pipeline phase progress, and action buttons.

#### Scenario: Job is running
- **WHEN** a job has status `running`
- **THEN** the active job card SHALL display: command name, elapsed timer (updating every second), cost so far, pipeline phase indicators (Architect → Developer → Reviewer → Ship), a "View Logs" button that navigates to `/jobs/:id`, and a "Cancel Job" button

#### Scenario: Job completes while on dashboard
- **WHEN** the active job transitions to `completed` or `failed`
- **THEN** the active job card SHALL update to show final status, the job SHALL move to the recent jobs list, and a toast notification SHALL appear

### Requirement: Command grid displays available commands
The Dashboard SHALL render a grid of command cards auto-populated from the server's command registry.

#### Scenario: Commands loaded successfully
- **WHEN** the Dashboard mounts
- **THEN** it SHALL fetch `GET /api/config` and render one card per command with: an icon, the command name, a short description, and a tooltip with extended description on hover

#### Scenario: Command card clicked
- **WHEN** user clicks a command card that does not require input (e.g., Health Check, Backlog)
- **THEN** the system SHALL immediately queue the command via `POST /api/spawn` and show a toast confirmation

#### Scenario: Command card with wizard clicked
- **WHEN** user clicks "Implement" or "Batch Implement"
- **THEN** a modal wizard SHALL open instead of immediately queuing

### Requirement: Recent jobs list shows job history
The Dashboard SHALL display the most recent jobs in a list format with status, command, time, cost, and a "View" link.

#### Scenario: Jobs exist
- **WHEN** there are completed/failed/canceled jobs
- **THEN** the recent jobs list SHALL show up to 10 jobs sorted by most recent, each with: status badge (colored), command text, relative time ("2m ago"), cost if available, and a "View" link navigating to `/jobs/:id`

#### Scenario: No job history
- **WHEN** no jobs have been run
- **THEN** the list SHALL show an empty state: "No jobs yet. Run a command to get started."

### Requirement: Status bar shows connection and cost summary
A persistent status bar at the bottom of all views SHALL show connection status and aggregate stats.

#### Scenario: Connected
- **WHEN** WebSocket is connected
- **THEN** status bar SHALL show a green dot with "Connected", today's job count and cost, and all-time job count and cost

#### Scenario: Disconnected
- **WHEN** WebSocket connection is lost
- **THEN** status bar SHALL show a red dot with "Disconnected" and retry information

### Requirement: Navbar has three primary navigation links

The navbar SHALL contain primary navigation links: Home (→ `/`) and Analytics (→ `/analytics`) as center nav items, and Settings (→ `/settings`) as a right-side icon.

#### Scenario: Analytics link in navbar
- **WHEN** the navbar renders
- **THEN** it SHALL display an "Analytics" link that navigates to `/analytics` and applies the active highlight style when on the analytics route

#### Scenario: Home link active state
- **WHEN** user is on the root path `/`
- **THEN** the Home nav link SHALL apply the active highlight style, and SHALL NOT highlight when on `/analytics` or `/settings`
