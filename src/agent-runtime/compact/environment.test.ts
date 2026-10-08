import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredPlaywrightBrowsers, detectCheckCommand, hostPreconditionFailure, missingPlaywrightBrowsers, prepareEnvironment, hostPreconditionKind, installEnvironment, isEnvironmentFailure, isPlaywrightBrowserFailure, missingNodeDependencies, plannedInstalls, playwrightBrowser, runGroupCheck, suggestedPackages } from './environment.js'

const temporary: string[] = []
function root(files: Record<string, string> = {}, dirs: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-'))
  temporary.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  for (const name of dirs) mkdirSync(path.join(dir, name), { recursive: true })
  return dir
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('isEnvironmentFailure', () => {
  it('recognises missing tools and modules, not ordinary test failures', () => {
    expect(isEnvironmentFailure(127, '')).toBe(true)
    expect(isEnvironmentFailure(1, '> jest\n\nsh: jest: command not found\n')).toBe(true)
    expect(isEnvironmentFailure(1, "Error: Cannot find module 'ts-jest'")).toBe(true)
    expect(isEnvironmentFailure(1, 'ModuleNotFoundError: No module named pytest')).toBe(true)
    expect(isEnvironmentFailure(1, "Error: Cannot find module './board' — relative imports are code, not environment")).toBe(false)
    expect(isEnvironmentFailure(1, 'FAIL src/game.spec.ts\n  ● clears lines\n    expect(received).toBe(expected)')).toBe(false)
    expect(isEnvironmentFailure(0, 'sh: jest: command not found')).toBe(true)
  })
})

describe('hostPreconditionFailure', () => {
  it('names failures only the host can repair: missing variables, rejected credentials, unreachable registries', () => {
    // Observed verbatim: Yarn Berry refusing to run any script without the token its .yarnrc.yml references.
    expect(hostPreconditionFailure('Usage Error: Environment variable not found (NODE_AUTH_TOKEN) in /w/ticket-199/.yarnrc.yml (in /w/ticket-199/.yarnrc.yml)\n\nYarn Package Manager - 4.5.0')).toContain('NODE_AUTH_TOKEN')
    expect(hostPreconditionFailure('➤ YN0035: │ @busuu/experiments@npm:5.17.1: The remote server failed to provide the requested resource\n➤ YN0035: │   Response Code: 403 (Forbidden)')).toContain('401/403')
    expect(hostPreconditionFailure('➤ YN0041: │ Invalid authentication (as an anonymous user)')).toContain('credentials')
    expect(hostPreconditionFailure('npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/@acme%2fui')).toContain('credentials')
    expect(hostPreconditionFailure('npm ERR! code ENEEDAUTH\nnpm ERR! need auth This command requires you to be logged in')).toContain('credentials')
    expect(hostPreconditionFailure(' ERR_PNPM_FETCH_403  GET https://registry.example.com/@acme%2Fui: Forbidden - 403')).toContain('credentials')
    expect(hostPreconditionFailure('npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org')).toContain('cannot be reached')
    expect(hostPreconditionFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toContain('git credentials')
  })

  it('leaves code failures to the fixer, even when they mention status codes or missing modules', () => {
    for (const output of [
      'FAIL src/api.spec.ts\n  ● rejects anonymous users\n    expect(received).toBe(expected)\n    Expected: 401\n    Received: 403 Forbidden',
      "Error: Cannot find module './navigation' from 'src/app.ts'",
      'sh: jest: command not found',
      'TypeError: Cannot read properties of undefined (reading \'env\')',
      'Error: process.env.API_TOKEN is not defined',
    ]) expect(hostPreconditionFailure(output)).toBeUndefined()
  })

  it('treats a Yarn checkout that was never installed as an installable environment failure', () => {
    expect(isEnvironmentFailure(1, "Usage Error: The project in /w/app/package.json doesn't seem to have been installed - running an install there might help")).toBe(true)
  })
})

describe('plannedInstalls', () => {
  it('plans one install per ecosystem whose output is absent', () => {
    const node = root({ 'package.json': '{}' })
    expect(plannedInstalls(node)).toMatchObject([{ ecosystem: 'node', command: 'npm' }])
    expect(plannedInstalls(root({ 'package.json': '{}' }, ['node_modules']))).toEqual([])
    expect(plannedInstalls(root({ 'package.json': '{}', 'pnpm-lock.yaml': '' }))).toMatchObject([{ command: 'pnpm', args: ['install'] }])
    expect(plannedInstalls(root({ 'requirements.txt': 'pytest\n' }))).toMatchObject([{ ecosystem: 'python', args: ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'] }])
    expect(plannedInstalls(root({ 'go.mod': 'module x\n' }))).toMatchObject([{ ecosystem: 'go' }])
    expect(plannedInstalls(root({ 'Cargo.toml': '' }))).toMatchObject([{ ecosystem: 'rust' }])
    expect(plannedInstalls(root())).toEqual([])
  })
})

describe('installEnvironment', () => {
  it('runs each planned install once with a bounded spawn, reports outcomes and never throws', () => {
    const node = root({ 'package.json': '{}' })
    const spawn = vi.fn((command: string, _args?: string[], _options?: unknown) => ({ status: command === 'npm' ? 0 : 1, stdout: '', stderr: 'boom', pid: 1, output: [], signal: null }))
    const events: unknown[] = []
    const outcomes = installEnvironment([node, root({ 'go.mod': '' })], { spawn: spawn as never, onEvent: event => events.push(event) })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]![1]).toEqual(['install', '--no-audit', '--no-fund', '--loglevel=error'])
    expect((spawn.mock.calls[0]![2] as { cwd: string; timeout: number }).cwd).toBe(node)
    expect(outcomes.map(item => item.ok)).toEqual([true, false])
    expect(outcomes[1]!.detail).toContain('boom')
    expect(events.filter(event => (event as { kind: string }).kind === 'tool-start')).toHaveLength(2)
    const throwing = vi.fn(() => { throw new Error('spawn exploded') }) as never
    expect(installEnvironment([node], { spawn: throwing })[0]).toMatchObject({ ok: false })
  })
})


describe('suggested packages from failure output', () => {
  it('recognises the TypeScript type-definition hint and installs exactly the named packages', () => {
    const output = "error TS2582: Cannot find name 'test'. Do you need to install type definitions for a test runner? Try `npm i --save-dev @types/jest` or `npm i --save-dev @types/mocha`."
    expect(isEnvironmentFailure(1, output)).toBe(true)
    expect(suggestedPackages(output)).toEqual(['@types/jest', '@types/mocha'])
    const node = root({ 'package.json': '{}' }, ['node_modules'])
    expect(plannedInstalls(node)).toEqual([])
    expect(plannedInstalls(node, output)).toMatchObject([{ command: 'npm', args: ['install', '--save-dev', '--no-audit', '--no-fund', '--loglevel=error', '@types/jest', '@types/mocha'] }])
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null })) as never
    expect(installEnvironment([node], { spawn, failureOutput: output })[0]).toMatchObject({ ok: true })
    expect(suggestedPackages('FAIL: expect(received).toBe(expected)')).toEqual([])
  })
})


