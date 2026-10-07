import { describe, expect, it } from 'vitest'

import { spawnResidentProcess, type ProcessExit } from './process.js'

const node = process.execPath

function run(script: string) {
  const lines: string[] = []
  const stderr: string[] = []
  const proc = spawnResidentProcess({ command: node, args: ['-e', script], cwd: process.cwd(), env: process.env }, { onLine: (line) => lines.push(line), onStderr: (chunk) => stderr.push(chunk) })
  return { proc, lines, stderr }
}

const until = async (check: () => boolean, ms = 5_000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('resident provider process', () => {
  it('echoes stdin lines and keeps running until input ends', async () => {
    const { proc, lines } = run("process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){process.stdout.write('echo:'+b.slice(0,i)+'\\n');b=b.slice(i+1)}});process.stdin.on('end',()=>process.exit(0))")
    expect(proc.write('one')).toBe(true)
    expect(proc.write('two')).toBe(true)
    await until(() => lines.length === 2)
    expect(lines).toEqual(['echo:one', 'echo:two'])
    proc.endInput()
    expect(proc.write('late')).toBe(false)
    await expect(proc.exited).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('splits chunked output into lines and flushes the last partial line on exit', async () => {
    const { proc, lines } = run("process.stdout.write('a\\r\\nb');setTimeout(()=>process.stdout.write('c\\n\\nd'),20)")
    await proc.exited
    expect(lines).toEqual(['a', 'bc', 'd'])
  })

  it.skipIf(process.platform === 'win32')('lets a cooperative process stop gracefully on SIGTERM', async () => {
    const { proc, lines } = run("process.on('SIGTERM',()=>{process.stdout.write('stopping\\n');process.exit(0)});process.stdout.write('ready\\n');setInterval(()=>{},1000)")
    await until(() => lines.includes('ready'))
    const result: ProcessExit = await proc.terminate(5_000)
    expect(lines).toContain('stopping')
    expect(result.exitCode).toBe(0)
  })

  it('forces a process that ignores the graceful stop, including its children', async () => {
    const { proc, lines } = run([
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })",
      "process.stdout.write('child:' + child.pid + '\\n')",
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
    ].join(';'))
    await until(() => lines.some((line) => line.startsWith('child:')))
    const grandchild = Number(lines.find((line) => line.startsWith('child:'))!.slice(6))
    const result = await proc.terminate(200)
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
    await until(() => { try { process.kill(grandchild, 0); return false } catch { return true } })
  })

  it('reports a missing executable as an exit instead of throwing', async () => {
    const proc = spawnResidentProcess({ command: 'specrails-definitely-missing-binary', args: [], cwd: process.cwd(), env: process.env }, { onLine: () => {} })
    const result = await proc.exited
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
  })
})
