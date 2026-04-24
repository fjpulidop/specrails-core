import path from 'node:path'

/**
 * Paths the installer MUST NOT create, modify, or delete. These hold
 * user / team state that survives re-runs (profile JSON authored by
 * specrails-hub, custom agents authored by the user). Breaking this
 * contract silently destroys user work.
 *
 * Audited by vitest spec `reserved-paths.test.ts`.
 */
export const RESERVED_PATHS = [
  /**
   * .specrails/profiles/** — project + hub-authored profile JSON.
   * specrails-hub writes profile files here and expects them preserved
   * across specrails-core updates.
   */
  '.specrails/profiles/',

  /**
   * .claude/agents/custom-*.md — user-authored custom agents, kept
   * distinct from the bundled sr-* agents so updates never overwrite
   * them.
   */
  '.claude/agents/custom-',
] as const

/**
 * Returns true when a repo-relative path falls inside a reserved
 * region. Accepts both POSIX (/) and Windows (\) separators; the
 * check normalises internally so callers can pass a value straight
 * from `path.relative()` without worrying about host platform.
 */
export function isReservedPath(relPath: string): boolean {
  const normalised = relPath.replace(/\\/g, '/')
  for (const prefix of RESERVED_PATHS) {
    if (normalised.startsWith(prefix)) return true
  }
  return false
}

/**
 * Joins segments and forces POSIX separators. Use when a generated
 * string is destined for a cross-platform artefact (JSON manifest,
 * YAML config) rather than the local filesystem.
 */
export function toPosix(...segments: string[]): string {
  return path.posix.join(...segments.map((s) => s.replace(/\\/g, '/')))
}

/**
 * Joins segments using the host platform's separator. Use when the
 * result goes directly to `fs.*` / `child_process.*` calls.
 */
export function toNative(...segments: string[]): string {
  return path.join(...segments)
}

/**
 * Repository-relative representation of an absolute path. Returns a
 * POSIX-style path so callers can store it in manifests without OS
 * contamination. If `absPath` is outside `repoRoot`, returns the
 * original absolute path unchanged (POSIX-normalised).
 */
export function repoRelative(repoRoot: string, absPath: string): string {
  const rel = path.relative(repoRoot, absPath)
  if (rel.startsWith('..')) {
    return absPath.replace(/\\/g, '/')
  }
  return rel.replace(/\\/g, '/')
}
