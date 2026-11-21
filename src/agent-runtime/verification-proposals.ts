// Which agent-proposed verification commands the host adds to its plan.
//
// A repository without configured checks takes the proposals as its checks
// (validated like any configured command). A repository with configured
// checks keeps them and may gain only runs of a package script the
// repository itself declares, such as `npm run test:e2e`: a change whose
// acceptance needs browser or integration tests then gets host evidence for
// them, without the agent introducing arbitrary commands next to the
// configured ones. The same holds for a script file the repository holds
// (`python3.11 scripts/check_startup.py`, `bash scripts/smoke.sh`): a Python
// or shell project has no package scripts, and its acceptance check (for
// example a real-container startup) would otherwise never get host evidence.
// Finally, a repository's own toolchain may build or test what it already
// holds (`xcodebuild … build`, `cargo test --manifest-path src-tauri/Cargo.toml`,
// `swift build`, `go vet ./...`, `node --check web/main.js`): those run the
// repository's manifests like the configured check does, so refusing them
// only left a reviewer asking for evidence the host would never produce.
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { ACCEPTANCE_SCRIPT_TIMEOUT_MS, type PipelineContext, type VerificationCommand } from '../pipeline/pipeline-state.js'

/** The package script a command runs (`npm test`, `npm run x`, `pnpm [run] x`, `yarn [run] x`), when it runs exactly one with no extra arguments. */
export function packageScriptOf(command: Pick<VerificationCommand, 'command' | 'args'>): string | undefined {
  const [first, second, ...rest] = command.args
  if (command.command === 'npm') {
    if (first === 'test' && second === undefined) return 'test'
    if ((first === 'run' || first === 'run-script') && second && !rest.length) return second
    return undefined
  }
  if (command.command === 'pnpm' || command.command === 'yarn') {
    if (first === 'run' && second && !rest.length) return second
    if (first && second === undefined && !first.startsWith('-')) return first
  }
  return undefined
}

/** Interpreters that run one repository file; the file decides what runs, the interpreter adds nothing. */
const SCRIPT_INTERPRETER = /^(?:(?:\.venv|venv)\/bin\/)?(?:python(?:\d+(?:\.\d+)?)?|node|bash|sh|ruby|php)$/

/**
 * True when the command runs a file inside the repository with a plain interpreter
 * (`python3.11 scripts/x.py --flag`). The file must exist when verification runs and
 * stay inside the repository; interpreter options (`-c`, `-m`, `-e`) are refused.
 */
export function runsRepositoryScript(repositoryRoot: string, command: Pick<VerificationCommand, 'command' | 'args' | 'cwd'>): boolean {
  if (!SCRIPT_INTERPRETER.test(command.command)) return false
  const [file] = command.args
  if (!file || file.startsWith('-') || path.isAbsolute(file)) return false
  const root = path.resolve(repositoryRoot)
  const target = path.resolve(root, command.cwd ?? '.', file)
  const inside = path.relative(root, target)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return false
  try { return existsSync(target) && statSync(target).isFile() } catch { return false }
}

/** A path argument that must name an existing file inside the repository (relative to the command's cwd). */
function repositoryFile(repositoryRoot: string, cwd: string | undefined, file: string | undefined): boolean {
  if (!file || file.startsWith('-') || path.isAbsolute(file)) return false
  const root = path.resolve(repositoryRoot)
  const inside = path.relative(root, path.resolve(root, cwd ?? '.', file))
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return false
  try { return statSync(path.resolve(root, inside)).isFile() } catch { return false }
}

/** Options whose value is a path that has to stay inside the repository. */
const PATH_OPTIONS = new Set(['--manifest-path', '--package-path', '-project', '-workspace', '-C', '--project-directory', '-f', '--file'])
/** Options that publish, sign, install, archive or change toolchains: never a verification. */
const REFUSED_OPTIONS = /^(?:-exportArchive|-exportLocalizations|-allowProvisioningUpdates|-allowProvisioningDeviceRegistration|--publish|--release-publish|-o|--output|--out-dir|--target-dir|--config|-Z|\+.*)$/

/**
 * Build/test verbs of the toolchains a repository commonly declares, keyed by executable.
 * Each verb only compiles, type-checks, lints or tests what the checkout holds.
 */
