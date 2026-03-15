## MODIFIED Requirements

### Requirement: Active job card shows current job status
When a job is running, the Dashboard SHALL display a glass-card with glow effect showing the command, elapsed time, estimated cost, pipeline phase progress, and action buttons.

#### Scenario: Job is running
- **WHEN** a job has status `running`
- **THEN** the active job card SHALL be a glass-card with a subtle purple glow, displaying: command name, elapsed timer, cost, pipeline phases, and action buttons

#### Scenario: No active job
- **WHEN** no job is currently running
- **THEN** the empty state SHALL use muted text on a glass-card background with gradient-text for the heading

### Requirement: Command grid displays available commands
The Dashboard SHALL render a grid of glass-card command tiles with glow-on-hover effects.

#### Scenario: Command card styling
- **WHEN** command cards are rendered
- **THEN** each card SHALL be a glass-card with an icon, the command name, description, and a subtle glow effect on hover matching the command's semantic color

#### Scenario: Command card hover
- **WHEN** a user hovers over a command card
- **THEN** the card border SHALL brighten and a subtle glow SHALL appear

### Requirement: Recent jobs list shows job history
The recent jobs list SHALL use glass-card styling with Dracula-colored status badges.

#### Scenario: Jobs list rendering
- **WHEN** there are completed/failed/canceled jobs
- **THEN** each job row SHALL have alternating background opacity, Dracula-colored status badges, and monospace command text
