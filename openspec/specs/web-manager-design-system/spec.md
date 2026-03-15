### Requirement: Tailwind CSS replaces all inline styles
The client SHALL use Tailwind CSS for all styling, removing every inline `style={}` object from the codebase.

#### Scenario: No inline styles remain
- **WHEN** the redesign is complete
- **THEN** zero React components SHALL contain inline `style={}` props (except for dynamic values that cannot be expressed as Tailwind classes, e.g., calculated widths)

### Requirement: shadcn/ui components used for all UI primitives
The client SHALL use shadcn/ui components for buttons, dialogs, tooltips, cards, badges, inputs, selects, and toasts instead of custom HTML elements.

#### Scenario: Button usage
- **WHEN** any clickable action is rendered
- **THEN** it SHALL use the shadcn `Button` component with appropriate variant (default, destructive, outline, ghost)

#### Scenario: Dialog usage
- **WHEN** a modal wizard is shown
- **THEN** it SHALL use the shadcn `Dialog` component with `DialogContent`, `DialogHeader`, `DialogTitle`, and `DialogDescription`

#### Scenario: Tooltip usage
- **WHEN** any element has contextual help
- **THEN** it SHALL use the shadcn `Tooltip` component wrapping a `TooltipTrigger` and `TooltipContent`

### Requirement: React Router provides view navigation
The client SHALL use React Router v6 for client-side navigation between Dashboard (`/`), Job Detail (`/jobs/:id`), and Settings (`/settings`).

#### Scenario: Direct URL access
- **WHEN** user navigates directly to `/jobs/abc-123`
- **THEN** the app SHALL render the Job Detail view for that job ID

#### Scenario: Browser back/forward
- **WHEN** user uses browser back/forward buttons
- **THEN** navigation SHALL work correctly between views without full page reload

### Requirement: Lucide React provides all icons
The client SHALL use Lucide React for all iconography, with consistent sizing and stroke width.

#### Scenario: Command card icons
- **WHEN** command cards are rendered
- **THEN** each card SHALL display a Lucide icon appropriate to its function (e.g., Rocket for Implement, Package for Batch, ClipboardList for Backlog)

#### Scenario: Status icons
- **WHEN** job status is displayed
- **THEN** status SHALL use Lucide icons: CheckCircle (completed), XCircle (failed), Ban (canceled), Loader (running, animated)

### Requirement: Navbar present on all views
A persistent navbar SHALL appear at the top of every view with: the specrails logo/wordmark, navigation links (Dashboard, Jobs), a Settings gear icon, and an external link to specrails.dev.

#### Scenario: Navbar rendering
- **WHEN** any view is loaded
- **THEN** the navbar SHALL display with the specrails brand, nav links highlighting the active view, and the settings gear icon

#### Scenario: External link
- **WHEN** user clicks "specrails.dev" in the navbar
- **THEN** it SHALL open specrails.dev in a new tab

### Requirement: Toast notifications for all user actions
The system SHALL use sonner toasts to provide feedback for every user-initiated action.

#### Scenario: Job queued
- **WHEN** a job is successfully queued via any command
- **THEN** a success toast SHALL appear: "Job queued" with the command name

#### Scenario: Job canceled
- **WHEN** a job is canceled
- **THEN** an info toast SHALL appear: "Job canceled"

#### Scenario: Error feedback
- **WHEN** an API call fails
- **THEN** an error toast SHALL appear with the error message

### Requirement: Contextual tooltips on all interactive elements
Every interactive element (buttons, cards, badges, pipeline phases) SHALL have a tooltip explaining its function.

#### Scenario: Command card tooltip
- **WHEN** user hovers over a command card
- **THEN** a tooltip SHALL appear with the command's extended description from its frontmatter

#### Scenario: Pipeline phase tooltip
- **WHEN** user hovers over a pipeline phase indicator
- **THEN** a tooltip SHALL explain what that phase does (e.g., "Architect: Designs the implementation plan and creates task breakdown")

#### Scenario: Action button tooltip
- **WHEN** user hovers over the "Cancel Job" button
- **THEN** a tooltip SHALL read "Send SIGTERM to stop the running process"

### Requirement: Empty states guide the user
Every section that can be empty SHALL display a helpful empty state with guidance.

#### Scenario: No active job empty state
- **WHEN** no job is running on the Dashboard
- **THEN** the active job area SHALL show "No jobs running" with "Pick a command below to get started"

#### Scenario: No job history empty state
- **WHEN** no jobs have been run
- **THEN** the recent jobs area SHALL show "No jobs yet. Run a command to get started."

#### Scenario: No issues found empty state
- **WHEN** the issue picker returns zero results
- **THEN** the issue list SHALL show "No open issues found" with the current filter criteria
