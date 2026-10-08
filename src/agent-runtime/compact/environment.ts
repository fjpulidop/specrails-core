// Environment repair for the small-model (compact) runtime.
//
// A greenfield repository built by the developer has manifests but no
// installed dependencies, so every verification command fails for reasons the
// model cannot fix by editing code ("jest: command not found", exit 127,
// "Cannot find module", ModuleNotFoundError…). Feeding that back as review
// feedback makes a small model "correct" healthy code until the attempt budget
// is gone. The host owns the environment: it recognises these signatures,
// installs once per ecosystem, and only then hands a real failure to the model.
import type { spawnSync, SpawnSyncReturns } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// npm/pnpm/yarn are `.cmd` shims on Windows: a bare `spawnSync('npm')` is
// ENOENT there, which read as an environment failure of its own and sent the
// install/check round in circles. cross-spawn resolves the shim on every OS.
const defaultSpawn: typeof spawnSync = crossSpawn.sync as unknown as typeof spawnSync

/** `timeoutMs` overrides the default bound for one plan (a browser download is far larger than a dependency install). */
export interface EnvironmentInstall { ecosystem: 'node' | 'python' | 'go' | 'rust'; root: string; command: string; args: string[]; timeoutMs?: number; installs?: string }
/** `precondition`: the install failed for a reason only the host can repair (see hostPreconditionFailure). */
export interface InstallOutcome extends EnvironmentInstall { ok: boolean; detail: string; precondition?: string }

export type HostPreconditionKind = 'network' | 'credential' | 'environment-variable' | 'toolchain' | 'setup' | 'environment'
export interface HostPrecondition { kind: HostPreconditionKind; reason: string; requiredAction: string }

// A Playwright test run on a host whose browser cache was never populated (a
// fresh machine, a new Playwright version): the package is installed, the
// browser build it pins is not. `playwright install` is the documented fix.
const PLAYWRIGHT_SIGNATURES: RegExp[] = [
  /browserType\.launch: Executable doesn't exist at/i,
  /Looks like Playwright was just installed or updated/i,
  /ms-playwright[\\/](?:chromium|firefox|webkit|chromium_headless_shell)[-_]\d+/i,
]
/** True when a verification failure names a missing Playwright browser build. */
export function isPlaywrightBrowserFailure(output: string): boolean {
  const tail = output.slice(-6000)
  return PLAYWRIGHT_SIGNATURES.some(pattern => pattern.test(tail))
}
/** The browser the missing build path names (`chromium_headless_shell-1243` → `chromium`), undefined when none is parsable. */
export function playwrightBrowser(output: string): 'chromium' | 'firefox' | 'webkit' | undefined {
  const match = /ms-playwright[\\/](chromium|firefox|webkit|chromium_headless_shell)[-_]\d+/i.exec(output.slice(-6000))
  if (!match) return undefined
  const name = match[1]!.toLowerCase()
  return name === 'chromium_headless_shell' ? 'chromium' : name as 'chromium' | 'firefox' | 'webkit'
}

