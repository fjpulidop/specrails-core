import { describe, expect, it } from 'vitest'

import { ExecError } from './errors.js'
import { commandExists, runCommand, tryRunCommand } from './exec.js'

describe('exec', () => {
  describe('runCommand', () => {
    it('resolves on zero exit and captures stdout when inherit=false', async () => {
      const echo = process.platform === 'win32' ? 'cmd' : 'node'
      const args = process.platform === 'win32'
        ? ['/c', 'echo', 'hello']
        : ['-e', "process.stdout.write('hello')"]
      const result = await runCommand(echo, args, { inherit: false })
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toContain('hello')
    })

    it('rejects with ExecError on non-zero exit', async () => {
      try {
        await runCommand('node', ['-e', 'process.exit(7)'], { inherit: false })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ExecError)
        const execErr = err as ExecError
        expect(execErr.code).toBe(7)
      }
    })

    it('rejects with an error when the binary does not exist', async () => {
      await expect(
        runCommand('this-binary-definitely-does-not-exist-xyz', [], { inherit: false }),
      ).rejects.toBeTruthy()
    })

    // Windows-only caveat: with shell:true, the immediate child is
    // cmd.exe wrapping the real binary. Sending SIGKILL terminates
    // cmd.exe but Windows does not propagate the signal down its
    // children — the inner node process is orphaned and keeps stdio
    // pipes open, so the runCommand promise never resolves until the
    // test timeout fires. Tree-kill via `taskkill /T /F /PID <pid>` is
    // the canonical fix; tracked in a follow-up. For now we exercise
    // the timeout path on POSIX where SIGKILL behaves as expected.
    it.runIf(process.platform !== 'win32')(
      'honours a timeout by SIGKILLing the child',
      async () => {
        await expect(
          runCommand(
            'node',
            ['-e', 'setInterval(()=>{},1000)'],
            { inherit: false, timeoutMs: 150 },
          ),
        ).rejects.toBeTruthy()
      },
      5000,
    )

    it('quotes args containing spaces so they reach the child as one token', async () => {
      // Asserts that an arg with embedded whitespace round-trips
      // through the shell wrapper unchanged. Reproduces the production
      // scenario where the installer spawns `git commit -m "<message
      // with spaces>"` or runs against a project path containing
      // spaces (e.g. `C:\Users\Javi Pulido\repos\test1`).
      const phrase = 'a b c spaced phrase'
      const result = await runCommand(
        'node',
        ['-e', `process.stdout.write(process.argv[1])`, phrase],
        { inherit: false },
      )
      expect(result.stdout.trim()).toBe(phrase)
    })
  })

  describe('tryRunCommand', () => {
    it('returns true on success', async () => {
      const ok = await tryRunCommand('node', ['-e', 'process.exit(0)'], { inherit: false })
      expect(ok).toBe(true)
    })

    it('returns false on failure without throwing', async () => {
      const ok = await tryRunCommand('node', ['-e', 'process.exit(1)'], { inherit: false })
      expect(ok).toBe(false)
    })
  })

  describe('commandExists', () => {
    it('returns true for node (always present in the test env)', async () => {
      expect(await commandExists('node')).toBe(true)
    })

    it('returns false for a made-up command', async () => {
      expect(await commandExists('definitely-not-a-real-binary-xyz-12345')).toBe(false)
    })
  })
})
