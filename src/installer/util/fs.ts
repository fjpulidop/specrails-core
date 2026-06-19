import { Buffer } from 'node:buffer'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { FilesystemError } from './errors.js'

/**
 * `mkdir -p` equivalent. Idempotent — no-op when `dir` already exists.
 * Wraps filesystem errors as {@link FilesystemError} so callers get
 * a typed exit code via the CLI dispatcher.
 */
export function mkdirp(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new FilesystemError(`failed to create directory: ${(err as Error).message}`, dir)
  }
}

/**
 * True when the path exists at all (file, directory, symlink, …).
 */
export function pathExists(p: string): boolean {
  return existsSync(p)
}

/**
 * Writes `contents` to `filePath` after ensuring the parent directory
 * exists and normalising line endings to LF. Normalisation rule:
 * every `\r\n` → `\n`; lone `\r` left alone (very uncommon in our
 * template inputs and more invasive to rewrite). Callers relying on
 * strict LF-only output should pre-clean their strings.
 */
export function writeFileLf(filePath: string, contents: string): void {
  const parent = path.dirname(filePath)
  mkdirp(parent)
  const lf = contents.replace(/\r\n/g, '\n')
  try {
    writeFileSync(filePath, lf, { encoding: 'utf8' })
  } catch (err) {
    throw new FilesystemError(`failed to write file: ${(err as Error).message}`, filePath)
  }
}

/**
 * Reads a UTF-8 text file. Wraps failures as {@link FilesystemError}.
 */
export function readTextFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new FilesystemError(`failed to read file: ${(err as Error).message}`, filePath)
  }
}

/**
 * Reads a file and returns its raw bytes. Used by the manifest hasher
 * to avoid UTF-8 re-encoding round trips.
 */
export function readBytes(filePath: string): Buffer {
  try {
    return readFileSync(filePath)
  } catch (err) {
    throw new FilesystemError(`failed to read file: ${(err as Error).message}`, filePath)
  }
}

/**
 * Copies a single file, ensuring the destination directory exists.
 */
export function copyFile(src: string, dest: string): void {
  mkdirp(path.dirname(dest))
  try {
    cpSync(src, dest)
  } catch (err) {
    throw new FilesystemError(
      `failed to copy ${src} → ${dest}: ${(err as Error).message}`,
      dest,
    )
  }
}

/**
 * Recursively copies a directory. Overwrites existing files by default.
 * Honours a `filter(src, relPath)` predicate — returning false skips
 * the entry (and, if it's a directory, its subtree).
 */
export function copyDir(
  srcDir: string,
  destDir: string,
  options: { filter?: (src: string, relPath: string) => boolean } = {},
): void {
  if (!pathExists(srcDir)) {
    throw new FilesystemError(`source directory does not exist`, srcDir)
  }
  mkdirp(destDir)

  const walk = (currentSrc: string, currentDest: string, relPrefix: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(currentSrc)
    } catch (err) {
      throw new FilesystemError(
        `failed to read directory: ${(err as Error).message}`,
        currentSrc,
      )
    }
    for (const name of entries) {
      const absSrc = path.join(currentSrc, name)
      const absDest = path.join(currentDest, name)
      const relPath = relPrefix === '' ? name : path.join(relPrefix, name)
      if (options.filter && !options.filter(absSrc, relPath)) continue
      const st = statSync(absSrc)
      if (st.isDirectory()) {
        mkdirp(absDest)
        walk(absSrc, absDest, relPath)
      } else if (st.isFile()) {
        copyFile(absSrc, absDest)
      }
      // Other inode types (symlinks, sockets, …) intentionally skipped.
    }
  }
  walk(srcDir, destDir, '')
}

/**
 * Lists the immediate entries (files + directories) of `dir`. Returns
 * absolute paths. Empty array when `dir` does not exist.
 */
export function listDir(dir: string): string[] {
  if (!pathExists(dir)) return []
  try {
    return readdirSync(dir).map((name) => path.join(dir, name))
  } catch (err) {
    throw new FilesystemError(`failed to list directory: ${(err as Error).message}`, dir)
  }
}

/**
 * True when the target path exists and resolves to a regular file.
 */
