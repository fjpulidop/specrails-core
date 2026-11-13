import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Host-measured environment facts every role receives with the repository
 * reference. Roles otherwise guess: a read-only sandbox that cannot reach the
 * Docker socket reported "Docker unavailable" while the host could build
 * images, and checks ran on a system Python several versions newer than the
 * one the project's image targets. The host measures once per checkout (cached
 * briefly); roles are told to trust these facts over older notes.
 */
/** `pinned`: an exact runtime choice (an image, a version file); a range such as `requires-python >=3.11` is not. */
export interface ToolchainTarget { tool: 'python' | 'node'; version: string; source: string; pinned: boolean }
export interface EnvironmentFacts {
  targets: ToolchainTarget[]
  interpreters: Array<{ command: string; version: string | null }>
  virtualEnv: string | null
  docker: { files: string[]; reachable: boolean; server?: string; detail?: string } | null
}

export type ProbeRunner = (command: string, args: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string }
const defaultProbe: ProbeRunner = (command, args, timeoutMs) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
let probe: ProbeRunner = defaultProbe
/** Tests replace the host probe; production always measures the real host. */
export function setEnvironmentProbe(runner: ProbeRunner | null): void { probe = runner ?? defaultProbe; cache.clear() }

const CACHE_MS = 10 * 60_000
const cache = new Map<string, { at: number; facts: EnvironmentFacts }>()

function readSmall(root: string, relative: string): string | undefined {
  try {
    const file = path.join(root, relative)
    const stat = statSync(file)
    return stat.isFile() && stat.size <= 64_000 ? readFileSync(file, 'utf8') : undefined
  } catch { return undefined }
}

/** Dockerfiles at the root and one directory down, plus compose files. */
function containerFiles(root: string): { dockerfiles: string[]; compose: string[] } {
  const dockerfiles: string[] = [], compose: string[] = []
  const isDockerfile = (name: string) => name === 'Dockerfile' || /^Dockerfile\.[\w.-]+$/.test(name) || /\.dockerfile$/i.test(name)
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && isDockerfile(entry.name)) dockerfiles.push(entry.name)
      if (entry.isFile() && /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(entry.name)) compose.push(entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        try { for (const child of readdirSync(path.join(root, entry.name), { withFileTypes: true })) if (child.isFile() && isDockerfile(child.name)) dockerfiles.push(`${entry.name}/${child.name}`) } catch { /* unreadable */ }
      }
    }
  } catch { /* unreadable root */ }
  return { dockerfiles: dockerfiles.sort().slice(0, 12), compose: compose.sort() }
}

/** Toolchain versions the project declares (images, version files, manifests). */
export function toolchainTargets(root: string): ToolchainTarget[] {
  const targets: ToolchainTarget[] = []
  for (const file of containerFiles(root).dockerfiles) {
    for (const match of (readSmall(root, file) ?? '').matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(?:[\w.-]+\/)*(python|node)(?::(\d+(?:\.\d+)?))?[\w.-]*/gim)) {
      if (match[2]) targets.push({ tool: match[1]!.toLowerCase() as 'python' | 'node', version: match[2], source: `${file} FROM ${match[0].trim().replace(/^FROM\s+(?:--platform=\S+\s+)?/i, '')}`, pinned: true })
    }
  }
  const pyproject = readSmall(root, 'pyproject.toml')
  const requires = pyproject && /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)
  if (requires) { const version = /(\d+\.\d+)/.exec(requires[1]!)?.[1]; if (version) targets.push({ tool: 'python', version, source: `pyproject.toml requires-python ${requires[1]}`, pinned: !/[<>~^]|!=/.test(requires[1]!) }) }
  const pythonVersion = readSmall(root, '.python-version')?.trim().split(/\s+/)[0]
  if (pythonVersion && /^\d+\.\d+/.test(pythonVersion)) targets.push({ tool: 'python', version: /^\d+\.\d+/.exec(pythonVersion)![0], source: `.python-version ${pythonVersion}`, pinned: true })
  const runtime = /python-(\d+\.\d+)/.exec(readSmall(root, 'runtime.txt') ?? '')
  if (runtime) targets.push({ tool: 'python', version: runtime[1]!, source: 'runtime.txt', pinned: true })
  for (const file of ['.nvmrc', '.node-version']) {
    const value = readSmall(root, file)?.trim().replace(/^v/, '')
    if (value && /^\d+/.test(value)) targets.push({ tool: 'node', version: /^\d+(?:\.\d+)?/.exec(value)![0], source: `${file} ${value}`, pinned: true })
  }
  for (const line of (readSmall(root, '.tool-versions') ?? '').split('\n')) {
    const match = /^\s*(python|nodejs)\s+(\d+(?:\.\d+)?)/.exec(line)
    if (match) targets.push({ tool: match[1] === 'nodejs' ? 'node' : 'python', version: match[2]!, source: `.tool-versions ${line.trim()}`, pinned: true })
  }
  return targets
}

