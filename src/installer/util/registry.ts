/**
 * Shared artifact registry — the contract that lets specrails-core place,
 * and specrails-desktop read, a repo's relocated artifacts OUTSIDE the repo,
 * under `$HOME/.specrails/projects/<slug>/workspace`.
 *
 * Single source of truth: `$HOME/.specrails/registry.json`, an inspectable,
 * schema-versioned JSON file keyed by the **canonical realpath of the repo**.
 * specrails-desktop is the primary writer (a projection of its `desktop.sqlite`);
 * specrails-core reads it and, when run standalone, allocates its own entry.
 *
 * Design contract: `docs/internals/global-artifacts-alignment-contract.md`
 * (in the specrails-desktop repo). The slug algorithm, canonical-key rule,
 * atomic-write rule and lock protocol here MUST stay byte-identical to the
 * desktop-side implementation — the correctness of the cross-tool contract
 * depends on both tools resolving the same repo to the same paths.
 *
 * Everything in this module is synchronous to fit the installer's sync flow.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Registry schema version. A reader that sees a higher value MUST treat all
 *  entries as absent (legacy fallback), never mis-parse. */
export const REGISTRY_SCHEMA_VERSION = 1

/** Who owns/allocated an entry. Encodes the single-writer-at-a-time rule. */
export type RegistrySource = 'desktop' | 'core-standalone'

/** One repo's relocated-artifact locations. All paths are absolute and in the
 *  host platform's native separator; consumers treat them as opaque. */
export interface ProjectEntry {
  /** The canonical realpath of the repo (mirror of the map key). */
  repoPath: string
  /** Shared slug — MUST equal desktop.sqlite `projects.slug` for the same repo. */
  slug: string
  /** `$HOME/.specrails/projects/<slug>/workspace` — root of all relocated artifacts. */
  workspaceDir: string
  /** The dir core treats as its `.specrails`/install root instead of repoRoot (= workspaceDir). */
  artifactRoot: string
  /** Always the repo (= repoPath); carries the `openspec/**` + worktree carve-outs. */
  codeRoot: string
  /** Runtime-state base (agent-memory, pipeline-state, …). Injected as SPECRAILS_STATE_DIR. */
  stateDir: string
  /** Absolute path to the relocated local-tickets.json. Injected as SPECRAILS_TICKETS_PATH. */
  ticketsPath: string
  /** Absolute path to backlog-config.json (Jira read-only switch). Injected as SPECRAILS_BACKLOG_CONFIG_PATH. */
  backlogConfigPath: string
  /** Relocated `.specrails/profiles/`. Injected as SPECRAILS_PROFILES_DIR. */
  profilesDir: string
  /** Relocated `.specrails/plugins/` (desktop-only; present for inspectability). */
  pluginsStateDir: string
  /** Relocated `.specrails/file-summaries/` (desktop-only). */
  fileSummariesDir: string
  /** Installed providers; mirror of desktop.sqlite `projects.providers`. */
  providers: string[]
  /** providers[0]; mirror of desktop.sqlite `projects.provider`. */
  primaryProvider: string
  /** The `specrails-version` pin (name/format frozen; only location moved). */
  coreVersion?: string
  createdAt?: string
  lastInstallAt?: string
  /** Single-owner-at-a-time marker; governs reconciliation. */
  source: RegistrySource
  /** desktop.sqlite projects.id when source='desktop', for robust repo-move re-link. */
  desktopProjectId?: string
}

/** On-disk shape of `registry.json`. */
export interface RegistryFile {
  schemaVersion: number
  generator?: string
  updatedAt?: string
  /** Map: canonical-repo-key -> ProjectEntry. */
  projects: Record<string, ProjectEntry>
}

/** The flattened result both tools consume. */
export interface Resolution {
  /** Normalized map key. */
  key: string
  repoPath: string
  slug: string
  workspaceDir: string
  artifactRoot: string
  codeRoot: string
  stateDir: string
  ticketsPath: string
  backlogConfigPath: string
  profilesDir: string
  pluginsStateDir: string
  fileSummariesDir: string
  providers: string[]
  primaryProvider: string
  source: RegistrySource | 'legacy'
  /** True when there is no registry entry and we fell back to the in-repo layout. */
  isLegacy: boolean
}

