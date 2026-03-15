## MODIFIED Requirements

### Requirement: Job Detail view accessible via URL
Each job SHALL have a detail view with glassmorphic header card and terminal-styled log viewer.

#### Scenario: Navigate to job detail
- **WHEN** user navigates to `/jobs/:id`
- **THEN** the header SHALL be a glass-card with Dracula-colored status badge, gradient-text for the job ID, and monospace command display

### Requirement: Pipeline progress visualization
The pipeline progress SHALL use Dracula colors for phase indicators.

#### Scenario: Phase visual styling
- **WHEN** phases are rendered
- **THEN** running phases SHALL use dracula-purple, done phases SHALL use dracula-green, error phases SHALL use dracula-red, idle phases SHALL use dracula-comment/30, and connector lines SHALL use gradient coloring when phases complete

### Requirement: Formatted log viewer with syntax coloring
The log viewer SHALL use terminal styling with Dracula-themed syntax colors.

#### Scenario: Log container styling
- **WHEN** log content is displayed
- **THEN** the container SHALL use dracula-darker background, glass-border, rounded-xl corners, and terminal scrollbar styling

#### Scenario: Log event Dracula colors
- **WHEN** different event types are rendered
- **THEN** assistant text SHALL use foreground/80, tool calls SHALL use dracula-cyan, stderr SHALL use dracula-orange, result summaries SHALL use dracula-green, phase headers SHALL use foreground with font-semibold

#### Scenario: Markdown table styling
- **WHEN** assistant messages contain GFM tables
- **THEN** tables SHALL use dracula-current background for headers, dracula-darker/transparent zebra rows, and border-border/30 borders