const TOOLCHAIN_VERBS: Readonly<Record<string, readonly string[]>> = {
  cargo: ['test', 'build', 'check', 'clippy'],
  swift: ['build', 'test'],
  xcodebuild: ['build', 'test', 'build-for-testing', 'test-without-building', 'analyze'],
  go: ['test', 'vet', 'build'],
  flutter: ['test', 'analyze'],
  dart: ['test', 'analyze'],
}

/**
 * True when the command builds or tests the repository with its own toolchain: a known
 * executable, one of its build/test verbs, no publishing/signing/output-redirecting option,
 * and every path option pointing inside the repository. `node --check <file>` and
 * `node --test [files]` qualify for files the repository holds; `docker compose config`
 * (a read-only validation of the compose file) does too.
 */
export function runsToolchainCheck(repositoryRoot: string, command: Pick<VerificationCommand, 'command' | 'args' | 'cwd'>): boolean {
  const { args } = command
  if (args.some(arg => REFUSED_OPTIONS.test(arg))) return false
  for (let index = 0; index < args.length; index++) {
    const option = args[index].split('=')[0]
    if (!PATH_OPTIONS.has(option)) continue
    const value = args[index].includes('=') ? args[index].slice(option.length + 1) : args[index + 1]
    const root = path.resolve(repositoryRoot)
    const target = value === undefined ? undefined : path.relative(root, path.resolve(root, command.cwd ?? '.', value))
    if (target === undefined || target.startsWith('..') || path.isAbsolute(target) || !existsSync(path.resolve(root, target))) return false
  }
  if (command.command === 'node') {
    if (args[0] === '--check') return args.length === 2 && repositoryFile(repositoryRoot, command.cwd, args[1])
    if (args[0] === '--test') return args.slice(1).every(arg => repositoryFile(repositoryRoot, command.cwd, arg))
    return false
  }
  if (command.command === 'docker') {
    if (args[0] !== 'compose' || args[args.length - 1] !== 'config') return false
    const middle = args.slice(1, -1)
    return middle.every((arg, index) => arg === '-q' || arg === '--quiet' || arg === '-f' || arg === '--file' || middle[index - 1] === '-f' || middle[index - 1] === '--file')
  }
  const verbs = TOOLCHAIN_VERBS[command.command]
  if (!verbs) return false
  return args.some(arg => verbs.includes(arg)) && !args.some(arg => ['archive', 'install', 'publish', 'run', 'login', 'upload', 'exportArchive', 'clean'].includes(arg))
}

function declaresScript(directory: string, script: string): boolean {
  const file = path.join(directory, 'package.json')
  if (!existsSync(file)) return false
  try {
    const scripts = (JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, unknown> }).scripts
    return !!scripts && typeof scripts[script] === 'string'
  } catch { return false }
}

const planKey = (command: VerificationCommand): string => JSON.stringify([command.repositoryId, command.cwd ?? '', command.command, command.args])

/**
 * The proposals to append to `planned` (already scope-defaulted). `normalize`
 * applies the caller's scope default; proposals are expected to be
 * structurally valid.
 */
export function admitVerificationProposals(context: PipelineContext, planned: readonly VerificationCommand[], proposals: readonly VerificationCommand[], normalize: (command: VerificationCommand) => VerificationCommand): VerificationCommand[] {
  const configured = new Set(planned.map(command => command.repositoryId))
  const seen = new Set(planned.map(planKey))
  const admitted: VerificationCommand[] = []
  for (const raw of proposals) {
    const repository = context.repositories.find(repo => repo.id === raw.repositoryId)
    if (!repository) continue
    const command = normalize(raw)
    if (configured.has(raw.repositoryId)) {
      const script = packageScriptOf(command)
      const packageScript = !!script && declaresScript(path.resolve(repository.path, command.cwd ?? '.'), script)
      if (!packageScript && !runsRepositoryScript(repository.path, command) && !runsToolchainCheck(repository.path, command)) continue
    }
    const key = planKey(command)
    if (seen.has(key)) continue
    seen.add(key)
    // A repository script is an acceptance check (a container build, a restart): it gets the longer
    // limit. Tests and package scripts keep the ordinary default.
    admitted.push(command.timeoutMs === undefined && runsRepositoryScript(repository.path, command) ? { ...command, timeoutMs: ACCEPTANCE_SCRIPT_TIMEOUT_MS } : command)
  }
  return admitted
}
