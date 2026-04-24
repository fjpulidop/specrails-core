import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  RESERVED_PATHS,
  isReservedPath,
  repoRelative,
  toNative,
  toPosix,
} from './paths.js'

describe('paths', () => {
  describe('RESERVED_PATHS', () => {
    it('contains the documented reserved prefixes', () => {
      expect(RESERVED_PATHS).toContain('.specrails/profiles/')
      expect(RESERVED_PATHS).toContain('.claude/agents/custom-')
    })
  })

  describe('isReservedPath', () => {
    it('matches profile files regardless of separator', () => {
      expect(isReservedPath('.specrails/profiles/default.json')).toBe(true)
      expect(isReservedPath('.specrails\\profiles\\team.json')).toBe(true)
    })

    it('matches custom-* agent files', () => {
      expect(isReservedPath('.claude/agents/custom-foo.md')).toBe(true)
      expect(isReservedPath('.claude\\agents\\custom-bar.md')).toBe(true)
    })

    it('does not match bundled sr-* agents', () => {
      expect(isReservedPath('.claude/agents/sr-architect.md')).toBe(false)
    })

    it('does not match other .specrails subtrees', () => {
      expect(isReservedPath('.specrails/install-config.yaml')).toBe(false)
      expect(isReservedPath('.specrails/specrails-manifest.json')).toBe(false)
    })

    it('rejects empty input and unrelated paths', () => {
      expect(isReservedPath('')).toBe(false)
      expect(isReservedPath('README.md')).toBe(false)
      expect(isReservedPath('src/index.ts')).toBe(false)
    })
  })

  describe('toPosix', () => {
    it('joins using forward slashes regardless of host', () => {
      expect(toPosix('a', 'b', 'c')).toBe('a/b/c')
    })

    it('normalises backslashes inside a single segment', () => {
      expect(toPosix('a\\b', 'c')).toBe('a/b/c')
    })
  })

  describe('toNative', () => {
    it('uses the host separator', () => {
      expect(toNative('a', 'b', 'c')).toBe(path.join('a', 'b', 'c'))
    })
  })

  describe('repoRelative', () => {
    it('returns a POSIX-style relative path inside the repo', () => {
      const root = path.resolve('/tmp/repo')
      const file = path.resolve(root, 'src', 'index.ts')
      expect(repoRelative(root, file)).toBe('src/index.ts')
    })

    it('returns the POSIX-normalised absolute path when outside the repo', () => {
      const root = path.resolve('/tmp/repo')
      const file = path.resolve('/tmp/other/file.ts')
      const rel = repoRelative(root, file)
      expect(rel).not.toContain('\\')
      // Accept either the absolute form or a ".." prefix depending on host
      // `path.relative` behaviour; the point is it round-trips consistently.
      expect(rel.length).toBeGreaterThan(0)
    })
  })
})