const ENVIRONMENT_SIGNATURES: RegExp[] = [
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /\bENOENT\b.*\b(?:spawn|npm|npx|node|pnpm|yarn|pytest|python3?|go|cargo)\b/i,
  /Cannot find module '(?!\.{1,2}\/)/i,
  /Cannot find package '/i,
  /ModuleNotFoundError: No module named/i,
  /No module named/i,
  /npm ERR! (?:missing|404|code ENOENT)/i,
  /error: could not find `.*` in registry|failed to load manifest for dependency/i,
  /cannot find package ".*" in any of/i,
  /jest: not found|vitest: not found|mocha: not found|tsc: not found|pytest: not found/i,
  /TS2582|Do you need to install type definitions|Try `npm i --save-dev @types\//i,
  /Module (?:[\w@./-]+) in the \w+ option was not found|Preset [\w@./-]+ not found|Cannot find module '(?:ts-jest|babel-jest|@swc\/jest|ts-node|tsx)'/i,
  // Yarn Berry refuses to run scripts in a checkout that was never installed.
  /doesn't seem to have been installed - running an install there might help|Couldn't find the node_modules state file - running an install might help/i,
  ...PLAYWRIGHT_SIGNATURES,
]

/** True when a verification failure looks like a missing toolchain/dependency rather than a code defect. */
export function isEnvironmentFailure(exitCode: number | null | undefined, output: string): boolean {
  if (exitCode === 127) return true
  const tail = output.slice(-6000)
  return ENVIRONMENT_SIGNATURES.some(pattern => pattern.test(tail))
}

const REGISTRY = String.raw`(?:registry|npmjs\.org|yarnpkg\.com|npm\.pkg\.github\.com|pkgs\.dev\.azure\.com|jfrog|artifactory|nexus|pypi\.org|crates\.io|proxy\.golang\.org)`
/**
 * Failures that no edit to the change can repair, because the verification
 * process itself lacks something only the host can grant: an environment
 * variable a configuration file references, registry credentials, registry
 * network access, git credentials for a dependency. Feeding them to a fixer
 * makes it edit package-manager configuration to route around the missing
 * secret (observed: `.yarnrc.yml` rewritten, reverted by review, rewritten
 * again). Returns a short host-facing reason, or undefined.
 */
export function hostPreconditionFailure(output: string): string | undefined {
  return hostPrecondition(output)?.reason
}
/** The blocker kind the matched precondition belongs to; undefined when the output is not a host precondition. */
export function hostPreconditionKind(output: string): HostPreconditionKind | undefined {
  return hostPrecondition(output)?.kind
}
const PLAYWRIGHT_CDN = String.raw`(?:cdn\.playwright\.dev|playwright\.azureedge\.net|playwright-akamai\.azureedge\.net|playwright-verizon\.azureedge\.net)`
/** Classifies a host precondition with its kind, host-facing reason and the action that unblocks it. */
export function hostPrecondition(output: string): HostPrecondition | undefined {
  const text = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').slice(-16_000)
  const variable = /Environment variable not found \(([A-Za-z_][A-Za-z0-9_]*)\)/.exec(text)
  if (variable) return { kind: 'environment-variable', reason: `the environment variable ${variable[1]} is not available to verification commands, and a package-manager configuration file requires it`,
    requiredAction: `Make ${variable[1]} available to Specrails (for example in the login shell profile it loads), then retry the run.` }
  if (/\bYN0041\b/.test(text) || /YN0035[\s\S]{0,400}?Response Code: 40[13]\b/.test(text) || /Response code 40[13] \((?:Unauthorized|Forbidden)\)/i.test(text)
    || /npm (?:ERR!|error) code (?:E401|E403|ENEEDAUTH)\b/.test(text) || /ERR_PNPM_FETCH_40[13]\b/.test(text)
    || new RegExp(String.raw`\b40[13] (?:Unauthorized|Forbidden)\b[^\n]{0,80}https?://[^\s]*${REGISTRY}`, 'i').test(text)
    || /\b(?:401|403) Client Error: (?:Unauthorized|Forbidden) for url/.test(text)) return { kind: 'credential', reason: 'the package registry rejected the credentials available to verification commands (HTTP 401/403)',
    requiredAction: 'Refresh the registry credentials Specrails can use (for example a new token in the login shell profile it loads), then retry the run.' }
  // The browser download is checked before registry reachability: its CDN is
  // not a package registry, and the fix is a different command.
  if (/Failed to download (?:Chrome for Testing|Chromium|Firefox|WebKit|chromium|firefox|webkit|FFMPEG|ffmpeg)\b/i.test(text)
    || new RegExp(String.raw`Error: (?:getaddrinfo ENOTFOUND|connect ETIMEDOUT|connect ECONNREFUSED|ECONNRESET|ETIMEDOUT)[^\n]{0,300}${PLAYWRIGHT_CDN}`, 'i').test(text)) return { kind: 'network', reason: 'the Playwright browser download cannot reach its CDN from the verification environment',
    requiredAction: 'Download the Playwright browsers with network access (`npx playwright install`), then retry the run.' }
  if (/npm (?:ERR!|error) code (?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\b/.test(text) || /ERR_PNPM_META_FETCH_FAIL\b/.test(text)
    || new RegExp(String.raw`\b(?:ENOTFOUND|EAI_AGAIN)\b[^\n]{0,200}${REGISTRY}|${REGISTRY}[^\n]{0,200}\b(?:ENOTFOUND|EAI_AGAIN)\b`, 'i').test(text)) return { kind: 'network', reason: 'the package registry cannot be reached from the verification environment',
    requiredAction: 'Give the verification environment network access to the package registry, then retry the run.' }
  if (/fatal: could not read (?:Username|Password) for/.test(text) || /Permission denied \(publickey\)/.test(text)) return { kind: 'credential', reason: 'git credentials needed to fetch a dependency are not available to verification commands',
    requiredAction: 'Make the git credentials that fetch the dependency (an SSH key or credential helper) available to Specrails, then retry the run.' }
  return undefined
}

