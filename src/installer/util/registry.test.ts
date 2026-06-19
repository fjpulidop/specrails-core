import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  allocateSlug,
  atomicWrite,
  canonicalizeRepoPath,
  entryToResolution,
  frameworkRoot,
  legacyResolution,
  lockPath,
  normalizeKey,
  readRegistryOrEmpty,
  REGISTRY_SCHEMA_VERSION,
  registryPath,
  resolveArtifacts,
  slugify,
  withFileLock,
  workspaceLayout,
  type ProjectEntry,
} from './registry.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'specrails-registry-test-'))
  // The `.specrails` dir is created lazily by the module's writers; tests that
  // pre-plant a registry/lock file directly need it to exist first.
  mkdirSync(path.join(home, '.specrails'), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('slugify (byte-parity with desktop)', () => {
  it('lowercases, collapses non-alphanumerics to dashes, trims edge dashes', () => {
    expect(slugify('Acme API')).toBe('acme-api')
    expect(slugify('My_Project.v2')).toBe('my-project-v2')
    expect(slugify('--Edge--')).toBe('edge')
    expect(slugify('***')).toBe('')
  })
})

describe('frameworkRoot', () => {
  it('lives at <home>/.specrails/framework and shares the registry home', () => {
    expect(frameworkRoot(home)).toBe(path.join(home, '.specrails', 'framework'))
    // Same home → framework, registry, and workspaces co-locate.
    expect(path.dirname(frameworkRoot(home))).toBe(path.dirname(registryPath(home)))
  })
})

describe('canonicalizeRepoPath', () => {
  it('resolves to an absolute realpath, collapsing symlinks', () => {
    const real = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'real-')))
    const link = path.join(home, 'link-to-repo')
    symlinkSync(real, link)
    expect(canonicalizeRepoPath(link)).toBe(real)
    rmSync(real, { recursive: true, force: true })
  })

  it('falls back to the resolved path when realpath throws (non-existent)', () => {
    const ghost = path.join(home, 'does', 'not', 'exist')
    expect(canonicalizeRepoPath(ghost)).toBe(path.resolve(ghost))
  })
})

describe('normalizeKey', () => {
  it('case-folds on darwin/win, identity elsewhere', () => {
    const mixed = '/Users/Javi/Repos/Acme'
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(normalizeKey(mixed)).toBe(mixed.toLowerCase())
    } else {
      expect(normalizeKey(mixed)).toBe(mixed)
    }
  })
})

describe('workspaceLayout', () => {
  it('derives every sub-path under the workspace dir', () => {
    const canon = '/Users/javi/repos/acme'
    const l = workspaceLayout(home, 'acme', canon)
    expect(l.workspaceDir).toBe(path.join(home, '.specrails', 'projects', 'acme', 'workspace'))
    expect(l.artifactRoot).toBe(l.workspaceDir)
    expect(l.codeRoot).toBe(canon)
    expect(l.stateDir).toBe(path.join(l.workspaceDir, '.claude'))
    expect(l.ticketsPath).toBe(path.join(l.workspaceDir, '.specrails', 'local-tickets.json'))
    expect(l.backlogConfigPath).toBe(path.join(l.workspaceDir, '.specrails', 'backlog-config.json'))
    expect(l.profilesDir).toBe(path.join(l.workspaceDir, '.specrails', 'profiles'))
  })
})

describe('legacyResolution', () => {
  it('keeps every artifact in-repo and flags isLegacy', () => {
    const canon = '/Users/javi/repos/acme'
    const r = legacyResolution(canon)
    expect(r.isLegacy).toBe(true)
    expect(r.source).toBe('legacy')
    expect(r.artifactRoot).toBe(canon)
    expect(r.codeRoot).toBe(canon)
    expect(r.ticketsPath).toBe(path.join(canon, '.specrails', 'local-tickets.json'))
  })
})

