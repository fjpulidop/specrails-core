import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A Windows account WITHOUT SeCreateSymbolicLinkPrivilege, emulated so the
// Linux and macOS jobs carry this guarantee too.
//
// The privilege matters in two places, and only one of them is ours to see:
//   * `cpSync(link, dest, { dereference: false, verbatimSymlinks: true })` does
//     not copy a link, it RECREATES it — inside Node, where no test stub can
//     reach. Backing up a link is therefore a PRIVILEGED operation, which is
//     what broke every Windows install in 5.1.0. The mock below makes that
//     contract explicit: copying a link throws EPERM.
//   * `symlinkSync` with a 'file'/'dir' type throws EPERM; a 'junction' does not.
//
// GitHub's Windows runners are administrators, so a test that relies on the host
// to deny the privilege can never observe this failure. This one does not.
const EPERM = (syscall: string): NodeJS.ErrnoException => {
  const error = new Error(`EPERM: operation not permitted, ${syscall}`) as NodeJS.ErrnoException
  error.code = 'EPERM'
  return error
}

let denySymlinks = false

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const containsLink = (target: string): boolean => {
    const stat = actual.lstatSync(target)
    if (stat.isSymbolicLink()) return true
    if (!stat.isDirectory()) return false
    return actual.readdirSync(target).some((name) => containsLink(path.join(target, name)))
  }
  const cpSync: typeof actual.cpSync = (src, dest, options) => {
    if (typeof src === 'string' && actual.existsSync(src) && containsLink(src)) throw EPERM('symlink')
    return actual.cpSync(src, dest, options)
  }
  const symlinkSync: typeof actual.symlinkSync = (target, linkPath, type) => {
    if (denySymlinks) throw EPERM('symlink')
    if (type !== 'junction') throw EPERM('symlink')
    // A junction is the unprivileged mechanism on Windows; POSIX has no such
    // type, so honour it as an ordinary directory link.
    return actual.symlinkSync(target, linkPath, 'dir')
  }
  return { ...actual, default: { ...actual, cpSync, symlinkSync }, cpSync, symlinkSync }
})

const { withInstallRollback } = await import('./install-transaction.js')

let root: string
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  denySymlinks = false
  root = mkdtempSync(path.join(os.tmpdir(), 'core-transaction-'))
  // The installer picks its link mechanism off `process.platform`: only the
  // win32 branch reaches for a junction, which is the one mechanism an
  // unprivileged Windows account is allowed. Emulating the platform is what
  // makes this suite exercise the real Windows path from any host.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** `<root>/framework/{5.0.0,current→5.0.0}` — the shape every install snapshots. */
function framework(): { dir: string; current: string; oldVersion: string; newVersion: string } {
  const dir = path.join(root, 'framework')
  const oldVersion = path.join(dir, '5.0.0')
  const newVersion = path.join(dir, '5.1.0')
  mkdirSync(oldVersion, { recursive: true })
  writeFileSync(path.join(oldVersion, 'agent.md'), 'v5.0.0')
  const current = path.join(dir, 'current')
  symlinkSync(oldVersion, current, 'junction')
  return { dir, current, oldVersion, newVersion }
}

