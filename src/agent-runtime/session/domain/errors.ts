/** Stable error codes shared by the domain, application and protocol layers. */
export type SessionErrorCode =
  | 'protocol_mismatch'
  | 'not_initialized'
  | 'invalid_params'
  | 'payload_too_large'
  | 'session_not_found'
  | 'session_closed'
  | 'driver_unavailable'
  | 'policy_unenforceable'
  | 'input_conflict'
  | 'illegal_transition'
  | 'journal_locked'
  | 'store_incompatible'
  | 'busy'
  | 'internal'

const RETRYABLE: ReadonlySet<SessionErrorCode> = new Set(['journal_locked', 'busy', 'internal'])

export class SessionError extends Error {
  readonly retryable: boolean

  constructor(readonly code: SessionErrorCode, message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'SessionError'
    this.retryable = RETRYABLE.has(code)
  }
}

export function isSessionError(error: unknown): error is SessionError {
  return error instanceof SessionError
}
