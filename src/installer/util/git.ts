import { GitError } from './errors.js'
import { runCommand } from './exec.js'

/**
 * Low-level git wrapper. Every method shells out to the user's `git`
 * binary (already a prerequisite — the installer refuses to run
 * without a git repo). Failures surface as {@link GitError} so the
 * CLI dispatcher translates them to exit code 30.
 *
 * We intentionally keep the surface minimal (the six operations used
 * by the installer) rather than wrapping `simple-git` — that package
 * is ~100 KB and wraps the same shell-out we do here.
 */

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      inherit: false,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Returns the absolute path of the repository root containing `cwd`.
 * Throws {@link GitError} if `cwd` is not inside a git repo.
 */
export async function repoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await runCommand('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      inherit: false,
    })
    return stdout.trim()
  } catch (err) {
    throw new GitError(
      `not a git repository (or parent directories): ${cwd}`,
      'git rev-parse --show-toplevel',
    )
  }
}

/**
 * Initialises a new git repository at `cwd` with an initial commit on
 * the default branch name. Idempotent — no-op when `cwd` is already
 * a repo.
 */
export async function initRepo(cwd: string): Promise<void> {
  if (await isGitRepo(cwd)) return
  try {
    await runCommand('git', ['init', '--initial-branch=main'], {
      cwd,
      inherit: false,
    })
  } catch (err) {
    // Older git versions (< 2.28) lack --initial-branch. Retry without.
    await runCommand('git', ['init'], { cwd, inherit: false })
  }
}

/**
 * Porcelain working-tree status. Returns the raw short-format output
 * (empty string when the tree is clean).
 */
export async function status(cwd: string): Promise<string> {
  const { stdout } = await runCommand('git', ['status', '--porcelain'], {
    cwd,
    inherit: false,
  })
  return stdout
}

/**
 * Stages the given pathspecs. Empty array stages nothing and returns
 * without invoking git.
 */
export async function add(cwd: string, pathspecs: string[]): Promise<void> {
  if (pathspecs.length === 0) return
  try {
    await runCommand('git', ['add', '--', ...pathspecs], { cwd, inherit: false })
  } catch (err) {
    throw new GitError(
      `failed to stage paths: ${pathspecs.join(', ')}`,
      `git add -- ${pathspecs.join(' ')}`,
    )
  }
}

/**
 * Creates a commit with the given message using the committer identity
 * currently configured on the repo / globally. Does NOT attempt to
 * install an identity — that is a prerequisite check.
 */
export async function commit(
  cwd: string,
  message: string,
  opts: { allowEmpty?: boolean } = {},
): Promise<void> {
  const args = ['commit', '-m', message]
  if (opts.allowEmpty) args.push('--allow-empty')
  try {
    await runCommand('git', args, { cwd, inherit: false })
  } catch (err) {
    throw new GitError(
      `git commit failed: ${(err as Error).message}`,
      `git ${args.join(' ')}`,
    )
  }
}

/**
 * True when git is installed and on PATH.
 */
export async function gitInstalled(): Promise<boolean> {
  try {
    await runCommand('git', ['--version'], { inherit: false })
    return true
  } catch {
    return false
  }
}
