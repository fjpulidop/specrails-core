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
import path from 'node:path'

// npm/pnpm/yarn are `.cmd` shims on Windows: a bare `spawnSync('npm')` is
// ENOENT there, which read as an environment failure of its own and sent the
// install/check round in circles. cross-spawn resolves the shim on every OS.
const defaultSpawn: typeof spawnSync = crossSpawn.sync as unknown as typeof spawnSync

interface EnvironmentInstall { ecosystem: 'node' | 'python' | 'go' | 'rust'; root: string; command: string; args: string[] }
interface InstallOutcome extends EnvironmentInstall { ok: boolean; detail: string }

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
]

/** True when a verification failure looks like a missing toolchain/dependency rather than a code defect. */
export function isEnvironmentFailure(exitCode: number | null | undefined, output: string): boolean {
  if (exitCode === 127) return true
  const tail = output.slice(-6000)
  return ENVIRONMENT_SIGNATURES.some(pattern => pattern.test(tail))
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
export function installEnvironment(roots: readonly string[], io: { spawn?: typeof spawnSync; timeoutMs?: number; failureOutput?: string; lockfileRepair?: boolean; onEvent?: (event: { kind: 'tool-start' | 'tool-end' | 'text'; tool?: string; detail?: string; text?: string }) => void } = {}): InstallOutcome[] {
  const spawn = io.spawn ?? defaultSpawn
  const outcomes: InstallOutcome[] = []
  for (const root of roots) {
    for (const plan of plannedInstalls(root, io.failureOutput ?? '')) {
      io.onEvent?.({ kind: 'tool-start', tool: plan.command, detail: `${plan.args.join(' ')} (${path.basename(root)})` })
      const run = (): SpawnSyncReturns<string> => {
        try { return spawn(plan.command, plan.args, { cwd: root, encoding: 'utf8', timeout: io.timeoutMs ?? 5 * 60_000, windowsHide: true, env: process.env }) }
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
      io.onEvent?.({ kind: 'tool-end', tool: plan.command })
      const ok = result.status === 0
      const detail = ok ? `installed ${plan.ecosystem} dependencies in ${path.basename(root)}` : `${plan.command} ${plan.args.join(' ')} failed in ${path.basename(root)}: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 400)}`
      io.onEvent?.({ kind: 'text', text: `Environment: ${detail}` })
      outcomes.push({ ...plan, ok, detail })
    }
  }
  return outcomes
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