/** Packages a failure output names explicitly (`Try \`npm i --save-dev @types/jest\``); the host installs exactly those. */
export function suggestedPackages(output: string): string[] {
  const packages = new Set<string>()
  for (const match of output.matchAll(/npm i(?:nstall)? (?:--save-dev |-D )?((?:@[\w-]+\/)?[\w.-]+)/g)) if (match[1]) packages.add(match[1])
  // Jest names the missing transform/preset module itself.
  for (const match of output.matchAll(/Module ((?:@[\w-]+\/)?[\w.-]+) in the \w+ option was not found|Preset ((?:@[\w-]+\/)?[\w.-]+) not found/g)) { const name = match[1] ?? match[2]; if (name) { packages.add(name); if (name === 'ts-jest') packages.add('typescript') } }
  return [...packages].slice(0, 5)
}
/** Dependencies package.json declares that node_modules does not hold (bounded). */
export function missingNodeDependencies(root: string): string[] {
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown> } catch { return [] }
  const declared = new Set<string>()
  for (const field of ['dependencies', 'devDependencies']) {
    const block = manifest[field]
    if (block && typeof block === 'object') for (const name of Object.keys(block as object)) declared.add(name)
  }
  return [...declared].filter(name => !existsSync(path.join(root, 'node_modules', name))).slice(0, 20)
}
/** Browser builds are ~150 MB each; the default 5-minute install bound is too short on a slow link. */
const PLAYWRIGHT_INSTALL_TIMEOUT_MS = 10 * 60_000
/** True when package.json declares `@playwright/test` or `playwright`; only those repositories get a browser install plan. */
function declaresPlaywright(root: string): boolean {
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown> } catch { return false }
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some(field => {
    const block = manifest[field]
    return !!block && typeof block === 'object' && ['@playwright/test', 'playwright'].some(name => Object.hasOwn(block as object, name))
  })
}
/** The installs a repository root needs, judged from its manifests and the absence of their install output. */
export function plannedInstalls(root: string, failureOutput = ''): EnvironmentInstall[] {
  const plans: EnvironmentInstall[] = []
  const suggested = suggestedPackages(failureOutput)
  if (suggested.length && existsSync(path.join(root, 'package.json'))) {
    const runner = existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm'
    plans.push({ ecosystem: 'node', root, command: runner, args: runner === 'npm' ? ['install', '--save-dev', '--no-audit', '--no-fund', '--loglevel=error', ...suggested] : runner === 'yarn' ? ['add', '--dev', ...suggested] : ['add', '-D', ...suggested] })
  }
  const has = (file: string): boolean => existsSync(path.join(root, file))
  // A manifest edited after the first install (a later task group adds
  // jest-extended) leaves node_modules present but incomplete; verify then
  // fails on the environment, not the code. Declared-but-absent ⇒ reinstall.
  if (has('package.json') && (!has('node_modules') || missingNodeDependencies(root).length)) {
    const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm'
    plans.push({ ecosystem: 'node', root, command: runner, args: runner === 'npm' ? ['install', '--no-audit', '--no-fund', '--loglevel=error'] : ['install'] })
  }
  // After the dependency plan: a fresh worktree needs node_modules before
  // `playwright install` can run at all.
  if (isPlaywrightBrowserFailure(failureOutput) && declaresPlaywright(root)) {
    const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npx'
    const browser = playwrightBrowser(failureOutput)
    plans.push({ ecosystem: 'node', root, command: runner, args: [...(runner === 'pnpm' ? ['exec'] : []), 'playwright', 'install', ...(browser ? [browser] : [])],
      timeoutMs: PLAYWRIGHT_INSTALL_TIMEOUT_MS, installs: `Playwright ${browser ?? 'browsers'}` })
  }
  if ((has('requirements.txt') || has('pyproject.toml')) && !has('.venv') && !has('venv')) {
    const python = process.platform === 'win32' ? 'python' : 'python3'
    plans.push({ ecosystem: 'python', root, command: python, args: has('requirements.txt') ? ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'] : ['-m', 'pip', 'install', '-q', '-e', '.'] })
  }
  if (has('go.mod')) plans.push({ ecosystem: 'go', root, command: 'go', args: ['mod', 'download'] })
  if (has('Cargo.toml') && !has('target')) plans.push({ ecosystem: 'rust', root, command: 'cargo', args: ['fetch'] })
  return plans
}

/** Rewrites an exact, unpublished version in package.json to `^<major>.0.0`; true when something changed. */
function relaxManifestPin(root: string, name: string, version: string): boolean {
  const file = path.join(root, 'package.json')
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return false }
  const major = /^v?(\d+)/.exec(version)?.[1]
  let changed = false
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = manifest[field]
    if (!block || typeof block !== 'object') continue
    const deps = block as Record<string, unknown>
    if (deps[name] === version || deps[name] === `=${version}`) { deps[name] = major ? `^${major}.0.0` : 'latest'; changed = true }
  }
  if (changed) writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  return changed
}

