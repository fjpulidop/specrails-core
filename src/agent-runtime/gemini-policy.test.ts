import { describe, expect, it, vi } from 'vitest'
import { assertGeminiAdminPolicyAvailable } from './gemini-policy.js'

describe('Gemini read-only policy capability', () => {
  it.each([
    ['darwin', '/Library/Application Support/GeminiCli/policies'],
    ['win32', 'C:\\ProgramData\\gemini-cli\\policies'],
    ['linux', '/etc/gemini-cli/policies'],
  ] as const)('checks the native %s system policy directory', (platform, directory) => {
    const readDirectory = vi.fn(() => [])
    assertGeminiAdminPolicyAvailable({ platform, readDirectory })
    expect(readDirectory).toHaveBeenCalledWith(directory)
  })
  it('rejects system policies because Gemini would silently ignore the per-run policy', () => {
    expect(() => assertGeminiAdminPolicyAvailable({ readDirectory: () => ['managed.toml'] })).toThrow('system policies disable per-run admin policy')
  })
  it('allows absent policy directories but fails closed when their contents cannot be checked', () => {
    expect(() => assertGeminiAdminPolicyAvailable({ readDirectory: () => { throw Object.assign(new Error(), { code: 'ENOENT' }) } })).not.toThrow()
    expect(() => assertGeminiAdminPolicyAvailable({ readDirectory: () => { throw Object.assign(new Error(), { code: 'EACCES' }) } })).toThrow('Cannot verify Gemini system policies')
  })
})
