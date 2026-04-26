import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { FilesystemError } from '../util/errors.js'
import { readBytes, writeFileLf } from '../util/fs.js'

/**
 * Shape of the `.specrails/specrails-manifest.json` file the installer
 * writes at install time. Consumers (specrails-hub's compat check,
 * the `doctor` command, update.sh) parse it to detect template drift.
 */
export interface SpecrailsManifest {
  version: string
  installed_at: string
  artifacts: Record<string, string>
}

/**
 * Computes a stable sha256 digest for a file, returned as `sha256:<hex>`.
 */
export function sha256Of(filePath: string): string {
  const bytes = readBytes(filePath)
  const hash = createHash('sha256').update(bytes).digest('hex')
  return `sha256:${hash}`
}

export interface BuildManifestInput {
  /** Absolute path to the specrails-core source package directory. */
  scriptDir: string
  /** Absolute path to the user's repo root where the manifest is written. */
  repoRoot: string
  /** Version string from the specrails-core VERSION file. */
  version: string
  /** Override "installed_at" — exposed for deterministic testing. */
  installedAt?: string
}

/**
 * Walks `templates/**` plus the two bundled command files and
 * produces a stable-sorted manifest. Replicates the output format of
 * the retired `generate_manifest` bash helper so the byte-diff CI
 * fixture passes without modification.
 *
 * Stable-sort rule: artifact keys are sorted ascending by POSIX path.
 */
export function buildManifest(input: BuildManifestInput): SpecrailsManifest {
  const installed_at = input.installedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  const artifacts: Record<string, string> = {}

  const templatesDir = path.join(input.scriptDir, 'templates')
  walkManifestSources(templatesDir).forEach((absFile) => {
    const rel = path.relative(input.scriptDir, absFile).split(path.sep).join('/')
    artifacts[rel] = sha256Of(absFile)
  })

  const enrichPath = path.join(input.scriptDir, 'commands', 'enrich.md')
  const doctorPath = path.join(input.scriptDir, 'commands', 'doctor.md')
  artifacts['commands/specrails/enrich.md'] = sha256Of(enrichPath)
  artifacts['commands/specrails/doctor.md'] = sha256Of(doctorPath)

  return {
    version: input.version,
    installed_at,
    artifacts: sortKeys(artifacts),
  }
}

/**
 * Writes the manifest JSON and the companion version file under
 * `.specrails/` in the user repo. Both files use LF terminators.
 */
export function writeManifestFiles(
  repoRoot: string,
  manifest: SpecrailsManifest,
): { manifestPath: string; versionPath: string } {
  const manifestPath = path.join(repoRoot, '.specrails', 'specrails-manifest.json')
  const versionPath = path.join(repoRoot, '.specrails', 'specrails-version')
  writeFileLf(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileLf(versionPath, `${manifest.version}\n`)
  return { manifestPath, versionPath }
}

/**
 * Enumerates files under `templates/` excluding `node_modules/` and
 * package-lock files, matching the bash helper's find clause:
 *   find ... -not -path "(star)/node_modules/(star)" -not -name 'package-lock.json'
 */
function walkManifestSources(root: string): string[] {
  const collected: string[] = []
  try {
    walk(root, collected)
  } catch (err) {
    throw new FilesystemError(
      `failed to walk templates directory: ${(err as Error).message}`,
      root,
    )
  }
  // Stable sort on POSIX-normalised relative path ensures deterministic
  // output across operating systems (readdir order is FS-dependent).
  collected.sort()
  return collected
}

function walk(dir: string, acc: string[]): void {
  const entries = readdirSync(dir)
  for (const name of entries) {
    const abs = path.join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (name === 'node_modules') continue
      walk(abs, acc)
    } else if (st.isFile()) {
      if (name === 'package-lock.json') continue
      acc.push(abs)
    }
  }
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of Object.keys(obj).sort()) {
    out[k] = obj[k]!
  }
  return out
}