/** Runs each planned install once, bounded; never throws. */
export interface InstallIo { spawn?: typeof spawnSync; timeoutMs?: number; failureOutput?: string; lockfileRepair?: boolean; onEvent?: (event: { kind: 'tool-start' | 'tool-end' | 'text'; tool?: string; detail?: string; text?: string }) => void
  /** The installs for one root; the failure-driven plan by default. */
  plan?: (root: string) => EnvironmentInstall[] }
export function installEnvironment(roots: readonly string[], io: InstallIo = {}): InstallOutcome[] {
  const spawn = io.spawn ?? defaultSpawn
  const outcomes: InstallOutcome[] = []
  for (const root of roots) {
    for (const plan of io.plan ? io.plan(root) : plannedInstalls(root, io.failureOutput ?? '')) {
      io.onEvent?.({ kind: 'tool-start', tool: plan.command, detail: `${plan.args.join(' ')} (${path.basename(root)})` })
      const run = (): SpawnSyncReturns<string> => {
        try { return spawn(plan.command, plan.args, { cwd: root, encoding: 'utf8', timeout: plan.timeoutMs ?? io.timeoutMs ?? 5 * 60_000, windowsHide: true, env: process.env }) }
        catch (error) { return { status: null, error: error as Error, stdout: '', stderr: '', pid: 0, output: [], signal: null } }
      }
      let result = run()
      // A model that writes package-lock.json by hand invents integrity hashes
      // (npm EINTEGRITY) or pins versions that never existed (ETARGET/E404 on a
      // locked entry). The lock is not candidate content: drop it and let npm
      // resolve the manifest once more.
      const lock = plan.ecosystem === 'node' ? ['package-lock.json', 'npm-shrinkwrap.json'].map(name => path.join(root, name)).find(file => existsSync(file)) : undefined
      if (io.lockfileRepair !== false && result.status !== 0 && lock && /EINTEGRITY|ETARGET|E404|ENOTCACHED|Invalid: lock file/.test(String(result.stderr))) {
        try { unlinkSync(lock) } catch { /* the retry below then repeats the failure honestly */ }
        io.onEvent?.({ kind: 'text', text: `Environment: ${path.basename(lock)} did not match the registry; removed it and retrying ${plan.command} ${plan.args.join(' ')}` })
        result = run()
      }
      // A pin the registry has never published ("No matching version found for
      // @babel/preset-env@7.23.0"): the model invented the version. Relax that
      // one dependency to the caret of its major and retry once.
      const unpublished = plan.ecosystem === 'node' && result.status !== 0 ? /No matching version found for ((?:@[\w.-]+\/)?[\w.-]+)@([^\s.]+(?:\.[^\s.]+)*)\.?(?:\n|$)/.exec(String(result.stderr)) : null
      if (unpublished && relaxManifestPin(root, unpublished[1]!, unpublished[2]!)) {
        io.onEvent?.({ kind: 'text', text: `Environment: ${unpublished[1]}@${unpublished[2]} is not published; relaxed the pin in package.json and retrying ${plan.command} ${plan.args.join(' ')}` })
        result = run()
      }
      // Playwright's downloader tries IPv6 first; on a host whose DNS returns
      // an AAAA record without an IPv6 route, Node's family auto-selection
      // times the request out before IPv4 is tried. Retry once preferring IPv4.
      if (result.status !== 0 && plan.installs?.startsWith('Playwright') && NETWORK_TIMEOUT.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
        const preload = ipv4FirstPreload()
        if (preload) {
          io.onEvent?.({ kind: 'text', text: `Environment: the browser download timed out; retrying ${plan.command} ${plan.args.join(' ')} over IPv4` })
          try { result = spawn(plan.command, plan.args, { cwd: root, encoding: 'utf8', timeout: plan.timeoutMs ?? io.timeoutMs ?? 5 * 60_000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim() } }) }
          catch (error) { result = { status: null, error: error as Error, stdout: '', stderr: '', pid: 0, output: [], signal: null } }
        }
      }
      io.onEvent?.({ kind: 'tool-end', tool: plan.command })
      const ok = result.status === 0
      const detail = ok ? `installed ${plan.installs ?? `${plan.ecosystem} dependencies`} in ${path.basename(root)}` : `${plan.command} ${plan.args.join(' ')} failed in ${path.basename(root)}: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 400)}`
      io.onEvent?.({ kind: 'text', text: `Environment: ${detail}` })
      const precondition = ok ? undefined : hostPreconditionFailure(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
      outcomes.push({ ...plan, ok, detail, ...(precondition ? { precondition } : {}) })
    }
  }
  return outcomes
}