describe('allocateSlug', () => {
  it('returns the basename slug when free', () => {
    expect(allocateSlug('/a/b/acme-api', new Set())).toBe('acme-api')
  })

  it('appends -N dedup suffixes for same-basename collisions', () => {
    expect(allocateSlug('/a/b/acme', new Set(['acme']))).toBe('acme-2')
    expect(allocateSlug('/a/b/acme', new Set(['acme', 'acme-2']))).toBe('acme-3')
  })

  it('falls back to "project" for an all-symbol basename', () => {
    expect(allocateSlug('/a/b/***', new Set())).toBe('project')
  })
})

describe('readRegistryOrEmpty (fail-open)', () => {
  it('returns empty when the file is missing', () => {
    const reg = readRegistryOrEmpty(home)
    expect(reg.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
    expect(reg.projects).toEqual({})
  })

  it('returns empty on corrupt JSON', () => {
    writeFileSync(registryPath(home), '{ not json', 'utf8')
    expect(readRegistryOrEmpty(home).projects).toEqual({})
  })

  it('returns empty when schemaVersion is newer than understood', () => {
    writeFileSync(
      registryPath(home),
      JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION + 1, projects: { '/x': {} } }),
      'utf8',
    )
    expect(readRegistryOrEmpty(home).projects).toEqual({})
  })

  it('parses a valid registry', () => {
    writeFileSync(
      registryPath(home),
      JSON.stringify({ schemaVersion: 1, projects: { '/x': { slug: 'x' } } }),
      'utf8',
    )
    expect(readRegistryOrEmpty(home).projects['/x']).toBeDefined()
  })
})

describe('atomicWrite', () => {
  it('writes the file and leaves no temp behind', () => {
    const target = path.join(home, 'sub', 'out.json')
    atomicWrite(target, '{"a":1}\n')
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n')
    const leftovers = readdirSync(path.dirname(target)).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })
})