export interface ResolveOptions {
  /** When true, allocate + persist an entry if none exists. Readers pass false. */
  allocate?: boolean
  /** Who is allocating (only consulted when allocate=true). Default 'core-standalone'. */
  allocator?: RegistrySource
  /** Override `$HOME` (tests). Default `os.homedir()`. */
  home?: string
  /** Providers to record on allocation. Default ['claude']. */
  providers?: string[]
  coreVersion?: string
  desktopProjectId?: string
  /** Override timestamp (tests). */
  now?: string
}

/**
 * Slug derivation — byte-identical to specrails-desktop's `slugify`
 * (`server/desktop-router.ts`). Do not "improve" it; parity is the contract.
 */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** `$HOME` for the registry, overridable for tests. */
export function resolveHome(home?: string): string {
  return home ?? process.env.SPECRAILS_REGISTRY_HOME ?? os.homedir()
}

/** Absolute path to `registry.json`. */
export function registryPath(home?: string): string {
  return path.join(resolveHome(home), '.specrails', 'registry.json')
}

/**
 * Absolute path to the versioned framework store
 * (`<home>/.specrails/framework`). The bundled-framework split materializes the
 * provider-invariant subtree to `<frameworkDir>/<version>/<providerDir>/` once
 * and every workspace symlinks `<frameworkDir>/current/<providerDir>/...`. Shares
 * the SAME home as the registry so framework, registry, and workspaces co-locate
 * (and tests pinning `SPECRAILS_REGISTRY_HOME` redirect all three together).
 */
export function frameworkRoot(home?: string): string {
  return path.join(resolveHome(home), '.specrails', 'framework')
}

/** Absolute path to the advisory lock file. */
export function lockPath(home?: string): string {
  return registryPath(home) + '.lock'
}

/** `fs.realpathSync` that falls back to the resolved-but-unreal path on error
 *  (the path may not exist yet, or be on a volume that rejects realpath). */
export function realpathSafe(abs: string): string {
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** Case-fold the key on case-insensitive platforms (macOS, Windows) so two
 *  spellings of the same path map to one entry. The stored `repoPath` keeps
 *  its canonical case; only the index key is folded. */
export function normalizeKey(canon: string): string {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return canon.toLowerCase()
  }
  return canon
}

/** Canonical repo path: resolve to absolute, then realpath (collapses symlinks). */
export function canonicalizeRepoPath(repoPathInput: string): string {
  return realpathSafe(path.resolve(repoPathInput))
}

/** The per-project sub-path layout under a workspace dir. Single source of the
 *  layout so writer and (allocation) reader never disagree. */
export function workspaceLayout(home: string, slug: string, canon: string): Omit<
  ProjectEntry,
  'providers' | 'primaryProvider' | 'coreVersion' | 'createdAt' | 'lastInstallAt' | 'source' | 'desktopProjectId'
> {
  const workspaceDir = path.join(resolveHome(home), '.specrails', 'projects', slug, 'workspace')
  const specrailsDir = path.join(workspaceDir, '.specrails')
  return {
    repoPath: canon,
    slug,
    workspaceDir,
    artifactRoot: workspaceDir,
    codeRoot: canon,
    stateDir: path.join(workspaceDir, '.claude'),
    ticketsPath: path.join(specrailsDir, 'local-tickets.json'),
    backlogConfigPath: path.join(specrailsDir, 'backlog-config.json'),
    profilesDir: path.join(specrailsDir, 'profiles'),
    pluginsStateDir: path.join(specrailsDir, 'plugins'),
    fileSummariesDir: path.join(specrailsDir, 'file-summaries'),
  }
}

