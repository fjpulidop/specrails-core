import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Only used for the disposable C1 experiment directory, never production paths. */
export function privatePathEvidence(target, { protect = false } = {}) {
  if (process.platform !== 'win32') {
    const mode = statSync(target).mode & 0o777
    assert.ok(mode === 0o700 || mode === 0o600, 'Experiment path must be owner-only')
    return { mechanism: 'posix-mode', mode }
  }
  const script = fileURLToPath(new URL('./private-directory.ps1', import.meta.url))
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', target, '-Mode', protect ? 'protect' : 'inspect'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  const acl = JSON.parse(result.stdout.trim())
  assert.equal(acl.ownerSid, acl.currentUserSid, 'Experiment path must belong to the current user')
  if (protect) assert.equal(acl.protected, true, 'Private experiment root must reject inherited broad access')
  const allowed = new Set([acl.currentUserSid, 'S-1-5-18'])
  assert.ok(acl.entries.length > 0)
  assert.ok(acl.entries.every(entry => allowed.has(entry.sid) && entry.access === 'Allow'), 'Private experiment ACL must grant only its owner and SYSTEM')
  assert.ok(acl.entries.some(entry => entry.sid === acl.currentUserSid && entry.rights.includes('FullControl')))
  return { mechanism: 'windows-acl', ...acl }
}
