### Requirement: Settings view accessible via navigation
A Settings view SHALL be accessible at `/settings` via the navbar gear icon.

#### Scenario: Navigate to settings
- **WHEN** user clicks the gear icon in the navbar
- **THEN** the browser SHALL navigate to `/settings` showing all configuration sections

### Requirement: Issue tracker auto-detection
The server SHALL auto-detect available issue trackers at startup and expose the configuration via `GET /api/config`.

#### Scenario: GitHub detected
- **WHEN** `gh` CLI is on PATH and authenticated, and a git remote `origin` exists
- **THEN** `/api/config` SHALL return `issueTracker.github.available: true`, `authenticated: true`, and the repository name extracted from the remote URL

#### Scenario: GitHub not authenticated
- **WHEN** `gh` CLI is on PATH but not authenticated
- **THEN** `/api/config` SHALL return `issueTracker.github.available: true`, `authenticated: false`, and the Settings UI SHALL show "GitHub CLI installed but not authenticated. Run: gh auth login"

#### Scenario: Jira detected
- **WHEN** `jira` CLI is on PATH
- **THEN** `/api/config` SHALL return `issueTracker.jira.available: true`

#### Scenario: No tracker available
- **WHEN** neither `gh` nor `jira` CLI is found
- **THEN** `/api/config` SHALL return both trackers as unavailable and the Settings UI SHALL show "No issue tracker detected. Install GitHub CLI or Jira CLI to enable issue selection."

### Requirement: Issue tracker configuration UI
The Settings view SHALL display the detected issue tracker configuration and allow the user to select the active tracker and configure label filters.

#### Scenario: GitHub is active tracker
- **WHEN** GitHub is detected and selected
- **THEN** the Settings view SHALL show: "Detected: GitHub Issues ✓", the repository name, a label filter input (default: "product-driven-backlog"), and radio buttons to switch tracker source

#### Scenario: Label filter changed
- **WHEN** user changes the label filter text
- **THEN** the new filter SHALL be persisted via `POST /api/config` and used by subsequent `GET /api/issues` calls

### Requirement: Command registry from filesystem
The server SHALL scan `.claude/commands/sr/*.md` at startup and expose the command list via `GET /api/config`.

#### Scenario: Commands discovered
- **WHEN** the server starts
- **THEN** it SHALL read all `.md` files in the project's `.claude/commands/sr/` directory, parse YAML frontmatter for `name` and `description`, and include them in the `/api/config` response as `commands[]`

#### Scenario: Command file without frontmatter
- **WHEN** a command file has no YAML frontmatter
- **THEN** the server SHALL derive the command name from the filename (e.g., `health-check.md` → "Health Check") and use an empty description

### Requirement: Config endpoint serves project configuration
The server SHALL expose `GET /api/config` returning the full project configuration.

#### Scenario: Config response structure
- **WHEN** client calls `GET /api/config`
- **THEN** the response SHALL include: `issueTracker` (detected sources, active source, label filter), `commands` (array of {id, name, description, acceptsInput}), and `project` (name, repository)

### Requirement: Issues endpoint proxies tracker queries
The server SHALL expose `GET /api/issues` that fetches issues from the configured tracker.

#### Scenario: Fetch GitHub issues
- **WHEN** client calls `GET /api/issues` with GitHub as active tracker
- **THEN** the server SHALL execute `gh issue list --repo <repo> --label <label> --state open --json number,title,labels,body --limit 50` and return the parsed JSON

#### Scenario: Fetch with search filter
- **WHEN** client calls `GET /api/issues?search=dark+mode`
- **THEN** the server SHALL include the search term in the CLI query and return filtered results

#### Scenario: Tracker not configured
- **WHEN** client calls `GET /api/issues` but no tracker is configured or authenticated
- **THEN** the server SHALL return HTTP 503 with `{ error: "No issue tracker configured" }`