describe('withFileLock', () => {
  it('runs fn and releases the lock', () => {
    const result = withFileLock(home, () => 42)
    expect(result).toBe(42)
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('breaks a stale lock (older than TTL)', () => {
    // Plant a stale lock with an ancient mtime.
    writeFileSync(lockPath(home), '')
    const ancient = Date.now() / 1000 - 120
    utimesSync(lockPath(home), ancient, ancient)
    const result = withFileLock(home, () => 'ran')
    expect(result).toBe('ran')
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('FAILS CLOSED — throws when a fresh lock is held past the deadline (no lost-update)', () => {
    // A FRESH (non-stale) lock that is never released. The acquire spins until
    // the 2s deadline, then must THROW rather than run `fn()` without
    // exclusivity (which would lost-update the registry across core+desktop).
    writeFileSync(lockPath(home), '')
    const now = Date.now() / 1000
    utimesSync(lockPath(home), now, now)
    let ran = false
    expect(() =>
      withFileLock(home, () => {
        ran = true
        return 'should-not-run'
      }),
    ).toThrow(/registry lock acquisition timed out/)
    expect(ran).toBe(false)
    // The held lock is left intact (we did NOT own it, so we must not remove it).
    expect(existsSync(lockPath(home))).toBe(true)
  }, 10_000)

  it('writes a unique token into the lock file while held', () => {
    let tokenWhileHeld = ''
    withFileLock(home, () => {
      tokenWhileHeld = readFileSync(lockPath(home), 'utf8')
    })
    expect(tokenWhileHeld.length).toBeGreaterThan(0)
    expect(tokenWhileHeld).toContain(String(process.pid))
  })

  it('a stale-reclaimed lock carries the NEW owner token and is released by that owner', () => {
    const lp = lockPath(home)
    writeFileSync(lp, 'someone-elses-token')
    const before = readFileSync(lp, 'utf8')
    const ancient = Date.now() / 1000 - 120
    utimesSync(lp, ancient, ancient)
    const result = withFileLock(home, () => {
      expect(readFileSync(lp, 'utf8')).not.toBe(before)
      return 'ran'
    })
    expect(result).toBe('ran')
    expect(existsSync(lp)).toBe(false)
  })
})

describe('entryToResolution', () => {
  it('flattens a stored entry, isLegacy=false', () => {
    const entry: ProjectEntry = {
      repoPath: '/r',
      slug: 's',
      workspaceDir: '/w',
      artifactRoot: '/w',
      codeRoot: '/r',
      stateDir: '/w/.claude',
      ticketsPath: '/w/.specrails/local-tickets.json',
      backlogConfigPath: '/w/.specrails/backlog-config.json',
      profilesDir: '/w/.specrails/profiles',
      pluginsStateDir: '/w/.specrails/plugins',
      fileSummariesDir: '/w/.specrails/file-summaries',
      providers: ['claude'],
      primaryProvider: 'claude',
      source: 'desktop',
    }
    const r = entryToResolution('k', entry)
    expect(r.isLegacy).toBe(false)
    expect(r.source).toBe('desktop')
    expect(r.ticketsPath).toBe('/w/.specrails/local-tickets.json')
  })
})

describe('resolveArtifacts', () => {
  it('reader without an entry falls back to legacy in-repo layout', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repo-')))
    const r = resolveArtifacts(repo, { home, allocate: false })
    expect(r.isLegacy).toBe(true)
    expect(r.artifactRoot).toBe(repo)
    expect(existsSync(registryPath(home))).toBe(false) // reader never writes
    rmSync(repo, { recursive: true, force: true })
  })

  it('allocate creates + persists an entry, with defaults', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acme-')))
    const r = resolveArtifacts(repo, { home, allocate: true, now: '2026-01-01T00:00:00.000Z' })
    expect(r.isLegacy).toBe(false)
    expect(r.source).toBe('core-standalone')
    expect(r.providers).toEqual(['claude'])
    expect(r.primaryProvider).toBe('claude')
    expect(r.artifactRoot).toBe(path.join(home, '.specrails', 'projects', r.slug, 'workspace'))
    const persisted = readRegistryOrEmpty(home)
    expect(persisted.projects[r.key]!.createdAt).toBe('2026-01-01T00:00:00.000Z')
    rmSync(repo, { recursive: true, force: true })
  })

  it('is idempotent: second resolve returns the same slug without re-allocating', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acme-')))
    const first = resolveArtifacts(repo, { home, allocate: true })
    const second = resolveArtifacts(repo, { home, allocate: true })
    const third = resolveArtifacts(repo, { home, allocate: false })
    expect(second.slug).toBe(first.slug)
    expect(third.slug).toBe(first.slug)
    expect(third.isLegacy).toBe(false)
    expect(Object.keys(readRegistryOrEmpty(home).projects)).toHaveLength(1)
    rmSync(repo, { recursive: true, force: true })
  })

  it('two repos with the same basename get distinct slugs', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'multi-'))
    const a = path.join(base, 'a', 'acme')
    const b = path.join(base, 'b', 'acme')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const ra = resolveArtifacts(a, { home, allocate: true })
    const rb = resolveArtifacts(b, { home, allocate: true })
    expect(ra.slug).toBe('acme')
    expect(rb.slug).toBe('acme-2')
    rmSync(base, { recursive: true, force: true })
  })

  it('records the desktop allocator + desktopProjectId', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'desk-')))
    const r = resolveArtifacts(repo, {
      home,
      allocate: true,
      allocator: 'desktop',
      providers: ['claude', 'codex'],
      desktopProjectId: 'uuid-123',
      coreVersion: '4.9.0',
    })
    expect(r.source).toBe('desktop')
    expect(r.providers).toEqual(['claude', 'codex'])
    const entry = readRegistryOrEmpty(home).projects[r.key]!
    expect(entry.desktopProjectId).toBe('uuid-123')
    expect(entry.coreVersion).toBe('4.9.0')
    rmSync(repo, { recursive: true, force: true })
  })
})
