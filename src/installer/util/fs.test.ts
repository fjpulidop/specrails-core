import { linkSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { lstatSync, realpathSync } from 'node:fs'

import { FilesystemError } from './errors.js'
import {
  atomicSymlinkSwap,
  copyDir,
  copyFile,
  restoreTree,
  snapshotTree,
  isDir,
  isFile,
  isSymlink,
  listDir,
  mkdirp,
  pathExists,
  readTextFile,
  realpathSafe,
  removePath,
  symlinkOrCopy,
  writeFileLf,
} from './fs.js'

describe('fs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-fs-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  describe('mkdirp', () => {
    it('creates nested directories idempotently', () => {
      const target = path.join(tmpDir, 'a', 'b', 'c')
      mkdirp(target)
      expect(isDir(target)).toBe(true)
      // Second call must not throw.
      mkdirp(target)
      expect(isDir(target)).toBe(true)
    })
  })

  describe('writeFileLf', () => {
    it('writes LF-terminated content, converting CRLF on the way in', () => {
      const p = path.join(tmpDir, 'nested', 'a.txt')
      writeFileLf(p, 'line1\r\nline2\r\n')
      expect(readTextFile(p)).toBe('line1\nline2\n')
    })

    it('creates parent directories as needed', () => {
      const p = path.join(tmpDir, 'deep', 'chain', 'leaf.txt')
      writeFileLf(p, 'hello')
      expect(isFile(p)).toBe(true)
    })
  })

  describe('readTextFile', () => {
    it('throws FilesystemError on missing file', () => {
      expect(() => readTextFile(path.join(tmpDir, 'nope.txt'))).toThrow(FilesystemError)
    })
  })

  describe('copyFile', () => {
    it('replaces a linked destination without mutating its referent or deleting it on copy failure', () => {
      const src = path.join(tmpDir, 'Origen español', 'source.md')
      const referent = path.join(tmpDir, 'Shared instructions.md')
      const dest = path.join(tmpDir, 'José User Home', '契約.md')
      writeFileLf(src, 'new project instructions')
      writeFileLf(referent, 'shared instructions remain untouched')
      mkdirp(path.dirname(dest))
      linkSync(referent, dest)
      copyFile(src, dest)
      expect(readTextFile(dest)).toBe('new project instructions')
      expect(readTextFile(referent)).toBe('shared instructions remain untouched')
      expect(() => copyFile(path.join(tmpDir, 'missing.md'), dest)).toThrow(FilesystemError)
      expect(readTextFile(dest)).toBe('new project instructions')
      expect(readdirSync(path.dirname(dest))).toEqual(['契約.md'])
    })

    it('overwrites existing Unicode files during repeated file and directory copies', () => {
      const src = path.join(tmpDir, 'Origen español', '契約.md')
      const dest = path.join(tmpDir, 'José User Home', 'Guía', '契約.md')
      writeFileLf(src, 'first source bytes')
      writeFileLf(dest, 'existing destination bytes')
      copyFile(src, dest)
      expect(readTextFile(dest)).toBe('first source bytes')
      writeFileLf(src, 'replacement source bytes')
      copyFile(src, dest)
      expect(readTextFile(dest)).toBe('replacement source bytes')
      writeFileLf(src, 'directory overlay bytes')
      copyDir(path.dirname(src), path.dirname(dest))
      expect(readTextFile(dest)).toBe('directory overlay bytes')
    })

    it('copies a single file into a new directory tree', () => {
      const src = path.join(tmpDir, 'src.txt')
      const dest = path.join(tmpDir, 'out', 'dest.txt')
      writeFileLf(src, 'payload')
      copyFile(src, dest)
      expect(readTextFile(dest)).toBe('payload')
    })
  })

  describe('copyDir', () => {
    it('recursively copies all regular files', () => {
      writeFileLf(path.join(tmpDir, 'src', 'a.txt'), 'A')
      writeFileLf(path.join(tmpDir, 'src', 'nested', 'b.txt'), 'B')
      copyDir(path.join(tmpDir, 'src'), path.join(tmpDir, 'dest'))
      expect(readTextFile(path.join(tmpDir, 'dest', 'a.txt'))).toBe('A')
      expect(readTextFile(path.join(tmpDir, 'dest', 'nested', 'b.txt'))).toBe('B')
    })

    it('honours a filter predicate', () => {
      writeFileLf(path.join(tmpDir, 'src', 'keep.txt'), 'keep')
      writeFileLf(path.join(tmpDir, 'src', 'skip.txt'), 'skip')
      copyDir(path.join(tmpDir, 'src'), path.join(tmpDir, 'dest'), {
        filter: (_src, rel) => !rel.endsWith('skip.txt'),
      })
      expect(pathExists(path.join(tmpDir, 'dest', 'keep.txt'))).toBe(true)
      expect(pathExists(path.join(tmpDir, 'dest', 'skip.txt'))).toBe(false)
    })

    it('throws FilesystemError when source does not exist', () => {
      expect(() =>
        copyDir(path.join(tmpDir, 'missing'), path.join(tmpDir, 'dest')),
      ).toThrow(FilesystemError)
    })
  })

  describe('listDir', () => {
    it('returns an empty array when directory is absent', () => {
      expect(listDir(path.join(tmpDir, 'nope'))).toEqual([])
    })

    it('returns absolute paths of immediate children', () => {
      writeFileLf(path.join(tmpDir, 'child', 'one.txt'), '1')
      writeFileLf(path.join(tmpDir, 'child', 'two.txt'), '2')
      const entries = listDir(path.join(tmpDir, 'child')).sort()
      expect(entries).toEqual([
        path.join(tmpDir, 'child', 'one.txt'),
        path.join(tmpDir, 'child', 'two.txt'),
      ])
    })
  })

  describe('isFile / isDir', () => {
    it('distinguishes files from directories', () => {
      const f = path.join(tmpDir, 'a.txt')
      const d = path.join(tmpDir, 'adir')
      writeFileLf(f, 'x')
      mkdirp(d)
      expect(isFile(f)).toBe(true)
      expect(isDir(f)).toBe(false)
      expect(isFile(d)).toBe(false)
      expect(isDir(d)).toBe(true)
    })

    it('returns false for nonexistent paths', () => {
      expect(isFile(path.join(tmpDir, 'ghost'))).toBe(false)
      expect(isDir(path.join(tmpDir, 'ghost'))).toBe(false)
    })
  })

  describe('symlinkOrCopy / isSymlink', () => {
    it('symlinks a directory and reports it as a symlink', () => {
      const target = path.join(tmpDir, 'tgt')
      writeFileLf(path.join(target, 'a.txt'), 'A')
      const link = path.join(tmpDir, 'link')
      const mech = symlinkOrCopy(target, link)
      // POSIX → symlink; Windows may junction. Either way the content resolves.
      expect(['symlink', 'junction']).toContain(mech)
      expect(isSymlink(link)).toBe(true)
      expect(readTextFile(path.join(link, 'a.txt'))).toBe('A')
      expect(realpathSync(link)).toBe(realpathSync(target))
    })

    it('symlinks a single file (copies on Windows where file-symlinks need admin)', () => {
      const target = path.join(tmpDir, 'file.txt')
      writeFileLf(target, 'payload')
      const link = path.join(tmpDir, 'sub', 'file-link.txt')
      const mech = symlinkOrCopy(target, link)
      // POSIX → symlink; Windows → copy (file-symlinks require admin / Dev-Mode).
      expect(['symlink', 'copy']).toContain(mech)
      if (process.platform !== 'win32') {
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
      }
      expect(readTextFile(link)).toBe('payload')
    })

    it('is idempotent — a correct existing symlink is left untouched', () => {
      const target = path.join(tmpDir, 'tgt')
      mkdirp(target)
      const link = path.join(tmpDir, 'link')
      symlinkOrCopy(target, link)
      expect(symlinkOrCopy(target, link)).toBe('symlink')
      expect(isSymlink(link)).toBe(true)
    })

    it('replaces a stale link pointing elsewhere', () => {
      const a = path.join(tmpDir, 'a')
      const b = path.join(tmpDir, 'b')
      writeFileLf(path.join(a, 'x.txt'), 'A')
      writeFileLf(path.join(b, 'x.txt'), 'B')
      const link = path.join(tmpDir, 'link')
      symlinkOrCopy(a, link)
      symlinkOrCopy(b, link)
      expect(readTextFile(path.join(link, 'x.txt'))).toBe('B')
    })

    it('replaces a pre-existing real directory at the link path', () => {
      const target = path.join(tmpDir, 'tgt')
      writeFileLf(path.join(target, 'a.txt'), 'A')
      const link = path.join(tmpDir, 'link')
      writeFileLf(path.join(link, 'stale.txt'), 'stale')
      symlinkOrCopy(target, link)
      expect(isSymlink(link)).toBe(true)
      expect(pathExists(path.join(link, 'a.txt'))).toBe(true)
    })
  })

  describe('removePath', () => {
    it('removes a file, a directory, and is a no-op on a missing path', () => {
      const f = path.join(tmpDir, 'f.txt')
      const d = path.join(tmpDir, 'd')
      writeFileLf(f, 'x')
      writeFileLf(path.join(d, 'nested.txt'), 'y')
      removePath(f)
      removePath(d)
      removePath(path.join(tmpDir, 'ghost')) // no throw
      expect(pathExists(f)).toBe(false)
      expect(pathExists(d)).toBe(false)
    })

    it('removes a symlink without following it to the target', () => {
      const target = path.join(tmpDir, 'tgt')
      writeFileLf(path.join(target, 'keep.txt'), 'KEEP')
      const link = path.join(tmpDir, 'link')
      symlinkOrCopy(target, link)
      removePath(link)
      expect(pathExists(link)).toBe(false)
      // The target survives — the link removal did not cascade.
      expect(readTextFile(path.join(target, 'keep.txt'))).toBe('KEEP')
    })
  })

  describe('realpathSafe', () => {
    it('resolves an existing path through symlinks', () => {
      const target = path.join(tmpDir, 'tgt')
      mkdirp(target)
      const link = path.join(tmpDir, 'link')
      symlinkOrCopy(target, link)
      expect(realpathSafe(link)).toBe(realpathSync(target))
    })

    it('falls back to the resolved-but-unreal path when the target is absent', () => {
      const missing = path.join(tmpDir, 'no', 'such')
      expect(realpathSafe(missing)).toBe(path.resolve(missing))
    })
  })

  describe('atomicSymlinkSwap', () => {
    it('creates then atomically repoints a link to a new target', () => {
      const v1 = path.join(tmpDir, 'v1')
      const v2 = path.join(tmpDir, 'v2')
      writeFileLf(path.join(v1, 'm.txt'), '1')
      writeFileLf(path.join(v2, 'm.txt'), '2')
      const current = path.join(tmpDir, 'current')

      atomicSymlinkSwap(v1, current)
      expect(readTextFile(path.join(current, 'm.txt'))).toBe('1')
      expect(realpathSync(current)).toBe(realpathSync(v1))

      atomicSymlinkSwap(v2, current)
      expect(readTextFile(path.join(current, 'm.txt'))).toBe('2')
      expect(realpathSync(current)).toBe(realpathSync(v2))
      // No leftover temp link.
      expect(pathExists(path.join(tmpDir, `.current.tmp-${process.pid}`))).toBe(false)
    })
  })
  describe('snapshotTree / restoreTree', () => {
    it('records a link by target instead of creating one', () => {
      const target = path.join(tmpDir, 'versioned')
      mkdirp(target)
      writeFileLf(path.join(target, 'agent.md'), 'body')
      const link = path.join(tmpDir, 'current')
      symlinkOrCopy(target, link)

      const backup = path.join(tmpDir, 'backup')
      const records = snapshotTree(link, backup)

      // `readlinkSync` reports a junction's target in the namespaced `\\?\C:\…`
      // form on some Windows/Node combinations, so compare where it RESOLVES
      // rather than how it is spelled.
      expect(records.map((record) => record.rel)).toEqual([''])
      expect(realpathSync(records[0]!.target)).toBe(realpathSync(target))
      // Nothing at all is written for a link — the record IS the backup.
      expect(pathExists(backup)).toBe(false)
    })

    it('records nested links and copies the regular files around them', () => {
      const shared = path.join(tmpDir, 'shared')
      mkdirp(shared)
      writeFileLf(path.join(shared, 'implement.md'), 'shared')
      const surface = path.join(tmpDir, 'workspace')
      mkdirp(path.join(surface, 'agents'))
      writeFileLf(path.join(surface, 'settings.json'), '{}')
      writeFileLf(path.join(surface, 'agents', 'sr-architect.md'), 'agent')
      symlinkOrCopy(shared, path.join(surface, 'commands'))

      const backup = path.join(tmpDir, 'backup')
      const records = snapshotTree(surface, backup)

      expect(records.map((record) => record.rel)).toEqual(['commands'])
      expect(realpathSync(records[0]!.target)).toBe(realpathSync(shared))
      expect(readTextFile(path.join(backup, 'settings.json'))).toBe('{}')
      expect(readTextFile(path.join(backup, 'agents', 'sr-architect.md'))).toBe('agent')
      expect(pathExists(path.join(backup, 'commands'))).toBe(false)
    })

    it('round-trips a surface, links included', () => {
      const shared = path.join(tmpDir, 'shared')
      mkdirp(shared)
      writeFileLf(path.join(shared, 'implement.md'), 'shared')
      const surface = path.join(tmpDir, 'workspace')
      mkdirp(surface)
      writeFileLf(path.join(surface, 'settings.json'), '{"v":1}')
      symlinkOrCopy(shared, path.join(surface, 'commands'))

      const backup = path.join(tmpDir, 'backup')
      const records = snapshotTree(surface, backup)

      removePath(surface)
      restoreTree(backup, surface, records)

      expect(readTextFile(path.join(surface, 'settings.json'))).toBe('{"v":1}')
      expect(isSymlink(path.join(surface, 'commands'))).toBe(true)
      expect(readTextFile(path.join(surface, 'commands', 'implement.md'))).toBe('shared')
    })

    it('honours the skip predicate so a reserved entry is never overwritten', () => {
      const surface = path.join(tmpDir, 'workspace')
      mkdirp(surface)
      writeFileLf(path.join(surface, 'keep.json'), 'old')
      writeFileLf(path.join(surface, 'replace.json'), 'old')

      const backup = path.join(tmpDir, 'backup')
      const records = snapshotTree(surface, backup)

      writeFileLf(path.join(surface, 'keep.json'), 'edited during install')
      writeFileLf(path.join(surface, 'replace.json'), 'edited during install')
      restoreTree(backup, surface, records, { skip: (rel) => rel === 'keep.json' })

      expect(readTextFile(path.join(surface, 'keep.json'))).toBe('edited during install')
      expect(readTextFile(path.join(surface, 'replace.json'))).toBe('old')
    })

    it('restores a link whose target is gone as a dangling pointer, not a failure', () => {
      const target = path.join(tmpDir, 'versioned')
      mkdirp(target)
      const link = path.join(tmpDir, 'current')
      symlinkOrCopy(target, link)
      const records = snapshotTree(link, path.join(tmpDir, 'backup'))

      removePath(link)
      removePath(target)
      restoreTree(path.join(tmpDir, 'backup'), link, records)

      expect(isSymlink(link)).toBe(true)
    })
  })
})
