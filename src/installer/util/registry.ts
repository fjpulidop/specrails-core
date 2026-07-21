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
  lstatSync,
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

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'kimi'])
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REQUIRED_ENTRY_PATHS = [
  'workspaceDir',
  'artifactRoot',
  'stateDir',
  'ticketsPath',
  'backlogConfigPath',
  'profilesDir',
  'pluginsStateDir',
  'fileSummariesDir',
] as const satisfies ReadonlyArray<keyof ProjectEntry>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value)
}

function isSupportedProvider(value: unknown): boolean {
  return typeof value === 'string' && SUPPORTED_PROVIDERS.has(value)
}

function samePath(left: string, right: string): boolean {
  return normalizeKey(path.resolve(left)) === normalizeKey(path.resolve(right))
}

function isPathContained(root: string, candidate: string, allowRoot = true): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '') return allowRoot
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/**
 * Resolve every existing prefix while retaining a not-yet-created suffix.
 * Unlike `realpathSafe`, a dangling symlink or an existing non-directory parent
 * is invalid: treating either lexically would hide a later filesystem escape.
 */
function resolveForContainment(candidate: string): string | undefined {
  let cursor = path.resolve(candidate)
  const missingSuffix: string[] = []
  for (;;) {
    try {
      const metadata = lstatSync(cursor)
      if (missingSuffix.length > 0) {
        let followed
        try {
          followed = statSync(cursor)
        } catch {
          return undefined
        }
        if (!followed.isDirectory()) return undefined
      } else if (!metadata.isFile() && !metadata.isDirectory() && !metadata.isSymbolicLink()) {
        return undefined
      }
      let realPrefix: string
      try {
        realPrefix = realpathSync(cursor)
      } catch {
        return undefined
      }
      return path.resolve(realPrefix, ...missingSuffix)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined
      const parent = path.dirname(cursor)
      if (parent === cursor) return undefined
      missingSuffix.unshift(path.basename(cursor))
      cursor = parent
    }
  }
}

function hasValidProviderSet(entry: Record<string, unknown>): boolean {
  if (!Array.isArray(entry.providers) || entry.providers.length === 0) return false
  if (!entry.providers.every(isSupportedProvider)) return false
  if (new Set(entry.providers).size !== entry.providers.length) return false
  return (
    isSupportedProvider(entry.primaryProvider) &&
    entry.primaryProvider === entry.providers[0]
  )
}

/**
 * Validate one untrusted registry row before it can influence resolution or a
 * subsequent read-modify-write. The registry stores derived subpaths
 * explicitly so Desktop's layout remains authoritative; Core only requires
 * that those opaque paths stay lexically and physically inside the immutable
 * per-slug workspace.
 */
function isValidProjectEntry(
  key: string,
  value: unknown,
  home: string | undefined,
): value is ProjectEntry {
  if (!isRecord(value)) return false
  if (
    !isNonEmptyString(value.repoPath) ||
    !path.isAbsolute(value.repoPath) ||
    !isNonEmptyString(value.codeRoot) ||
    !path.isAbsolute(value.codeRoot) ||
    !isNonEmptyString(value.slug) ||
    !SAFE_SLUG.test(value.slug) ||
    (value.source !== 'desktop' && value.source !== 'core-standalone') ||
    !hasValidProviderSet(value) ||
    !isOptionalString(value.coreVersion) ||
    !isOptionalString(value.createdAt) ||
    !isOptionalString(value.lastInstallAt) ||
    !isOptionalString(value.desktopProjectId) ||
    !isOptionalString(value.updatedAt)
  ) {
    return false
  }

  for (const field of REQUIRED_ENTRY_PATHS) {
    const candidate = value[field]
    if (!isNonEmptyString(candidate) || !path.isAbsolute(candidate)) return false
  }
  const validatedPaths = value as Record<
    (typeof REQUIRED_ENTRY_PATHS)[number],
    string
  >

  const canonicalRepo = canonicalizeRepoPath(value.repoPath)
  if (
    !samePath(value.repoPath, canonicalRepo) ||
    normalizeKey(canonicalRepo) !== key ||
    !samePath(value.codeRoot, canonicalRepo) ||
    !samePath(value.codeRoot, canonicalizeRepoPath(value.codeRoot))
  ) {
    return false
  }

  const lexicalHome = path.resolve(resolveHome(home))
  const lexicalSpecrailsRoot = path.join(lexicalHome, '.specrails')
  const lexicalProjectsRoot = path.join(lexicalSpecrailsRoot, 'projects')
  const lexicalWorkspace = path.join(
    lexicalProjectsRoot,
    value.slug,
    'workspace',
  )
  if (
    !samePath(validatedPaths.workspaceDir, lexicalWorkspace) ||
    !samePath(validatedPaths.artifactRoot, lexicalWorkspace)
  ) {
    return false
  }

  const realHome = resolveForContainment(lexicalHome)
  const realSpecrailsRoot = resolveForContainment(lexicalSpecrailsRoot)
  const realProjectsRoot = resolveForContainment(lexicalProjectsRoot)
  const realWorkspace = resolveForContainment(lexicalWorkspace)
  if (
    realHome === undefined ||
    realSpecrailsRoot === undefined ||
    realProjectsRoot === undefined ||
    realWorkspace === undefined ||
    !isPathContained(realHome, realSpecrailsRoot, false) ||
    !samePath(realProjectsRoot, path.join(realSpecrailsRoot, 'projects')) ||
    !samePath(
      realWorkspace,
      path.join(realProjectsRoot, value.slug, 'workspace'),
    )
  ) {
    return false
  }

  for (const field of REQUIRED_ENTRY_PATHS) {
    const candidate = validatedPaths[field]
    const realCandidate = resolveForContainment(candidate)
    if (
      !isPathContained(lexicalWorkspace, candidate) ||
      realCandidate === undefined ||
      !isPathContained(realWorkspace, realCandidate)
    ) {
      return false
    }
  }
  return true
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
export function workspaceLayout(
  home: string,
  slug: string,
  canon: string,
  primaryProvider: string = 'claude',
): Omit<
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
    stateDir: path.join(workspaceDir, providerStateDirectory(primaryProvider)),
    ticketsPath: path.join(specrailsDir, 'local-tickets.json'),
    backlogConfigPath: path.join(specrailsDir, 'backlog-config.json'),
    profilesDir: path.join(specrailsDir, 'profiles'),
    pluginsStateDir: path.join(specrailsDir, 'plugins'),
    fileSummariesDir: path.join(specrailsDir, 'file-summaries'),
  }
}