/** The in-repo layout, used when there is no registry entry (legacy fallback). */
export function legacyResolution(canon: string): Resolution {
  const specrailsDir = path.join(canon, '.specrails')
  return {
    key: normalizeKey(canon),
    repoPath: canon,
    slug: '',
    workspaceDir: canon,
    artifactRoot: canon,
    codeRoot: canon,
    stateDir: path.join(canon, '.claude'),
    ticketsPath: path.join(specrailsDir, 'local-tickets.json'),
    backlogConfigPath: path.join(specrailsDir, 'backlog-config.json'),
    profilesDir: path.join(specrailsDir, 'profiles'),
    pluginsStateDir: path.join(specrailsDir, 'plugins'),
    fileSummariesDir: path.join(specrailsDir, 'file-summaries'),
    providers: [],
    primaryProvider: '',
    source: 'legacy',
    isLegacy: true,
  }
}

/** Flatten a stored entry into a Resolution. */
export function entryToResolution(key: string, entry: ProjectEntry): Resolution {
  return {
    key,
    repoPath: entry.repoPath,
    slug: entry.slug,
    workspaceDir: entry.workspaceDir,
    artifactRoot: entry.artifactRoot,
    codeRoot: entry.codeRoot,
    stateDir: entry.stateDir,
    ticketsPath: entry.ticketsPath,
    backlogConfigPath: entry.backlogConfigPath,
    profilesDir: entry.profilesDir,
    pluginsStateDir: entry.pluginsStateDir,
    fileSummariesDir: entry.fileSummariesDir,
    providers: entry.providers,
    primaryProvider: entry.primaryProvider,
    source: entry.source,
    isLegacy: false,
  }
}

/**
 * Total, fail-open read. A missing file, a parse error, or a `schemaVersion`
 * greater than we understand all yield an empty registry, so a caller treats
 * it as "no entry" and (if allocating) writes a fresh, understood entry rather
 * than crashing. Biases toward availability over strict consistency — correct
 * for a local, inspectable file.
 */
export function readRegistryOrEmpty(home?: string): RegistryFile {
  const empty: RegistryFile = { schemaVersion: REGISTRY_SCHEMA_VERSION, projects: {} }
  const p = registryPath(home)
  if (!existsSync(p)) return empty
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as RegistryFile
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.schemaVersion !== 'number' ||
      parsed.schemaVersion > REGISTRY_SCHEMA_VERSION ||
      typeof parsed.projects !== 'object' ||
      parsed.projects === null
    ) {
      return empty
    }
    return parsed
  } catch {
    return empty
  }
}

/** Write `data` to `filePath` atomically: temp file in the same dir, fsync,
 *  rename. A reader (even without the lock) only ever sees a complete old or
 *  new file — the lock serialises writers, the rename protects readers. */
