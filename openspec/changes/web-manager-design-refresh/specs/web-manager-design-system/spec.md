## MODIFIED Requirements

### Requirement: Navbar present on all views
A persistent navbar SHALL appear at the top of every view with glassmorphic styling matching the specrails brand.

#### Scenario: Navbar rendering
- **WHEN** any view is loaded
- **THEN** the navbar SHALL use a glass-card style background with the specrails wordmark in gradient-text, nav links, and settings icon

#### Scenario: Active view highlighting
- **WHEN** the user is on a specific view
- **THEN** the corresponding nav link SHALL be highlighted with the primary (purple) color

### Requirement: Badge variants use Dracula colors
Status badges SHALL use Dracula palette colors for consistent branding.

#### Scenario: Running job badge
- **WHEN** a job has status `running`
- **THEN** the badge SHALL use dracula-cyan color scheme

#### Scenario: Completed job badge
- **WHEN** a job has status `completed`
- **THEN** the badge SHALL use dracula-green color scheme

#### Scenario: Failed job badge
- **WHEN** a job has status `failed`
- **THEN** the badge SHALL use dracula-red color scheme

#### Scenario: Canceled job badge
- **WHEN** a job has status `canceled`
- **THEN** the badge SHALL use dracula-orange color scheme

### Requirement: Pipeline phase indicators use Dracula colors
Pipeline phase status indicators SHALL use Dracula palette colors.

#### Scenario: Phase running
- **WHEN** a pipeline phase has state `running`
- **THEN** it SHALL use dracula-purple with animated spin

#### Scenario: Phase completed
- **WHEN** a pipeline phase has state `done`
- **THEN** it SHALL use dracula-green

#### Scenario: Phase error
- **WHEN** a pipeline phase has state `error`
- **THEN** it SHALL use dracula-red

#### Scenario: Phase idle
- **WHEN** a pipeline phase has state `idle`
- **THEN** it SHALL use dracula-comment at reduced opacity

### Requirement: Log viewer uses terminal styling
The log viewer container SHALL use the `.terminal` styling pattern from specrails-web.

#### Scenario: Log viewer background
- **WHEN** log content is displayed
- **THEN** it SHALL use dracula-darker background with glass-border, matching the website's terminal component

#### Scenario: Log type colors use Dracula palette
- **WHEN** different log event types are rendered
- **THEN** assistant text SHALL use foreground/80, tool calls SHALL use dracula-cyan, stderr SHALL use dracula-orange, result summaries SHALL use dracula-green, phase headers SHALL use gradient-text style