describe('withInstallRollback without symlink privilege', () => {
  it('snapshots a linked surface instead of recreating the link', async () => {
    const { current, oldVersion } = framework()

    await expect(withInstallRollback([current], async () => {
      throw new Error('install failed')
    })).rejects.toThrow('install failed')

    // The install's own error surfaces — not an EPERM from the backup phase.
    expect(lstatSync(current).isSymbolicLink()).toBe(true)
    expect(readlinkSync(current)).toBe(oldVersion)
  })

  it('restores the pointer to its original target after a failed install', async () => {
    const { current, oldVersion, newVersion } = framework()

    await expect(withInstallRollback([current], async () => {
      mkdirSync(newVersion)
      rmSync(current)
      symlinkSync(newVersion, current, 'junction')
      throw new Error('install failed')
    })).rejects.toThrow('install failed')

    expect(readlinkSync(current)).toBe(oldVersion)
  })

  it('snapshots a surface whose CHILD is a link', async () => {
    const workspace = path.join(root, 'workspace', '.claude')
    const shared = path.join(root, 'shared-commands')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(shared)
    writeFileSync(path.join(shared, 'implement.md'), 'shared')
    writeFileSync(path.join(workspace, 'settings.json'), '{"a":1}')
    symlinkSync(shared, path.join(workspace, 'commands'), 'junction')

    await expect(withInstallRollback([workspace], async () => {
      writeFileSync(path.join(workspace, 'settings.json'), '{"a":2}')
      throw new Error('install failed')
    })).rejects.toThrow('install failed')

    expect(readFileSync(path.join(workspace, 'settings.json'), 'utf8')).toBe('{"a":1}')
    expect(lstatSync(path.join(workspace, 'commands')).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(workspace, 'commands', 'implement.md'), 'utf8')).toBe('shared')
  })

  it('falls back to restoring contents when no link mechanism is available', async () => {
    const { current, oldVersion } = framework()
    denySymlinks = true

    await expect(withInstallRollback([current], async () => {
      rmSync(current)
      throw new Error('install failed')
    })).rejects.toThrow('install failed')

    // The rollback succeeds — the surface is back with the right contents even
    // though this machine can create no link at all.
    expect(existsSync(current)).toBe(true)
    expect(readFileSync(path.join(current, 'agent.md'), 'utf8')).toBe('v5.0.0')
    expect(readFileSync(path.join(oldVersion, 'agent.md'), 'utf8')).toBe('v5.0.0')
  })

  it('preserves a reserved file created while the install was running', async () => {
    const workspace = path.join(root, 'workspace')
    const reserved = path.join(workspace, '.specrails', 'profiles')
    mkdirSync(path.join(workspace, '.specrails'), { recursive: true })
    writeFileSync(path.join(workspace, '.specrails', 'specrails-version'), '5.0.0')

    await expect(withInstallRollback([path.join(workspace, '.specrails')], async () => {
      mkdirSync(reserved, { recursive: true })
      writeFileSync(path.join(reserved, 'project-default.json'), '{"kept":true}')
      throw new Error('install failed')
    })).rejects.toThrow('install failed')

    expect(readFileSync(path.join(reserved, 'project-default.json'), 'utf8')).toBe('{"kept":true}')
  })
})

describe('the versioned framework store is not copied', () => {
  it('protects the exact surface list `init` passes (the reported Windows failure)', async () => {
    // Verbatim shape of the crash reported from an unprivileged Windows box:
    //
    //   EPERM: operation not permitted, symlink
    //     'C:\\Users\\<user>\\.specrails\\framework\\5.1.0'
    //     -> 'C:\\Users\\<user>\\AppData\\Local\\Temp\\specrails-update-backup-XXXXXX\\11'
    //       at onLink (node:internal/fs/cp/cp-sync:195:12)
    //       at withInstallRollback (install-transaction.js:152:17)
    //
    // Index 11 is `<frameworkDir>/current` — the twelfth surface — on a fresh
    // workspace where the eleven before it do not exist yet.
    const { dir, current, oldVersion, newVersion } = framework()
    const workspace = path.join(root, 'workspace')
    mkdirSync(path.join(workspace, '.specrails'), { recursive: true })
    const surfaces = [
      ...['.claude', '.codex', '.gemini', '.kimi-code', 'AGENTS.md', 'GEMINI.md', '.gitignore']
        .map((name) => path.join(workspace, name)),
      ...['specrails-version', 'specrails-manifest.json', 'setup-templates', 'runtime']
        .map((name) => path.join(workspace, '.specrails', name)),
      current,
      { path: newVersion, snapshotContents: false },
    ]

    await expect(withInstallRollback(surfaces, async () => {
      mkdirSync(newVersion)
      throw new Error('install failed')
    })).rejects.toThrow('install failed')

    expect(readlinkSync(current)).toBe(oldVersion)
    expect(existsSync(newVersion)).toBe(false)
    expect(existsSync(path.join(dir, '5.0.0', 'agent.md'))).toBe(true)
  })


  it('leaves a pre-existing version directory untouched and makes no copy of it', async () => {
    const { dir, oldVersion } = framework()
    writeFileSync(path.join(oldVersion, 'extra.md'), 'added by a sibling install')

    await expect(withInstallRollback(
      [path.join(dir, 'current'), { path: oldVersion, snapshotContents: false }],
      async () => { throw new Error('install failed') },
    )).rejects.toThrow('install failed')

    expect(readFileSync(path.join(oldVersion, 'extra.md'), 'utf8')).toBe('added by a sibling install')
    expect(readFileSync(path.join(oldVersion, 'agent.md'), 'utf8')).toBe('v5.0.0')
  })

  it('still removes a version directory the failed install created', async () => {
    const { dir, newVersion } = framework()

    await expect(withInstallRollback(
      [path.join(dir, 'current'), { path: newVersion, snapshotContents: false }],
      async () => {
        mkdirSync(newVersion)
        writeFileSync(path.join(newVersion, 'agent.md'), 'v5.1.0')
        throw new Error('install failed')
      },
    )).rejects.toThrow('install failed')

    expect(existsSync(newVersion)).toBe(false)
  })
})