describe('jest transform/preset modules', () => {
  it('recognises a missing ts-jest transform and installs it with typescript', () => {
    const output = '● Validation Error:\n\n  Module ts-jest in the transform option was not found.\n         <rootDir> is: /repo'
    expect(isEnvironmentFailure(1, output)).toBe(true)
    expect(suggestedPackages(output)).toEqual(['ts-jest', 'typescript'])
    expect(suggestedPackages('Preset babel-jest not found')).toEqual(['babel-jest'])
  })
})

describe('manifest drift + Jest option modules', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  const repo = (): string => { const dir = mkdtempSync(path.join(tmpdir(), 'drift-')); dirs.push(dir); return dir }

  it('plans a reinstall when package.json declares a dependency node_modules lacks', () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29', 'jest-extended': '^3' } }))
    mkdirSync(path.join(dir, 'node_modules', 'jest'), { recursive: true })
    expect(missingNodeDependencies(dir)).toEqual(['jest-extended'])
    expect(plannedInstalls(dir).map(plan => plan.args[0])).toEqual(['install'])
    mkdirSync(path.join(dir, 'node_modules', 'jest-extended'), { recursive: true })
    expect(missingNodeDependencies(dir)).toEqual([])
    expect(plannedInstalls(dir)).toEqual([])
  })
  it('recognises any missing Jest option module and names it', () => {
    const output = '● Validation Error:\n\n  Module jest-extended in the setupFilesAfterEnv option was not found.\n'
    expect(isEnvironmentFailure(1, output)).toBe(true)
    expect(suggestedPackages(output)).toEqual(['jest-extended'])
    expect(isEnvironmentFailure(1, 'Module @swc/jest in the transform option was not found')).toBe(true)
  })
})

