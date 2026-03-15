## MODIFIED Requirements

### Requirement: Pipeline progress visualization
The Job Detail view SHALL display pipeline phases with visual status indicators, using the phase definitions declared by the job's command.

#### Scenario: Command with phases
- **WHEN** a job's command declares pipeline phases
- **THEN** the pipeline progress bar SHALL render exactly those phases (in declared order) with status indicators

#### Scenario: Command without phases
- **WHEN** a job's command declares no pipeline phases
- **THEN** the pipeline progress bar SHALL NOT be rendered

#### Scenario: Phase in progress
- **WHEN** a pipeline phase has state `running`
- **THEN** the phase indicator SHALL show an animated pulse, the phase label, and elapsed time for that phase

#### Scenario: Phase completed
- **WHEN** a pipeline phase has state `done`
- **THEN** the phase indicator SHALL show a checkmark, the phase label, and the duration it took

#### Scenario: Phase pending
- **WHEN** a pipeline phase has state `idle`
- **THEN** the phase indicator SHALL show an empty circle and the phase label in muted color

#### Scenario: Phase errored
- **WHEN** a pipeline phase has state `error`
- **THEN** the phase indicator SHALL show a red X and the phase label in error color

## ADDED Requirements

### Requirement: Live log streaming sends structured events
The server SHALL broadcast raw structured events via WebSocket as `type: 'event'` messages, in addition to the existing `type: 'log'` display text messages. The client SHALL use structured events for rendering when available.

#### Scenario: Assistant message during live execution
- **WHEN** the Claude CLI outputs an `assistant` event during a running job
- **THEN** the server SHALL broadcast a `type: 'event'` WebSocket message with `event_type: 'assistant'` and the full JSON payload
- **AND** the `LogViewer` SHALL render it with assistant styling (primary text color)

#### Scenario: Tool use during live execution
- **WHEN** the Claude CLI outputs a `tool_use` event during a running job
- **THEN** the server SHALL broadcast a `type: 'event'` WebSocket message with `event_type: 'tool_use'` and the full JSON payload
- **AND** the `LogViewer` SHALL render it with tool styling (cyan, tool name in brackets)

#### Scenario: Result event during live execution
- **WHEN** the Claude CLI outputs a `result` event during a running job
- **THEN** the server SHALL broadcast a `type: 'event'` WebSocket message with `event_type: 'result'` and the full JSON payload
- **AND** the `LogViewer` SHALL render a completion summary with duration, cost, and turns

#### Scenario: Historical and live events render identically
- **WHEN** comparing a completed job's log view (loaded from API) with the same job's log view during live execution
- **THEN** the rendered output SHALL be identical — same event types, same styling, same information

### Requirement: WebSocket URL derived from page origin
The client SHALL derive the WebSocket URL from the current page origin instead of using a hardcoded URL.

#### Scenario: Page served from localhost:4200
- **WHEN** the page is loaded from `http://localhost:4200`
- **THEN** the WebSocket SHALL connect to `ws://localhost:4200`

#### Scenario: Page served from custom host
- **WHEN** the page is loaded from `http://myhost:8080`
- **THEN** the WebSocket SHALL connect to `ws://myhost:8080`

#### Scenario: Page served over HTTPS
- **WHEN** the page is loaded from `https://example.com`
- **THEN** the WebSocket SHALL connect to `wss://example.com`
