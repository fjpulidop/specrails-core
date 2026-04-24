import { Buffer } from 'node:buffer'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
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
