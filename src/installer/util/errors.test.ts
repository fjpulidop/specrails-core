import { describe, expect, it } from 'vitest'

import {
  ExecError,
  FilesystemError,
  GitError,
  InstallerError,
  PrerequisiteError,
  ProviderError,
  PromptAbortError,
  isInstallerError,
} from './errors.js'

describe('errors', () => {
  it('InstallerError carries a default exit code of 1', () => {
    const err = new InstallerError('boom')
    expect(err.exitCode).toBe(1)
    expect(err.name).toBe('InstallerError')
    expect(err.message).toBe('boom')
    expect(err).toBeInstanceOf(Error)
  })

  it('each typed subclass has a stable exit code', () => {
    expect(new PrerequisiteError('x').exitCode).toBe(10)
    expect(new FilesystemError('x').exitCode).toBe(20)
    expect(new GitError('x').exitCode).toBe(30)
    expect(new ProviderError('x').exitCode).toBe(40)
    expect(new ExecError('cmd', 1, '', '').exitCode).toBe(50)
    expect(new PromptAbortError().exitCode).toBe(60)
  })

  it('each subclass surfaces its name for logging', () => {
    expect(new PrerequisiteError('x').name).toBe('PrerequisiteError')
    expect(new FilesystemError('x').name).toBe('FilesystemError')
    expect(new GitError('x').name).toBe('GitError')
    expect(new ProviderError('x').name).toBe('ProviderError')
    expect(new ExecError('cmd', 1, '', '').name).toBe('ExecError')
    expect(new PromptAbortError().name).toBe('PromptAbortError')
  })

  it('FilesystemError captures the offending path', () => {
    const err = new FilesystemError('denied', '/tmp/foo')
    expect(err.path).toBe('/tmp/foo')
  })

  it('GitError captures the originating command', () => {
    const err = new GitError('failed', 'git init')
    expect(err.command).toBe('git init')
  })

  it('ExecError captures stdout, stderr and exit code', () => {
    const err = new ExecError('ls -la', 2, 'out', 'err')
    expect(err.code).toBe(2)
    expect(err.stdout).toBe('out')
    expect(err.stderr).toBe('err')
    expect(err.command).toBe('ls -la')
  })

  it('isInstallerError narrows typed errors', () => {
    const typed: unknown = new PrerequisiteError('x')
    const plain: unknown = new Error('x')
    expect(isInstallerError(typed)).toBe(true)
    expect(isInstallerError(plain)).toBe(false)
    expect(isInstallerError(null)).toBe(false)
    expect(isInstallerError('string')).toBe(false)
  })

  it('subclasses survive instanceof after throwing (prototype chain intact)', () => {
    const run = (): void => {
      throw new PrerequisiteError('x')
    }
    try {
      run()
    } catch (err) {
      expect(err).toBeInstanceOf(PrerequisiteError)
      expect(err).toBeInstanceOf(InstallerError)
      expect(err).toBeInstanceOf(Error)
    }
  })
})