export function isFile(p: string): boolean {
  if (!pathExists(p)) return false
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * True when the target path exists and resolves to a directory.
 */
export function isDir(p: string): boolean {
  if (!pathExists(p)) return false
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * True when `p` itself is a symbolic link (does NOT follow the link). Used by
 * the bundled-framework assembly to detect (and re-create) the per-workspace
 * provider subtree links. Returns false for a real dir/file or a missing path.
 */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Resolve a path through symlinks to its real on-disk location, falling back to
 * the resolved-but-unreal path when the target does not exist yet (mirrors
 * registry.ts's `realpathSafe`).
 */
export function realpathSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Remove a file, directory, or symlink at `p` if present. For a symlink the
 * link itself is removed (the target is never followed/deleted). Best-effort:
 * a missing path is a no-op. Used before (re-)creating a workspace link.
 */
export function removePath(p: string): void {
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink() || st.isFile()) {
      unlinkSync(p)
    } else {
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  } catch {
    /* nothing there — no-op */
  }
}

/**
 * Ensure `<linkPath>` resolves to `<target>` via a symbolic link, with the same
 * junction→symlink→copy fallback dance specrails-desktop uses for the project
 * link (`workspace-manager.ts ensureProjectLink`).
 *
 *   1. POSIX: a plain `symlinkSync(target, linkPath, type)`.
 *   2. Windows: try a junction (dirs) / file symlink first, then a plain symlink.
 *   3. Both failed (e.g. unprivileged Windows): COPY the target subtree verbatim.
 *
 * When `preferCopy` is true the symlink/junction attempts are SKIPPED entirely
 * and the target is copied directly — used by the in-repo standalone install so
 * the repo receives real, committable files instead of symlinks pointing into
 * `$HOME/.specrails/framework`. (An existing correct symlink at `linkPath` is
 * still honoured idempotently before the copy so a re-run of a relocated install
 * does not thrash.)
 *
 * Returns the mechanism used so the caller can record it (copy-fallback loses the
 * O(1) `current`-swap update path; the caller may warn). Idempotent: when the
 * link already points at `target` it is left untouched and `'symlink'` returned.
 */
export function symlinkOrCopy(
  target: string,
  linkPath: string,
  preferCopy = false,
): 'symlink' | 'junction' | 'copy' {
  const targetIsDir = isDir(target)

  // Idempotency: an existing correct symlink is left alone (even when preferCopy
  // is requested — a relocated workspace that re-runs an in-repo install must not
  // thrash a link it already created correctly).
  if (isSymlink(linkPath)) {
    try {
      const current = readlinkSync(linkPath)
      const resolved = path.isAbsolute(current) ? current : path.resolve(path.dirname(linkPath), current)
      if (realpathSafe(resolved) === realpathSafe(target)) return 'symlink'
    } catch {
      /* unreadable link — fall through to recreate */
    }
  }

  removePath(linkPath)
  mkdirp(path.dirname(linkPath))

  // In-repo install: skip the symlink/junction dance and copy real files.
  if (preferCopy) {
    if (targetIsDir) {
      copyDir(target, linkPath)
    } else {
      copyFile(target, linkPath)
    }
    return 'copy'
  }

  if (process.platform === 'win32') {
    if (targetIsDir) {
      // Directory junctions do NOT require admin/Developer Mode on Windows, so
      // try one. (A failure falls through to copy.)
      try {
        symlinkSync(target, linkPath, 'junction')
        return 'junction'
      } catch {
        /* fall through to copy */
      }
    } else {
      // A FILE symlink on Windows needs admin or Developer Mode and otherwise
      // throws EPERM — noisy and almost always a failure on a user's machine.
      // Skip the symlink attempt entirely and COPY the file directly. (The
      // framework's stale-copy cleanup removes such copied agents on a version
      // swap.) Dir junctions above are unaffected.
      copyFile(target, linkPath)
      return 'copy'
    }
  } else {
    try {
      symlinkSync(target, linkPath, targetIsDir ? 'dir' : 'file')
      return 'symlink'
    } catch {
      /* fall through to copy */
    }
  }

  // Final fallback: copy the subtree (Windows without symlink privilege).
  if (targetIsDir) {
    copyDir(target, linkPath)
  } else {
    copyFile(target, linkPath)
  }
  return 'copy'
}

/**
 * Atomically repoint `<linkPath>` at `<target>`: create a sibling temp link,
 * then `renameSync` over the destination (rename of a symlink is atomic on
 * POSIX; on Windows the temp+rename pattern still avoids a torn intermediate
 * state). Used for the `framework/current` indirection swap.
 */
export function atomicSymlinkSwap(target: string, linkPath: string): void {
  mkdirp(path.dirname(linkPath))
  const tmp = path.join(path.dirname(linkPath), `.${path.basename(linkPath)}.tmp-${process.pid}`)
  removePath(tmp)
  const type = isDir(target) ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'
  try {
    symlinkSync(target, tmp, type)
  } catch {
    // Windows without symlink privilege: fall back to a non-atomic recreate.
    removePath(linkPath)
    symlinkOrCopy(target, linkPath)
    return
  }
  try {
    renameSync(tmp, linkPath)
  } catch {
    removePath(linkPath)
    renameSync(tmp, linkPath)
  }
}
