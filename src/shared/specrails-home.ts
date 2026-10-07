import os from 'node:os'
import path from 'node:path'

/**
 * The user-level Specrails home. Registry, framework store, workspaces and
 * agent session journals all live under `<home>/.specrails`, never inside a
 * project repository.
 *
 * `SPECRAILS_REGISTRY_HOME` overrides the base directory so tests (and
 * isolated installs) redirect every user-level artifact together.
 */
export function userHome(home?: string): string {
  return home ?? process.env.SPECRAILS_REGISTRY_HOME ?? os.homedir()
}

/** Absolute path to `<home>/.specrails`. */
export function specrailsHome(home?: string): string {
  return path.join(userHome(home), '.specrails')
}

/** Scope used by session hosts that are not bound to a project. */
export const GLOBAL_SESSION_SCOPE = 'global'

/** Same alphabet the registry uses for project slugs, bounded for file names. */
const SCOPE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/

/** True when `scope` is a valid session scope key (a project slug or `global`). */
export function isSessionScopeKey(scope: string): boolean {
  return SCOPE_KEY.test(scope)
}

/**
 * Directory that holds every agent session journal of one scope:
 * `<home>/.specrails/sessions/<scope>/`. Sessions are grouped per project so a
 * project's history can be inspected, backed up or removed as one unit.
 */
export function sessionsRoot(scope: string, home?: string): string {
  if (!isSessionScopeKey(scope)) {
    throw new Error(`Invalid session scope "${scope}": use a project slug (a-z, 0-9, "-") or "${GLOBAL_SESSION_SCOPE}"`)
  }
  return path.join(specrailsHome(home), 'sessions', scope)
}
