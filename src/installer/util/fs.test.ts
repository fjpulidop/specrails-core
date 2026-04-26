import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FilesystemError } from './errors.js'
import {
  copyDir,
  copyFile,
  isDir,
  isFile,
  listDir,
  mkdirp,
  pathExists,
  readTextFile,
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
})