function providerStateDirectory(provider: string): string {
  if (provider === 'codex') return '.codex'
  if (provider === 'gemini') return '.gemini'
  if (provider === 'kimi') return '.kimi-code'
  return '.claude'
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
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
      !isRecord(parsed.projects)
    ) {
      return empty
    }

    const candidates: Array<[string, ProjectEntry]> = []
    const slugCounts = new Map<string, number>()
    for (const [key, entry] of Object.entries(parsed.projects)) {
      if (!isValidProjectEntry(key, entry, home)) continue
      candidates.push([key, entry])
      slugCounts.set(entry.slug, (slugCounts.get(entry.slug) ?? 0) + 1)
    }

    const projects: Record<string, ProjectEntry> = {}
    for (const [key, entry] of candidates) {
      // Two repos must never resolve to the same writable workspace. Treat
      // every side of an ambiguous slug as absent instead of choosing a winner.
      if (slugCounts.get(entry.slug) === 1) projects[key] = entry
    }

    const result: RegistryFile = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      projects,
    }
    if (typeof parsed.generator === 'string') result.generator = parsed.generator
    if (typeof parsed.updatedAt === 'string') result.updatedAt = parsed.updatedAt
    return result
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
  const providers = validateProvidersForWrite(opts.providers, true)
  const now = opts.now ?? new Date().toISOString()
  const layout = workspaceLayout(home, slug, canon, providers[0])
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

function validateProvidersForWrite(
  providers: string[] | undefined,
  useDefault: boolean,
): string[] {
  if (providers === undefined || providers.length === 0) {
    return useDefault ? ['claude'] : []
  }
  if (!providers.every(isSupportedProvider)) {
    throw new Error(
      `Unsupported registry provider: ${providers.find((provider) => !isSupportedProvider(provider)) ?? ''}`,
    )
  }
  return [...new Set(providers)]
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
  const requestedProviders = validateProvidersForWrite(opts.providers, false)

  // Fast path: lock-free read for a pure lookup.
  const reg = readRegistryOrEmpty(home)
  const existing = reg.projects[key]
  if (existing) {
    const needsProviderMerge =
      opts.allocate === true &&
      existing.source === 'core-standalone' &&
      requestedProviders.some((provider) => !existing.providers.includes(provider))
    if (!needsProviderMerge) return entryToResolution(key, existing)
    return withFileLock(home, () => {
      const fresh = readRegistryOrEmpty(home)
      const current = fresh.projects[key]
      if (!current) return legacyResolution(canon)
      const providers = [...new Set([...current.providers, ...requestedProviders])]
      current.providers = providers
      current.primaryProvider = current.primaryProvider || providers[0] || 'claude'
      current.lastInstallAt = opts.now ?? new Date().toISOString()
      if (opts.coreVersion) current.coreVersion = opts.coreVersion
      fresh.updatedAt = current.lastInstallAt
      atomicWrite(registryPath(home), JSON.stringify(fresh, null, 2) + '\n')
      return entryToResolution(key, current)
    })
  }

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