const versionOf = (text: string): string | null => /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null

/** Measures the host for one checkout; cached briefly so every role turn does not re-probe. */
export function environmentFacts(root: string, now = Date.now()): EnvironmentFacts {
  const cached = cache.get(root)
  if (cached && now - cached.at < CACHE_MS) return cached.facts
  const targets = toolchainTargets(root)
  const { dockerfiles, compose } = containerFiles(root)
  const python = targets.some(target => target.tool === 'python') || ['pyproject.toml', 'requirements.txt', 'setup.py'].some(file => existsSync(path.join(root, file)))
  const node = targets.some(target => target.tool === 'node')
  const commands = [
    ...(python ? ['python3', ...new Set(targets.filter(target => target.tool === 'python' && target.pinned && /^\d+\.\d+$/.test(target.version)).map(target => `python${target.version}`))] : []),
    ...(node ? ['node'] : []),
  ]
  const interpreters = commands.map(command => {
    const result = probe(command, ['--version'], 3000)
    return { command, version: result.status === 0 ? versionOf(result.stdout + result.stderr) : null }
  })
  const virtualEnv = python ? ['.venv', 'venv'].find(dir => existsSync(path.join(root, dir, 'bin', 'python')) || existsSync(path.join(root, dir, 'Scripts', 'python.exe'))) ?? null : null
  let docker: EnvironmentFacts['docker'] = null
  if (dockerfiles.length || compose.length) {
    const result = probe('docker', ['info', '--format', '{{.ServerVersion}}'], 5000)
    const server = result.stdout.trim()
    // `docker info` can exit 0 while printing only a socket error: no version means unreachable.
    docker = result.status === 0 && /^\d/.test(server)
      ? { files: [...compose, ...dockerfiles], reachable: true, server }
      : { files: [...compose, ...dockerfiles], reachable: false, detail: (result.stderr || result.stdout || (result.status === null ? 'docker CLI not found' : 'no server version')).trim().split('\n')[0]!.slice(0, 200) }
  }
  const facts = { targets, interpreters, virtualEnv, docker }
  cache.set(root, { at: now, facts })
  return facts
}

/** `3.14.3` satisfies a `3.14` or `3` pin; `3.14.3` does not satisfy `3.11`. */
const satisfies = (installed: string, pin: string): boolean => installed === pin || installed.startsWith(pin + '.')

/** The facts as lines for the repository reference; empty when nothing applies. */
export function renderEnvironmentFacts(facts: EnvironmentFacts): string[] {
  const lines: string[] = []
  for (const tool of ['python', 'node'] as const) {
    const targets = facts.targets.filter(target => target.tool === tool)
    if (!targets.length) continue
    const versions = [...new Set(targets.map(target => target.version))]
    lines.push(`${tool === 'python' ? 'Python' : 'Node'} target: ${versions.join(' / ')} (${targets.map(target => target.source).join('; ').slice(0, 400)})`)
  }
  const found = facts.interpreters.filter(item => item.version)
  if (facts.interpreters.length) lines.push(`On the host PATH: ${facts.interpreters.map(item => `${item.command} ${item.version ?? 'not found'}`).join(', ')}`)
  const pythonTarget = facts.targets.find(target => target.tool === 'python' && target.pinned)
  const systemPython = facts.interpreters.find(item => item.command === 'python3')?.version ?? null
  if (pythonTarget && systemPython && !satisfies(systemPython, pythonTarget.version)) {
    const exact = found.find(item => item.command === `python${pythonTarget.version}`)
    lines.push(`Bare python3 (${systemPython}) does not match the target ${pythonTarget.version}: run Python checks in a virtual environment built from ${exact ? exact.command : `Python ${pythonTarget.version}`}, not with bare python3. A failure that only the newer interpreter produces is environmental, not caused by the change.`)
  }
  if (facts.targets.some(target => target.tool === 'python') || facts.virtualEnv || facts.interpreters.some(item => item.command.startsWith('python'))) {
    lines.push(facts.virtualEnv ? `Project virtual environment: ${facts.virtualEnv} (use ${facts.virtualEnv}/bin/python).` : 'No project virtual environment (.venv) exists; system Pythons may refuse package installs (PEP 668).')
  }
  if (facts.docker) {
    lines.push(facts.docker.reachable
      ? `Docker: reachable from the host (server ${facts.docker.server}); container files: ${facts.docker.files.join(', ')}. Host verification commands can build and run containers. A read-only or sandboxed role may be denied the Docker socket; that is a sandbox limit, not a host blocker.`
      : `Docker: not reachable from the host (${facts.docker.detail}); container files: ${facts.docker.files.join(', ')}. Container checks fail until the person starts Docker.`)
  }
  return lines.length ? ['Environment facts (measured by the host for this checkout; trust them over older notes, plans or earlier steps):', ...lines.map(line => '- ' + line)] : []
}
