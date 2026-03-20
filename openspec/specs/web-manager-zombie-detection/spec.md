## ADDED Requirements

### Requirement: Inactivity timeout configuration
`QueueManager` SHALL accept a configurable inactivity threshold for zombie detection via the `WM_ZOMBIE_TIMEOUT_MS` environment variable (integer, milliseconds) or via constructor option `zombieTimeoutMs`. The default SHALL be `300000` (5 minutes). Setting the value to `0` or less SHALL disable zombie detection entirely.

#### Scenario: Env var configures timeout
- **GIVEN** `WM_ZOMBIE_TIMEOUT_MS=60000` is set in the environment
- **WHEN** `QueueManager` is constructed
- **THEN** zombie detection fires after 60 seconds of job inactivity

#### Scenario: Constructor option overrides env var
- **GIVEN** `WM_ZOMBIE_TIMEOUT_MS=60000` is set in the environment
- **WHEN** `QueueManager` is constructed with `options.zombieTimeoutMs = 120000`
- **THEN** zombie detection fires after 120 seconds of job inactivity

#### Scenario: Zero value disables zombie detection
- **GIVEN** `WM_ZOMBIE_TIMEOUT_MS=0` is set in the environment
- **WHEN** a job runs with no output for any duration
- **THEN** the job is NOT auto-terminated and no zombie log line is emitted

### Requirement: Zombie detection via inactivity timer
`QueueManager` SHALL start an inactivity timer when a job transitions to `running`. The timer SHALL be reset each time the job produces any stdout or stderr output. If the timer fires (no output received within the configured threshold), the job SHALL be detected as a zombie.

#### Scenario: Active job is not terminated
- **GIVEN** a job is running with zombie timeout of 30 seconds
- **WHEN** the job emits at least one output line every 29 seconds
- **THEN** the inactivity timer is continuously reset and the job is NOT terminated

#### Scenario: Inactive job is detected as zombie
- **GIVEN** a job is running with zombie timeout of 30 seconds
- **WHEN** no stdout or stderr output is received for 30 seconds
- **THEN** zombie detection fires and the job is auto-terminated

#### Scenario: Timer is cleared on job completion
- **GIVEN** a running job has an active inactivity timer
- **WHEN** the job exits normally (exit code 0)
- **THEN** the inactivity timer is cleared without firing

#### Scenario: Timer is cleared on job cancellation
- **GIVEN** a running job has an active inactivity timer
- **WHEN** `cancel(jobId)` is called on the running job
- **THEN** the inactivity timer is cleared before `_kill()` proceeds

### Requirement: Zombie detection logging
When a zombie is detected, `QueueManager` SHALL emit a `log` message (source: `stderr`) with a human-readable description of the detection event, including the job ID and the inactivity threshold in seconds. The message SHALL also be written to `console.error` for server-side log capture.

#### Scenario: Zombie detection emits log line
- **GIVEN** a job has been inactive for the configured threshold
- **WHEN** zombie detection fires
- **THEN** a `log` WebSocket message is broadcast with:
  - `source: "stderr"`
  - `line` containing `"zombie-detection"`, the job ID, and the timeout in seconds
  - `processId` equal to the zombie job's ID

#### Scenario: Zombie detection is logged to console
- **GIVEN** zombie detection fires for a job
- **WHEN** the auto-termination sequence starts
- **THEN** `console.error` is called with the same zombie detection message

### Requirement: Zombie auto-termination
Upon zombie detection, `QueueManager` SHALL initiate the same kill sequence used by `cancel()`: SIGTERM to the process tree followed by SIGKILL after 5 seconds if the process has not exited. The job SHALL ultimately reach `canceled` status.

#### Scenario: Zombie job reaches canceled status
- **GIVEN** a zombie is detected for job X
- **WHEN** the kill sequence completes (process exits)
- **THEN** job X has `status: "canceled"` and a non-null `finishedAt`

#### Scenario: Zombie SIGKILL fallback
- **GIVEN** a zombie is detected and SIGTERM is sent
- **WHEN** the process does not exit within 5 seconds
- **THEN** SIGKILL is sent to the process tree

### Requirement: Queue drains after zombie cleanup
After a zombie job is auto-terminated, `QueueManager` SHALL invoke `_drainQueue()` to start the next queued job (if any) following the same behavior as a normal job exit.

#### Scenario: Next queued job starts after zombie cleanup
- **GIVEN** job A is running (zombie detected), job B is next in queue
- **WHEN** zombie detection kills job A and cleanup completes
- **THEN** job B transitions to `running` state automatically