describe('hand-written lockfiles', () => {
  it('drops a lockfile npm rejects (EINTEGRITY) and retries the install once', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lock-'))
    try {
      writeFileSync(path.join(dir, 'package.json'), '{"devDependencies":{"jest":"^29"}}')
      writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/jest":{"integrity":"sha512-fake"}}}')
      const calls: string[][] = []
      const spawn = vi.fn((cmd: string, args: string[]) => {
        calls.push([cmd, ...args])
        const first = calls.length === 1
        return { status: first ? 1 : 0, stderr: first ? 'npm error code EINTEGRITY\nnpm error sha512-fake integrity checksum failed' : '', stdout: '', pid: 1, output: [], signal: null } as never
      })
      const events: string[] = []
      const outcomes = installEnvironment([dir], { spawn: spawn as never, onEvent: e => { if (e.kind === 'text') events.push(e.text ?? '') } })
      expect(calls).toHaveLength(2)
      expect(existsSync(path.join(dir, 'package-lock.json'))).toBe(false)
      expect(outcomes[0]?.ok).toBe(true)
      expect(events.some(text => /package-lock\.json did not match/.test(text))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('unpublished pins', () => {
  it('relaxes an exact version the registry never published and retries once', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pin-'))
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@babel/preset-env': '7.23.0', jest: '^29' } }))
      const calls: string[][] = []
      const spawn = vi.fn((cmd: string, args: string[]) => {
        calls.push([cmd, ...args])
        const first = calls.length === 1
        return { status: first ? 1 : 0, stderr: first ? 'npm error code ETARGET\nnpm error notarget No matching version found for @babel/preset-env@7.23.0.\nnpm error notarget In most cases you or one of your dependencies are requesting' : '', stdout: '', pid: 1, output: [], signal: null } as never
      })
      const events: string[] = []
      const outcomes = installEnvironment([dir], { spawn: spawn as never, onEvent: e => { if (e.kind === 'text') events.push(e.text ?? '') } })
      expect(calls).toHaveLength(2)
      expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).devDependencies['@babel/preset-env']).toBe('^7.0.0')
      expect(outcomes[0]?.ok).toBe(true)
      expect(events.some(text => /is not published; relaxed the pin/.test(text))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('group check', () => {
  it('detects the repository test command per ecosystem and skips the npm placeholder', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-'))
    try {
      expect(detectCheckCommand(dir)).toBeUndefined()
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
      expect(detectCheckCommand(dir)).toBeUndefined()
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node tests/smoke.test.js' } }))
      expect(detectCheckCommand(dir)).toEqual({ command: 'npm', args: ['test', '--silent'] })
      writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
      expect(detectCheckCommand(dir)).toEqual({ command: 'pnpm', args: ['test'] })
      rmSync(path.join(dir, 'package.json')); rmSync(path.join(dir, 'pnpm-lock.yaml'))
      writeFileSync(path.join(dir, 'go.mod'), 'module x')
      expect(detectCheckCommand(dir)?.command).toBe('go')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('runs the check once, bounded, and reports a failure with the output tail', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-'))
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }))
      const spawn = vi.fn(() => ({ status: 1, stdout: 'x'.repeat(10), stderr: 'AssertionError: expected 1 to be 2\n    at t.js:3:1', pid: 1, output: [], signal: null }) as never)
      const outcome = runGroupCheck([dir], { spawn: spawn as never })
      expect(outcome).toMatchObject({ ran: true, ok: false, command: 'npm test --silent' })
      expect(outcome.output).toContain('AssertionError')
      expect(spawn).toHaveBeenCalledWith('npm', ['test', '--silent'], expect.objectContaining({ cwd: dir }))
      expect(runGroupCheck([mkdtempSync(path.join(tmpdir(), 'empty-'))])).toEqual({ ran: false, ok: true, output: '' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('Playwright browser builds', () => {
  // Observed verbatim on 2026-10-06 (pixel-depths, ticket 1): the package was installed by `npm ci`, the browser build was not.
  const missing = "Error: browserType.launch: Executable doesn't exist at /Users/dev/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-mac-arm64/headless_shell\n╔═══╗\n║ Looks like Playwright Test or Playwright was just installed or updated. ║\n║ Please run the following command to download new browsers:             ║\n║     npx playwright install                                              ║"
  it('recognises each missing-browser signature as an environment failure and parses the browser from the path', () => {
    expect(isEnvironmentFailure(1, missing)).toBe(true)
    expect(isPlaywrightBrowserFailure("browserType.launch: Executable doesn't exist at C:\\Users\\dev\\AppData\\Local\\ms-playwright\\firefox-1466\\firefox\\firefox.exe")).toBe(true)
    expect(isPlaywrightBrowserFailure('Looks like Playwright was just installed or updated.')).toBe(true)
    expect(isPlaywrightBrowserFailure('Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/')).toBe(false)
    expect(playwrightBrowser(missing)).toBe('chromium')
    expect(playwrightBrowser('at C:\\Users\\dev\\AppData\\Local\\ms-playwright\\firefox-1466\\firefox\\firefox.exe')).toBe('firefox')
    expect(playwrightBrowser('/home/ci/.cache/ms-playwright/webkit-2104/pw_run.sh')).toBe('webkit')
    expect(playwrightBrowser('Looks like Playwright was just installed or updated.')).toBeUndefined()
  })
  it('treats a browser download that cannot reach the CDN as a network precondition', () => {
    const offline = 'Downloading Chromium 131.0.6778.33 (playwright build v1148) from https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1148/chromium-mac-arm64.zip\nError: getaddrinfo ENOTFOUND cdn.playwright.dev\nFailed to download Chromium 131.0.6778.33 (playwright build v1148), caused by\nError: getaddrinfo ENOTFOUND cdn.playwright.dev'
    expect(hostPreconditionFailure(offline)).toContain('Playwright browser download')
    expect(hostPreconditionKind(offline)).toBe('network')
    expect(hostPreconditionKind('Error: connect ETIMEDOUT 13.107.246.64:443 while fetching https://playwright.azureedge.net/builds/chromium/1148/chromium-linux.zip')).toBe('network')
    // A test that times out against the app under test is a code failure, even inside a Playwright suite.
    expect(hostPreconditionFailure('Error: connect ETIMEDOUT 127.0.0.1:3000\n    at node_modules/playwright-core/lib/client/page.js:12:1')).toBeUndefined()
    expect(hostPreconditionKind('npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/@acme%2fui')).toBe('credential')
    expect(hostPreconditionKind('Usage Error: Environment variable not found (NODE_AUTH_TOKEN) in /w/app/.yarnrc.yml')).toBe('environment-variable')
    expect(hostPreconditionKind('npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org')).toBe('network')
    expect(hostPreconditionKind("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe('credential')
    expect(hostPreconditionKind('FAIL src/app.spec.ts\n  ● renders\n    expect(received).toBe(expected)')).toBeUndefined()
  })
  it('plans the browser install only for manifests that declare Playwright, after the dependency plan, with its own timeout', () => {
    const manifest = JSON.stringify({ devDependencies: { '@playwright/test': '^1.48' } })
    const installed = root({ 'package.json': manifest }, ['node_modules/@playwright/test'])
    expect(plannedInstalls(installed, missing)).toEqual([{ ecosystem: 'node', root: installed, command: 'npx', args: ['playwright', 'install', 'chromium'], timeoutMs: 600_000, installs: 'Playwright chromium' }])
    expect(plannedInstalls(installed, 'FAIL src/app.spec.ts')).toEqual([])
    expect(plannedInstalls(root({ 'package.json': JSON.stringify({ devDependencies: { playwright: '^1.48' } }) }, ['node_modules/playwright']), 'Looks like Playwright was just installed or updated.')).toMatchObject([{ command: 'npx', args: ['playwright', 'install'], installs: 'Playwright browsers' }])
    expect(plannedInstalls(root({ 'package.json': JSON.stringify({ devDependencies: { jest: '^29' } }) }, ['node_modules/jest']), missing)).toEqual([])
    // A fresh worktree installs node_modules first: `npx playwright` needs the package.
    expect(plannedInstalls(root({ 'package.json': manifest }), missing).map(plan => [plan.command, ...plan.args])).toEqual([['npm', 'install', '--no-audit', '--no-fund', '--loglevel=error'], ['npx', 'playwright', 'install', 'chromium']])
    expect(plannedInstalls(root({ 'package.json': manifest, 'pnpm-lock.yaml': '' }, ['node_modules/@playwright/test']), missing)).toMatchObject([{ command: 'pnpm', args: ['exec', 'playwright', 'install', 'chromium'] }])
    expect(plannedInstalls(root({ 'package.json': manifest, 'yarn.lock': '' }, ['node_modules/@playwright/test']), missing)).toMatchObject([{ command: 'yarn', args: ['playwright', 'install', 'chromium'] }])
  })
  it('runs the browser install with the plan timeout and names what it installed', () => {
    const dir = root({ 'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.48' } }) }, ['node_modules/@playwright/test'])
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null })) as never
    const events: string[] = []
    const outcomes = installEnvironment([dir], { spawn, failureOutput: missing, onEvent: event => { if (event.kind === 'text') events.push(event.text ?? '') } })
    expect(spawn).toHaveBeenCalledWith('npx', ['playwright', 'install', 'chromium'], expect.objectContaining({ cwd: dir, timeout: 600_000 }))
    expect(outcomes).toMatchObject([{ ok: true, detail: `installed Playwright chromium in ${path.basename(dir)}` }])
    expect(events).toContain(`Environment: installed Playwright chromium in ${path.basename(dir)}`)
    const offline = vi.fn(() => ({ status: 1, stdout: '', stderr: 'Failed to download Chromium 131.0.6778.33 (playwright build v1148), caused by\nError: getaddrinfo ENOTFOUND cdn.playwright.dev', pid: 1, output: [], signal: null })) as never
    expect(installEnvironment([dir], { spawn: offline, failureOutput: missing })[0]).toMatchObject({ ok: false, precondition: expect.stringContaining('CDN') })
  })
})

describe('host preparation before writer turns', () => {
  const manifest = JSON.stringify({ devDependencies: { '@playwright/test': '^1.63.0' } })
  /** A repository with Playwright installed; `browsers` are the dry-run install locations. */
  function playwrightRepo(config = '') {
    const dir = root({ 'package.json': manifest, ...(config ? { 'playwright.config.ts': config } : {}) }, ['node_modules/.bin', 'node_modules/@playwright/test'])
    writeFileSync(path.join(dir, 'node_modules/.bin/playwright'), '')
    return dir
  }
  function dryRun(locations: string[]) {
    return vi.fn((command: string, args: readonly string[]) => ({ status: 0, stdout: args.includes('--dry-run') ? locations.map(location => `Browser (playwright v1)\n  Install location:    ${location}\n  Download url: https://cdn\n`).join('\n') : '', stderr: '', pid: 1, output: [], signal: null }))
  }

  it('reads the browsers a Playwright config runs, defaulting to chromium', () => {
    expect(configuredPlaywrightBrowsers(playwrightRepo())).toEqual(['chromium'])
    expect(configuredPlaywrightBrowsers(playwrightRepo("projects: [{ name: 'firefox', use: devices['Desktop Firefox'] }, { name: 'Mobile Safari', use: devices['iPhone 15'] }]"))).toEqual(['firefox', 'webkit'])
    expect(configuredPlaywrightBrowsers(playwrightRepo("use: { browserName: 'chromium' }, projects: [{ use: devices['Desktop Safari'] }]"))).toEqual(['chromium', 'webkit'])
  })

  it('reports browsers only when a pinned build is missing, without downloading', () => {
    const dir = playwrightRepo()
    const present = path.join(dir, 'cache/chromium-1243')
    mkdirSync(present, { recursive: true })
    const missing = dryRun([present, path.join(dir, 'cache/chromium_headless_shell-1243')])
    expect(missingPlaywrightBrowsers(dir, missing as never)).toEqual(['chromium'])
    expect(missing).toHaveBeenCalledWith('npx', ['--no', 'playwright', 'install', '--dry-run', 'chromium'], expect.objectContaining({ cwd: dir }))
    expect(missingPlaywrightBrowsers(dir, dryRun([present]) as never)).toEqual([])
    // Unknown is never an install: a failing dry-run, no parsable location, or no local Playwright package.
    expect(missingPlaywrightBrowsers(dir, vi.fn(() => ({ status: 1, stdout: '', stderr: 'boom' })) as never)).toEqual([])
    expect(missingPlaywrightBrowsers(dir, vi.fn(() => ({ status: 0, stdout: 'nothing', stderr: '' })) as never)).toEqual([])
    const uninstalled = root({ 'package.json': manifest })
    const spawn = dryRun([path.join(dir, 'nope')])
    expect(missingPlaywrightBrowsers(uninstalled, spawn as never)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('installs missing dependencies first, then the missing browser builds, and nothing when ready', () => {
    const dir = root({ 'package.json': manifest })
    const calls: string[] = []
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      calls.push([command, ...args].join(' '))
      // npm install creates the local Playwright package the browser check needs.
      if (command === 'npm') { mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true }); mkdirSync(path.join(dir, 'node_modules/@playwright/test'), { recursive: true }); writeFileSync(path.join(dir, 'node_modules/.bin/playwright'), '') }
      const stdout = args.includes('--dry-run') ? `  Install location:    ${path.join(dir, 'cache/chromium-1243')}\n` : ''
      if (args[2] === 'install' && !args.includes('--dry-run')) mkdirSync(path.join(dir, 'cache/chromium-1243'), { recursive: true })
      return { status: 0, stdout, stderr: '', pid: 1, output: [], signal: null }
    })
    const outcomes = prepareEnvironment([dir], { spawn: spawn as never })
    expect(outcomes.map(outcome => [outcome.command, ...outcome.args].join(' '))).toEqual(['npm install --no-audit --no-fund --loglevel=error', 'npx --no playwright install chromium'])
    expect(outcomes.every(outcome => outcome.ok)).toBe(true)
    expect(outcomes[1]).toMatchObject({ installs: 'Playwright chromium', timeoutMs: 10 * 60_000 })
    calls.length = 0
    expect(prepareEnvironment([dir], { spawn: spawn as never })).toEqual([])
    expect(calls).toEqual(['npx --no playwright install --dry-run chromium'])
  })

  it('retries a browser download that timed out over IPv4, once, and only for Playwright', () => {
    const dir = playwrightRepo()
    const envs: Array<string | undefined> = []
    const spawn = vi.fn((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      if (args.includes('--dry-run')) return { status: 0, stdout: `  Install location:    ${path.join(dir, 'cache/chromium-1243')}\n`, stderr: '', pid: 1, output: [], signal: null }
      envs.push(options.env?.NODE_OPTIONS)
      // A host with an AAAA record but no IPv6 route: only the IPv4-first retry connects.
      return options.env?.NODE_OPTIONS?.includes('specrails-ipv4-first')
        ? { status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null }
        : { status: 1, stdout: '', stderr: 'Error: Request to https://cdn.playwright.dev/builds/x.zip timed out after 30000ms', pid: 1, output: [], signal: null }
    })
    const events: string[] = []
    const [outcome] = prepareEnvironment([dir], { spawn: spawn as never, onEvent: event => { if (event.text) events.push(event.text) } })
    expect(outcome).toMatchObject({ ok: true, installs: 'Playwright chromium' })
    expect(envs).toHaveLength(2)
    expect(envs[1]).toContain('--require')
    expect(existsSync(JSON.parse(envs[1]!.slice(envs[1]!.indexOf('--require') + 10)))).toBe(true)
    expect(events).toContain('Environment: the browser download timed out; retrying npx --no playwright install chromium over IPv4')
    // Other failures are not retried.
    const other = vi.fn((_command: string, args: readonly string[]) => args.includes('--dry-run')
      ? { status: 0, stdout: `  Install location:    ${path.join(dir, 'cache/x')}\n`, stderr: '', pid: 1, output: [], signal: null }
      : { status: 1, stdout: '', stderr: 'ENOSPC: no space left on device', pid: 1, output: [], signal: null })
    expect(prepareEnvironment([dir], { spawn: other as never })[0]).toMatchObject({ ok: false })
    expect(other.mock.calls.filter(([, args]) => !args.includes('--dry-run'))).toHaveLength(1)
  })

  it('never prepares other ecosystems ahead of a failure', () => {
    const dir = root({ 'requirements.txt': 'pytest\n', 'go.mod': 'module x\n' })
    const spawn = vi.fn()
    expect(prepareEnvironment([dir], { spawn: spawn as never })).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })
})
