#!/usr/bin/env node
/**
 * specrails-core CLI — thin ESM dispatcher.
 *
 * All installer subcommands (init, update, doctor) execute
 * in-process via the Node installer under dist/installer/. This file
 * only keeps logic that is local to the dispatcher:
 *   - `profile validate` / `profile show` — schema validation via ajv.
 *   - `enrich`                            — launches the installed provider's
 *                                           native enrich workflow.
 *   - `init` TUI short-circuit            — spawns tui-installer.mjs
 *                                           then re-enters init with
 *                                           --from-config.
 *
 * Nothing in this file shells out to bash.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const require_ = createRequire(import.meta.url)

const args = process.argv.slice(2)
const subcommand = args[0]

// ─── Global --version / -V flag ──────────────────────────────────────────────

// Treat version as a GLOBAL flag only when it is the command itself. Offline
// lifecycle commands also carry a required `--version <target>` option; scanning
// the whole argv would intercept `swap-current --version 4.12.0` here and exit 0
// without ever validating or moving the framework pointer.
if (subcommand === '--version' || subcommand === '-V') {
  const pkg = require_(path.resolve(ROOT, 'package.json'))
  console.log(`specrails-core v${pkg.version}`)
  process.exit(0)
}

// ─── Usage screen (no subcommand) ────────────────────────────────────────────

if (!subcommand) {
  printUsage()
  process.exit(0)
}

// ─── Subcommand allowlist (kept for backwards compatibility) ─────────────────

const KNOWN_SUBCOMMANDS = new Set([
  'init',
  'update',
  'doctor',
  'install-framework',
  'swap-current',
  'assemble',
  'enrich',
  'version',
  'profile',
  'help',
])

if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
  console.error(`Unknown command: ${subcommand}\n`)
  console.error(
    'Available commands: init, update, doctor, install-framework, swap-current, assemble, enrich, version, profile, help',
  )
  process.exit(1)
}

const subargs = args.slice(1)

// ─── help / version handled by the dispatcher ────────────────────────────────

if (subcommand === 'help') {
  printUsage()
  process.exit(0)
}

if (subcommand === 'version') {
  const pkg = require_(path.resolve(ROOT, 'package.json'))
  console.log(`specrails-core v${pkg.version}`)
  process.exit(0)
}

// ─── profile validate / show ─────────────────────────────────────────────────
// Pure Node logic; no installer touch.

if (subcommand === 'profile') {
  await runProfile(subargs)
  process.exit(0)
}

// ─── enrich ──────────────────────────────────────────────────────────────────
// Launches the configured provider's native enrich workflow.

if (subcommand === 'enrich') {
  const workspace = await resolveEnrichWorkspace(process.cwd())
  const { provider, model: explicitModel, workflowArgs } = resolveEnrichOptions(
    workspace.codeRoot,
    subargs,
    workspace.artifactRoot,
  )
  const model =
    explicitModel ??
    resolveConfiguredEnrichModel(workspace.codeRoot, workspace.artifactRoot) ??
    'k3'
  const enrichFlags = serializeWorkflowArgs(workflowArgs)
  const launch =
    provider === 'kimi'
      ? {
          command: process.execPath,
          args: [
            path.resolve(
              workspace.artifactRoot,
              '.kimi-code',
              'specrails',
              'run-skill.mjs',
            ),
            '--skill',
            'specrails-enrich',
            '--model',
            model,
            '--add-dir',
            workspace.codeRoot,
            ...(enrichFlags ? ['--args', enrichFlags] : []),
          ],
          label: 'Kimi Code',
        }
      : provider === 'gemini'
        ? {
            command: 'gemini',
            args: [
              '-p',
              `/specrails:enrich${enrichFlags ? ` ${enrichFlags}` : ''}`,
              '--output-format',
              'stream-json',
            ],
            label: 'Gemini CLI',
          }
        : provider === 'codex'
          ? {
              command: 'codex',
              args: [
                'exec',
                `run enrich${enrichFlags ? ` ${enrichFlags}` : ''}`,
              ],
              label: 'Codex CLI',
            }
          : {
              command: 'claude',
              args: [
                '--command',
                `/specrails:enrich${enrichFlags ? ` ${enrichFlags}` : ''}`,
                '--dangerously-skip-permissions',
              ],
              label: 'Claude Code',
            }
  const result = spawnSync(
    launch.command,
    launch.args,
    {
      stdio: 'inherit',
      cwd: provider === 'kimi' ? workspace.artifactRoot : process.cwd(),
      env:
        provider === 'kimi'
          ? {
              ...process.env,
              SPECRAILS_REPO_DIR: workspace.codeRoot,
            }
          : process.env,
      shell: process.platform === 'win32' && provider !== 'kimi',
    },
  )
  if (result.error) {
    console.error(
      `\nFailed to launch ${launch.label} for enrich:`,
      result.error.message,
      `\nEnsure the configured ${provider} provider is installed and initialized.\n`,
    )
    process.exit(1)
  }
  process.exit(result.status ?? (result.error ? 1 : 0))
}

// ─── init: optional TUI short-circuit ────────────────────────────────────────
// Default flow runs the TUI to collect agent/model configuration and
// write .specrails/install-config.yaml, then falls through to the Node
// init command with --from-config. Skipped when --no-tui / --from-config
// / --yes is passed.

if (subcommand === 'init') {
  const hasNoTui =
    subargs.includes('--no-tui') ||
    subargs.includes('--no-direct') ||
    subargs.includes('--from-config')
  const autoYes = subargs.includes('--yes') || subargs.includes('-y')
  const useTui = !hasNoTui && !autoYes

  if (useTui) {
    const rootDirIdx = subargs.indexOf('--root-dir')
    const rootDir =
      rootDirIdx >= 0 && subargs[rootDirIdx + 1]
        ? path.resolve(subargs[rootDirIdx + 1])
        : process.cwd()

    // Forward --provider so the TUI can honour an explicit choice and
    // skip the interactive picker. Other flags stay with the Node CLI step.
    const providerIdx = subargs.indexOf('--provider')
    const providerVal = providerIdx >= 0 ? subargs[providerIdx + 1] : null
    const providerEqArg = subargs.find((a) => a.startsWith('--provider='))
    const tuiArgs = [path.resolve(ROOT, 'bin', 'tui-installer.mjs'), rootDir]
    if (providerVal) tuiArgs.push('--provider', providerVal)
    else if (providerEqArg) tuiArgs.push(providerEqArg)
    if (subargs.includes('--with-profiles')) tuiArgs.push('--with-profiles')
    const tuiResult = spawnSync('node', tuiArgs, {
      stdio: 'inherit',
      cwd: process.cwd(),
      shell: process.platform === 'win32',
    })

    if (tuiResult.error) {
      console.error(
        '\nFailed to launch TUI installer:',
        tuiResult.error.message,
        '\nRun: npm install   or pass --no-tui to skip the TUI.\n',
      )
      process.exit(1)
    }
    if (tuiResult.status !== 0) {
      process.exit(tuiResult.status ?? 1)
    }

    // TUI succeeded — re-enter init with --from-config so the Node
    // command reads provider/tier from install-config.yaml.
    const nextArgs = subargs
      .filter((a) => a !== '--no-tui' && a !== '--no-direct')
      .concat(['--yes', '--from-config'])
    await runNodeCli(['init', ...nextArgs])
    // runNodeCli calls process.exit itself; the following line is
    // defensive.
    process.exit(0)
  }

  // Direct mode — strip internal --no-tui / --no-direct flags and go.
  const cleanArgs = subargs.filter((a) => a !== '--no-tui' && a !== '--no-direct')
  await runNodeCli(['init', ...cleanArgs])
  process.exit(0)
}

// ─── update / doctor — direct dispatch to Node CLI ───────────────────────────

await runNodeCli([subcommand, ...subargs])
process.exit(0)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`specrails-core — Provider-independent AI agent workflow system

Usage:
  specrails-core init       [--root-dir <path>] [--yes|-y] [--no-tui]  Install into a repository
  specrails-core update     [--only <component>] [--dry-run]           Update an existing installation
  specrails-core doctor                                                 Run health checks
  specrails-core install-framework --framework-dir <path> --provider <value> --version <value>
                                                                        Materialize an offline framework version
  specrails-core swap-current --framework-dir <path> --version <value> [--providers <csv>]
                                                                        Validate and atomically expose a framework version
  specrails-core assemble   --workspace <path> --framework-dir <path>   Assemble a workspace from the framework
  specrails-core enrich     [--provider <value>] [workflow flags]       Run the configured provider's enrich workflow
  specrails-core profile    <validate|show> [<path>]                    Validate or pretty-print a profile JSON
  specrails-core version                                                Show installed version

Flags for init:
  --root-dir <path>   Target repository path (default: current directory)
  --yes | -y          Non-interactive; use defaults, skip TUI
  --provider <value>  Force provider: claude, codex, gemini, or kimi
  --no-tui            Skip TUI; use defaults / flags directly
  --from-config       Skip TUI; use existing .specrails/install-config.yaml

Global flags:
  --version | -V    Show installed version

More info: https://github.com/fjpulidop/specrails-core`)
}

function resolveEnrichOptions(cwd, argv, artifactRoot = cwd) {
  const workflowArgs = []
  let explicitProvider
  let model
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--provider' || token === '--model') {
      const value = argv[++index]
      if (!value) {
        console.error(`${token} requires a value`)
        process.exit(1)
      }
      if (token === '--provider') explicitProvider = value
      else model = value
      continue
    }
    if (token.startsWith('--provider=')) {
      explicitProvider = token.slice('--provider='.length)
      continue
    }
    if (token.startsWith('--model=')) {
      model = token.slice('--model='.length)
      continue
    }
    workflowArgs.push(token)
  }

  const supported = new Set(['claude', 'codex', 'gemini', 'kimi'])
  if (explicitProvider && !supported.has(explicitProvider)) {
    console.error(
      `Unsupported provider "${explicitProvider}". Expected claude, codex, gemini, or kimi.`,
    )
    process.exit(1)
  }

  let provider = explicitProvider
  if (!provider) {
    for (const root of [cwd, artifactRoot]) {
      const manifestPath = path.join(
        root,
        '.specrails',
        'specrails-manifest.json',
      )
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          if (supported.has(manifest.primary_provider)) {
            provider = manifest.primary_provider
            break
          }
        } catch {
          // A malformed manifest is diagnosed by `specrails-core doctor`;
          // enrich continues to config/directory fallback.
        }
      }
    }
  }
  if (!provider) {
    for (const root of [cwd, artifactRoot]) {
      const configPath = path.join(root, '.specrails', 'install-config.yaml')
      if (!existsSync(configPath)) continue
      const match = readFileSync(configPath, 'utf8').match(
        /^provider:\s*(claude|codex|gemini|kimi)\s*$/m,
      )
      if (match) {
        provider = match[1]
        break
      }
    }
  }
  if (!provider) {
    provider =
      ['claude', 'codex', 'gemini', 'kimi'].find((candidate) =>
        existsSync(
          path.join(
            artifactRoot,
            candidate === 'kimi' ? '.kimi-code' : `.${candidate}`,
          ),
        ),
      ) ?? 'claude'
  }
  return { provider, model, workflowArgs }
}

async function resolveEnrichWorkspace(cwd) {
  const registryModulePath = path.resolve(
    ROOT,
    'dist',
    'installer',
    'util',
    'registry.js',
  )
  if (!existsSync(registryModulePath)) {
    return { artifactRoot: cwd, codeRoot: cwd }
  }
  try {
    const registry = await import(pathToFileURL(registryModulePath).href)
    const resolution = registry.resolveArtifacts(cwd, { allocate: false })
    return {
      artifactRoot: path.resolve(resolution.artifactRoot),
      codeRoot: path.resolve(resolution.codeRoot),
    }
  } catch {
    // Doctor reports malformed registry state. Enrich retains the legacy
    // in-repository fallback instead of guessing another relocated workspace.
    return { artifactRoot: cwd, codeRoot: cwd }
  }
}

function resolveConfiguredEnrichModel(codeRoot, artifactRoot) {
  const activeProfile = process.env.SPECRAILS_PROFILE_PATH
  if (activeProfile) {
    const activePath = path.isAbsolute(activeProfile)
      ? activeProfile
      : path.resolve(codeRoot, activeProfile)
    const activeModel = readProfileOrchestratorModel(activePath)
    if (activeModel) return activeModel
  }
  const configCandidates = [
    path.join(codeRoot, '.specrails', 'install-config.yaml'),
    path.join(artifactRoot, '.specrails', 'install-config.yaml'),
  ]
  for (const configPath of configCandidates) {
    if (!existsSync(configPath)) continue
    try {
      const config = require_('js-yaml').load(readFileSync(configPath, 'utf8'))
      const configured = config?.models?.defaults?.model
      if (typeof configured === 'string' && configured.trim() !== '') {
        return configured.trim()
      }
    } catch {
      // The installer/doctor owns full config diagnostics. Continue to a
      // provider profile rather than extracting a value from malformed YAML.
    }
  }
  const profileCandidates = [
    path.join(artifactRoot, '.specrails', 'profiles', 'kimi-default.json'),
    path.join(codeRoot, '.specrails', 'profiles', 'kimi-default.json'),
  ]
  for (const profilePath of profileCandidates) {
    const configured = readProfileOrchestratorModel(profilePath)
    if (configured) return configured
  }
  return null
}

function readProfileOrchestratorModel(profilePath) {
  if (!existsSync(profilePath)) return null
  try {
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
    const configured = profile?.orchestrator?.model
    return typeof configured === 'string' && configured.trim() !== ''
      ? configured.trim()
      : null
  } catch {
    // Profile validation provides the actionable error. Fall through.
    return null
  }
}

function serializeWorkflowArgs(argv) {
  return argv
    .map((value) =>
      value === '' || /\s|["']/u.test(value) ? JSON.stringify(value) : value,
    )
    .join(' ')
}

/**
 * Loads the compiled Node CLI (dist/installer/cli.js) and invokes its
 * `main` function with the given argv array. Propagates the returned
 * exit code via process.exit.
 */
