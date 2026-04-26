/**
 * Typed error hierarchy for the installer. Each subclass carries an
 * `exitCode` which the CLI dispatcher translates to the process exit
 * code so callers (shells, CI, specrails-hub wizard) can distinguish
 * failure modes without string-parsing stdout.
 *
 * Exit-code ranges:
 *   0       — success
 *   1       — generic runtime error
 *   10-19   — prerequisite failures (missing tools, auth, etc.)
 *   20-29   — filesystem / I/O errors
 *   30-39   — git errors
 *   40-49   — provider detection / resolution errors
 *   50-59   — child-process errors (spawned command failed)
 *   60      — user aborted a prompt (Ctrl+C or non-TTY with no default)
 */

export class InstallerError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode: number = 1) {
    super(message)
    this.name = 'InstallerError'
    this.exitCode = exitCode
    // Preserve prototype chain across transpilation.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class PrerequisiteError extends InstallerError {
  constructor(message: string) {
    super(message, 10)
    this.name = 'PrerequisiteError'
  }
}

export class FilesystemError extends InstallerError {
  readonly path: string | undefined

  constructor(message: string, path?: string) {
    super(message, 20)
    this.name = 'FilesystemError'
    this.path = path
  }
}

export class GitError extends InstallerError {
  readonly command: string | undefined

  constructor(message: string, command?: string) {
    super(message, 30)
    this.name = 'GitError'
    this.command = command
  }
}

export class ProviderError extends InstallerError {
  constructor(message: string) {
    super(message, 40)
    this.name = 'ProviderError'
  }
}

export class ExecError extends InstallerError {
  readonly command: string
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string

  constructor(
    command: string,
    code: number | null,
    stdout: string,
    stderr: string,
  ) {
    super(`command "${command}" exited with code ${code}`, 50)
    this.name = 'ExecError'
    this.command = command
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

export class PromptAbortError extends InstallerError {
  constructor(message: string = 'prompt aborted by user or non-TTY environment') {
    super(message, 60)
    this.name = 'PromptAbortError'
  }
}

/** Runtime check used by the CLI to map a caught unknown to a typed error. */
export function isInstallerError(err: unknown): err is InstallerError {
  return err instanceof InstallerError
}
