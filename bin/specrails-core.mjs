#!/usr/bin/env node
/**
 * specrails-core CLI — thin ESM dispatcher.
 *
 * All installer subcommands (init, update, doctor, perf-check) execute
 * in-process via the Node installer under dist/installer/. This file
 * only keeps logic that is local to the dispatcher:
 *   - `profile validate` / `profile show` — schema validation via ajv.
 *   - `enrich`                            — spawns Claude Code with
 *                                           the /specrails:enrich command.
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

if (args.includes('--version') || args.includes('-V')) {
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
  'perf-check',
  'enrich',
  'version',
  'profile',
  'help',
])

if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
  console.error(`Unknown command: ${subcommand}\n`)
  console.error('Available commands: init, update, doctor, perf-check, enrich, version, profile, help')
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
// Launches Claude Code with the /specrails:enrich slash command.

if (subcommand === 'enrich') {
  const enrichFlags = subargs.join(' ')
  const claudeCmd = `/specrails:enrich${enrichFlags ? ' ' + enrichFlags : ''}`
  const result = spawnSync(
    'claude',
    ['--command', claudeCmd, '--dangerously-skip-permissions'],
    {
      stdio: 'inherit',
      cwd: process.cwd(),
      shell: process.platform === 'win32',
    },
  )
  if (result.error) {
    console.error(
      '\nFailed to launch Claude CLI for enrich:',
      result.error.message,
      '\nEnsure Claude Code is installed: npm install -g @anthropic-ai/claude-code\n',
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

    const tuiArgs = [path.resolve(ROOT, 'bin', 'tui-installer.mjs'), rootDir]
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
    // command reads provider/tier/agent_teams from install-config.yaml.
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

// ─── update / doctor / perf-check — direct dispatch to Node CLI ──────────────

await runNodeCli([subcommand, ...subargs])
process.exit(0)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`specrails-core — Agent Workflow System for Claude Code

Usage:
  specrails-core init       [--root-dir <path>] [--yes|-y] [--no-tui]  Install into a repository
  specrails-core update     [--only <component>] [--dry-run]           Update an existing installation
  specrails-core doctor                                                 Run health checks
  specrails-core perf-check [--files <list>]                            Performance regression check (CI)
  specrails-core enrich     [--from-config <path>]                      Run /specrails:enrich via Claude CLI
  specrails-core profile    <validate|show> [<path>]                    Validate or pretty-print a profile JSON
  specrails-core version                                                Show installed version

Flags for init:
  --root-dir <path>   Target repository path (default: current directory)
  --yes | -y          Non-interactive; use defaults, skip TUI
  --provider <value>  Force provider: claude (codex coming soon)
  --no-tui            Skip TUI; use defaults / flags directly
  --from-config       Skip TUI; use existing .specrails/install-config.yaml

Global flags:
  --version | -V    Show installed version

More info: https://github.com/fjpulidop/specrails-core`)
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

  const resolveProfilePath = () => {
    if (pathArg) return path.resolve(pathArg)
    if (process.env.SPECRAILS_PROFILE_PATH) return path.resolve(process.env.SPECRAILS_PROFILE_PATH)
    const projectDefault = path.resolve(process.cwd(), '.specrails', 'profiles', 'project-default.json')
    if (existsSync(projectDefault)) return projectDefault
    return null
  }

  const profilePath = resolveProfilePath()
  if (!profilePath) {
    console.error('No profile path given and none could be resolved.')
    console.error('Pass an explicit path or set SPECRAILS_PROFILE_PATH, or place a profile at')
    console.error('  .specrails/profiles/project-default.json')
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

  if (validate(profile)) {
    console.log(`✓ ${profilePath} is a valid v1 profile.`)
    process.exit(0)
  }
  console.error(`✗ ${profilePath} failed validation:`)
  for (const err of validate.errors || []) {
    console.error(`    ${err.instancePath || '/'} ${err.message} (${JSON.stringify(err.params)})`)
  }
  process.exit(1)
}
