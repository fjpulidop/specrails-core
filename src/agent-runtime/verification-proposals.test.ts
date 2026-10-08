import { describe, expect, it } from 'vitest'
import { packageScriptOf } from './verification-proposals.js'

describe('packageScriptOf', () => {
  it('names the one script a package-manager command runs', () => {
    expect(packageScriptOf({ command: 'npm', args: ['test'] })).toBe('test')
    expect(packageScriptOf({ command: 'npm', args: ['run', 'test:e2e'] })).toBe('test:e2e')
    expect(packageScriptOf({ command: 'npm', args: ['run-script', 'build'] })).toBe('build')
    expect(packageScriptOf({ command: 'pnpm', args: ['run', 'e2e'] })).toBe('e2e')
    expect(packageScriptOf({ command: 'pnpm', args: ['e2e'] })).toBe('e2e')
    expect(packageScriptOf({ command: 'yarn', args: ['test:e2e'] })).toBe('test:e2e')
  })
  it('rejects anything else: extra arguments, other tools, flags, bare installs', () => {
    expect(packageScriptOf({ command: 'npm', args: ['run', 'e2e', '--', '--grep', 'x'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'npm', args: ['install'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'npm', args: ['test', '--watch'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'npx', args: ['playwright', 'test'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'yarn', args: ['--version'] })).toBeUndefined()
    expect(packageScriptOf({ command: 'sh', args: ['-c', 'npm test'] })).toBeUndefined()
  })
})