export function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath)
  mkdirSync(dir, { recursive: true })
  // Deterministic-but-unique temp name (no Math.random/Date dependency for the
  // name itself); collisions are impossible because the lock serialises writers.
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`)
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, filePath)
}

/** Synchronous sleep without busy-spinning the CPU. */
function syncSleep(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

const LOCK_STALE_MS = 30_000
const LOCK_SPIN_MS = 50
const LOCK_MAX_WAIT_MS = 2_000

/**
 * Run `fn` while holding an advisory lock over the registry. Mutual exclusion
 * is an exclusive-create lock file (`open(..., 'wx')`) with bounded spin-retry
 * and stale-lock breaking (a lock whose mtime exceeds the TTL is reclaimed —
 * covers a crashed writer). Read-only callers never take the lock.
 */
export function withFileLock<T>(home: string | undefined, fn: () => T): T {
  const lp = lockPath(home)
  mkdirSync(path.dirname(lp), { recursive: true })
  let fd: number | undefined
  // Unique per-acquisition token written INTO the lock file. On release we only
  // unlink the file when the token still matches OURS — so a writer whose lock
  // was stale-broken (TTL-reclaimed) by another writer never deletes the NEW
  // owner's lock out from under it (which would let a third writer acquire
  // concurrently and race the read-modify-write).
  const ourToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      fd = openSync(lp, 'wx')
      try {
        writeFileSync(fd, ourToken)
        fsyncSync(fd)
      } catch {
        /* best-effort — the lock still serialises via exclusive-create */
      }
      break
    } catch {
      // Lock held — break it if stale, otherwise spin until the deadline.
      try {
        const age = Date.now() - statSync(lp).mtimeMs
        if (age > LOCK_STALE_MS) {
          unlinkSync(lp)
          continue
        }
      } catch {
        // lock vanished between open and stat — retry immediately
        continue
      }
      if (Date.now() >= deadline) {
        // FAIL CLOSED: proceeding without the lock would run `fn()` (a
        // read-modify-write of the registry) with NO exclusivity, so a
        // concurrent core+desktop writer can lost-update the registry. Throw
        // instead of silently dropping mutual exclusivity — callers wrap this as
        // non-fatal (the registry update is retried / skipped).
        throw new Error('registry lock acquisition timed out')
      }
      syncSleep(LOCK_SPIN_MS)
    }
  }
  try {
    return fn()
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
      // Only unlink the lock when it still carries OUR token. If we were
      // stale-broken and another writer now owns the file, its token differs and
      // we leave it alone (a missing/unreadable file ⇒ already gone ⇒ no-op).
      try {
        const onDisk = readFileSync(lp, 'utf8')
        if (onDisk === ourToken) {
          unlinkSync(lp)
        }
      } catch {
        /* already removed / unreadable — nothing to clean up */
      }
    }
  }
}

/** Deterministic slug allocation: basename-derived, `-N` dedup suffix. Both
 *  tools implement this identically so they only ever diverge on the suffix,
 *  which read-before-allocate resolves. */
export function allocateSlug(canon: string, existing: ReadonlySet<string>): string {
  let base = slugify(path.basename(canon))
  if (base === '') base = 'project'
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function buildEntry(
  home: string,
  canon: string,
  slug: string,
  opts: ResolveOptions,
): ProjectEntry {
  const providers = opts.providers && opts.providers.length > 0 ? opts.providers : ['claude']
  const now = opts.now ?? new Date().toISOString()
  const layout = workspaceLayout(home, slug, canon)
  const entry: ProjectEntry = {
    ...layout,
    providers,
    primaryProvider: providers[0]!,
    coreVersion: opts.coreVersion,
    createdAt: now,
    lastInstallAt: now,
    source: opts.allocator ?? 'core-standalone',
  }
  if (opts.desktopProjectId) entry.desktopProjectId = opts.desktopProjectId
  return entry
}

/**
 * The shared resolver both tools run. Given a repo path, returns where that
 * repo's artifacts live. With `allocate:true`, creates + persists an entry when
 * none exists (under the lock, with a re-read double-check); readers pass
 * `allocate:false` and fall back to the in-repo legacy layout when absent.
 */
export function resolveArtifacts(repoPathInput: string, opts: ResolveOptions = {}): Resolution {
  const home = opts.home
  const canon = canonicalizeRepoPath(repoPathInput)
  const key = normalizeKey(canon)

  // Fast path: lock-free read for a pure lookup.
  const reg = readRegistryOrEmpty(home)
  const existing = reg.projects[key]
  if (existing) return entryToResolution(key, existing)

  if (!opts.allocate) return legacyResolution(canon)

  // Allocation path: lock, re-read, double-check, atomic write.
  return withFileLock(home, () => {
    const fresh = readRegistryOrEmpty(home)
    const raced = fresh.projects[key]
    if (raced) return entryToResolution(key, raced)

    const existingSlugs = new Set<string>(Object.values(fresh.projects).map((e) => e.slug))
    const slug = allocateSlug(canon, existingSlugs)
    const entry = buildEntry(resolveHome(home), canon, slug, opts)
    fresh.projects[key] = entry
    fresh.schemaVersion = REGISTRY_SCHEMA_VERSION
    fresh.generator = 'specrails-core'
    fresh.updatedAt = opts.now ?? new Date().toISOString()
    atomicWrite(registryPath(home), JSON.stringify(fresh, null, 2) + '\n')
    return entryToResolution(key, entry)
  })
}