async function runNodeCli(argv) {
  const cliPath = path.resolve(ROOT, 'dist', 'installer', 'cli.js')
  if (!existsSync(cliPath)) {
    console.error(
      `Installer runtime not found at ${cliPath}. ` +
        `If you are running from a source checkout, run: npm run build`,
    )
    process.exit(1)
  }
  const mod = await import(pathToFileURL(cliPath).href)
  if (typeof mod.main !== 'function') {
    console.error('Installer runtime is missing the expected main() export — corrupt install?')
    process.exit(1)
  }
  const code = await mod.main(argv)
  process.exit(code)
}

async function runProfile(subargs) {
  const action = subargs[0]
  const pathArg = subargs[1]
  if (!action || (action !== 'validate' && action !== 'show')) {
    console.error('Usage: specrails-core profile validate [<path>]')
    console.error('       specrails-core profile show     [<path>]')
    process.exit(1)
  }

  const workspace = await resolveEnrichWorkspace(process.cwd())
  const resolveProfilePath = () => {
    if (pathArg) return path.resolve(pathArg)
    if (process.env.SPECRAILS_PROFILE_PATH) return path.resolve(process.env.SPECRAILS_PROFILE_PATH)
    const configRoots = [workspace.codeRoot, workspace.artifactRoot]
    let provider
    for (const root of configRoots) {
      const configPath = path.join(root, '.specrails', 'install-config.yaml')
      if (!existsSync(configPath)) continue
      const match = readFileSync(configPath, 'utf8').match(
        /^provider:\s*(claude|codex|gemini|kimi)\s*$/m,
      )
      if (match) {
        provider = match[1]
        break
      }
    }
    const names =
      provider === 'kimi'
        ? ['kimi-default.json', 'project-default.json']
        : ['project-default.json', 'kimi-default.json']
    for (const root of [workspace.artifactRoot, workspace.codeRoot]) {
      for (const name of names) {
        const candidate = path.join(root, '.specrails', 'profiles', name)
        if (existsSync(candidate)) return candidate
      }
    }
    return null
  }

  const profilePath = resolveProfilePath()
  if (!profilePath) {
    console.error('No profile path given and none could be resolved.')
    console.error('Pass an explicit path or set SPECRAILS_PROFILE_PATH, or place a profile at')
    console.error(
      '  .specrails/profiles/project-default.json (or kimi-default.json for Kimi)',
    )
    process.exit(1)
  }
  if (!existsSync(profilePath)) {
    console.error(`Profile file not found: ${profilePath}`)
    process.exit(1)
  }

  let profile
  try {
    profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  } catch (e) {
    console.error(`Profile is not valid JSON: ${e.message}`)
    process.exit(1)
  }

  if (action === 'show') {
    console.log(JSON.stringify(profile, null, 2))
    process.exit(0)
  }

  // action === 'validate'
  const schemaPath = path.resolve(ROOT, 'schemas', 'profile.v1.json')
  if (!existsSync(schemaPath)) {
    console.error(`Schema not found at ${schemaPath} — install may be corrupt`)
    process.exit(1)
  }

  let Ajv
  try {
    const mod = await import('ajv/dist/2020.js')
    Ajv = mod.default
  } catch {
    console.error(
      "'ajv' is not installed. Run `npm install` in the specrails-core package directory first.",
    )
    process.exit(1)
  }

  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const ajv = new Ajv({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)
  const schemaValid = validate(profile)
  const semanticErrors = schemaValid
    ? validateProfileSemantics(profile)
    : []

  if (schemaValid && semanticErrors.length === 0) {
    console.log(`✓ ${profilePath} is a valid v1 profile.`)
    process.exit(0)
  }
  console.error(`✗ ${profilePath} failed validation:`)
  for (const err of validate.errors || []) {
    console.error(`    ${err.instancePath || '/'} ${err.message} (${JSON.stringify(err.params)})`)
  }
  for (const err of semanticErrors) {
    console.error(`    ${err}`)
  }
  process.exit(1)
}

/**
 * JSON Schema validates each profile entry in isolation. These invariants span
 * multiple array entries and therefore require a second, semantic validation
 * pass after AJV has established the profile's structural shape.
 */
function validateProfileSemantics(profile) {
  const errors = []
  const firstAgentIndex = new Map()

  for (const [index, agent] of profile.agents.entries()) {
    const previous = firstAgentIndex.get(agent.id)
    if (previous !== undefined) {
      errors.push(
        `/agents/${index}/id duplicates agent id "${agent.id}" first declared at /agents/${previous}/id`,
      )
    } else {
      firstAgentIndex.set(agent.id, index)
    }
  }

  const knownAgents = new Set(firstAgentIndex.keys())
  const defaultIndices = []
  for (const [index, rule] of profile.routing.entries()) {
    if (!knownAgents.has(rule.agent)) {
      errors.push(
        `/routing/${index}/agent references unknown agent "${rule.agent}"`,
      )
    }
    if (rule.default === true) {
      defaultIndices.push(index)
    }
  }

  if (defaultIndices.length > 1) {
    errors.push(
      `/routing must contain at most one default rule (found ${defaultIndices.length})`,
    )
  }
  for (const index of defaultIndices) {
    if (index !== profile.routing.length - 1) {
      errors.push(`/routing/${index} default rule must be the last routing entry`)
    }
  }

  return errors
}