const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.mts', 'playwright.config.cts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']
type PlaywrightBrowser = 'chromium' | 'firefox' | 'webkit'
/** Browsers the repository's Playwright config runs (by project names, devices or browserName); chromium when it names none. */
export function configuredPlaywrightBrowsers(root: string): PlaywrightBrowser[] {
  const file = PLAYWRIGHT_CONFIGS.map(name => path.join(root, name)).find(candidate => existsSync(candidate))
  let source = ''
  try { if (file) source = readFileSync(file, 'utf8').slice(0, 200_000) } catch { /* unreadable config: the default browser */ }
  const browsers: PlaywrightBrowser[] = []
  if (/\b(?:chromium|chrome|edge|pixel|galaxy)\b/i.test(source)) browsers.push('chromium')
  if (/\bfirefox\b/i.test(source)) browsers.push('firefox')
  if (/\b(?:webkit|safari|iphone|ipad)\b/i.test(source)) browsers.push('webkit')
  return browsers.length ? browsers : ['chromium']
}
/** How to run the repository's own Playwright CLI; undefined until its package is installed (never downloads one). */
function playwrightCli(root: string): { command: string; args: string[] } | undefined {
  const bin = path.join(root, 'node_modules', '.bin')
  if (!['playwright', 'playwright.cmd'].some(name => existsSync(path.join(bin, name)))) return undefined
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return { command: 'pnpm', args: ['exec', 'playwright'] }
  if (existsSync(path.join(root, 'yarn.lock'))) return { command: 'yarn', args: ['playwright'] }
  return { command: 'npx', args: ['--no', 'playwright'] }
}
/**
 * The configured browsers when any build the installed Playwright pins is
 * missing from the host cache. `install --dry-run` names the exact install
 * locations without downloading; an unreadable answer means "unknown", never
 * an install.
 */
export function missingPlaywrightBrowsers(root: string, spawn: typeof spawnSync = defaultSpawn): PlaywrightBrowser[] {
  if (!declaresPlaywright(root)) return []
  const cli = playwrightCli(root)
  if (!cli) return []
  const browsers = configuredPlaywrightBrowsers(root)
  let result: SpawnSyncReturns<string>
  try { result = spawn(cli.command, [...cli.args, 'install', '--dry-run', ...browsers], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true, env: process.env }) }
  catch { return [] }
  if (result.status !== 0) return []
  const locations = [...String(result.stdout ?? '').matchAll(/Install location:\s+(.+?)\s*$/gm)].map(match => match[1]!)
  return locations.length && locations.some(location => !existsSync(location)) ? browsers : []
}

/**
 * Host preparation before an agent edits a repository: the dependencies its
 * manifest declares but are not installed, then the browser builds its
 * Playwright pins. Agents run sandboxed (Codex cannot write the browser cache
 * or reach it at all), so what they need must already be there. Only cheap,
 * idempotent, project-local work happens here; other ecosystems keep their
 * failure-driven repair at verification.
 */
export function prepareEnvironment(roots: readonly string[], io: Omit<InstallIo, 'plan' | 'failureOutput'> = {}): InstallOutcome[] {
  const spawn = io.spawn ?? defaultSpawn
  const dependencies = installEnvironment(roots, { ...io, plan: root => plannedInstalls(root).filter(plan => plan.ecosystem === 'node') })
  const browsers = installEnvironment(roots, { ...io, plan: root => {
    const missing = missingPlaywrightBrowsers(root, spawn)
    const cli = missing.length ? playwrightCli(root) : undefined
    return cli ? [{ ecosystem: 'node', root, command: cli.command, args: [...cli.args, 'install', ...missing], timeoutMs: PLAYWRIGHT_INSTALL_TIMEOUT_MS, installs: `Playwright ${missing.join(', ')}` }] : []
  } })
  return [...dependencies, ...browsers]
}

const NETWORK_TIMEOUT = /timed out after \d+ ?ms|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i
/**
 * A Node preload that answers IPv6 lookups with nothing when the host has an
 * IPv4 address, so dual-stack clients connect over IPv4. Written once to the
 * temp directory; undefined when it cannot be written.
 */
export function ipv4FirstPreload(): string | undefined {
  const file = path.join(tmpdir(), 'specrails-ipv4-first-v1.cjs')
  if (existsSync(file)) return file
  try {
    writeFileSync(file, [
      "const dns = require('node:dns')",
      'const lookup = dns.promises.lookup.bind(dns.promises)',
      'dns.promises.lookup = async (hostname, options) => {',
      "  const family = typeof options === 'number' ? options : options && options.family",
      '  if (family === 6) {',
      '    const v4 = await lookup(hostname, { all: true, family: 4 }).catch(() => [])',
      "    if (v4.length) { if (options && typeof options === 'object' && options.all) return []; throw Object.assign(new Error('IPv6 skipped: ' + hostname), { code: 'ENOTFOUND' }) }",
      '  }',
      '  return lookup(hostname, options)',
      '}',
      '',
    ].join('\n'))
    return file
  } catch { return undefined }
}

/** The repository's own test command, judged from its manifest (npm/pnpm/yarn `test` script, pytest, go, cargo); undefined when none. */
export function detectCheckCommand(root: string): { command: string; args: string[] } | undefined {
  const has = (file: string): boolean => existsSync(path.join(root, file))
  if (has('package.json')) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
      const test = manifest.scripts?.test
      if (test && !/no test specified/i.test(test)) {
        const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm'
        return { command: runner, args: runner === 'npm' ? ['test', '--silent'] : ['test'] }
      }
    } catch { /* fall through */ }
  }
  if (has('pytest.ini') || has('pyproject.toml') || has('setup.cfg') || has('tests') && has('requirements.txt')) return { command: process.platform === 'win32' ? 'python' : 'python3', args: ['-m', 'pytest', '-q', '-x'] }
  if (has('go.mod')) return { command: 'go', args: ['test', './...'] }
  if (has('Cargo.toml')) return { command: 'cargo', args: ['test', '-q'] }
  return undefined
}

interface GroupCheckOutcome { ran: boolean; ok: boolean; command?: string; output: string; timedOut?: boolean }
/**
 * Runs the repository's test command once, bounded (default 3 min, killed on
 * timeout), returning the bounded output tail. Used between developer task
 * groups (`verify-per-group`) so a broken group is fixed while its context is
 * still fresh instead of surfacing as five failed suites at the end.
 */
export function runGroupCheck(roots: readonly string[], io: { spawn?: typeof spawnSync; timeoutMs?: number; onEvent?: (event: { kind: 'tool-start' | 'tool-end' | 'text'; tool?: string; detail?: string; text?: string }) => void } = {}): GroupCheckOutcome {
  const spawn = io.spawn ?? defaultSpawn
  for (const root of roots) {
    const check = detectCheckCommand(root)
    if (!check) continue
    const label = `${check.command} ${check.args.join(' ')}`
    io.onEvent?.({ kind: 'tool-start', tool: check.command, detail: `${check.args.join(' ')} (${path.basename(root)}, group check)` })
    let result: SpawnSyncReturns<string>
    try { result = spawn(check.command, check.args, { cwd: root, encoding: 'utf8', timeout: io.timeoutMs ?? 3 * 60_000, killSignal: 'SIGKILL', windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, maxBuffer: 8 * 1024 * 1024 }) }
    catch (error) { result = { status: null, error: error as Error, stdout: '', stderr: '', pid: 0, output: [], signal: null } }
    io.onEvent?.({ kind: 'tool-end', tool: check.command })
    const timedOut = result.error?.message?.includes('ETIMEDOUT') || result.signal === 'SIGKILL'
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-6000)
    return { ran: true, ok: result.status === 0 && !timedOut, command: label, output: timedOut ? `${output}\n[group check timed out after ${Math.round((io.timeoutMs ?? 180_000) / 1000)} s and was killed]` : output, timedOut }
  }
  return { ran: false, ok: true, output: '' }
}
