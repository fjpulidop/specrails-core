/**
 * specrails-core CLI: the installer and runtime entry points Desktop drives.
 * `bin/specrails-core.mjs` and a direct `node dist/installer/cli.js` run both
 * land in {@link main}.
 */

import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  runAssemble,
  runInstallFramework,
  runSwapCurrent,
  type AssembleFlags,
  type InstallFrameworkFlags,
  type SwapCurrentFlags,
} from './commands/framework.js'
import { runInit, type InitFlags } from './commands/init.js'
import { runPipelineCommand } from '../pipeline/pipeline-state.js'
import { parseArgs } from '../shared/args.js'
import { isInstallerError } from './util/errors.js'
import { fatal } from './util/logger.js'

function usageText(): string {
  return [
    '',
    'specrails-core — agent workflow engine for specrails-desktop',
    '',
    'Usage:',
    '  specrails-core <command> [options]',
    '',
    'Commands:',
    '  init                Install specrails into a repository (claude, codex, gemini, or kimi)',
    '  install-framework   Materialize the versioned framework (offline)',
    '  swap-current        Point framework/current at a version (offline)',
    '  assemble            Link the framework into a project workspace (offline)',
    '  pipeline            Inspect and verify durable implementation phases',
    '  runtime             Run, inspect and resume programmatic agents',
    '  help                Show this help message',
    '  version             Print the installed version',
    '',
  ].join('\n')
}

function readVersion(): string {
  // Single source of truth: package.json `version` (bumped by
  // release-please on every release). Resolve it relative to the
  // compiled module location.
  // In src: src/installer/cli.ts → ../../package.json
  // In dist: dist/installer/cli.js → ../../package.json
  const here = path.dirname(fileURLToPath(import.meta.url))
  const pkgPath = path.resolve(here, '..', '..', 'package.json')
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return pkg.version?.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

async function dispatch(
  subcommand: string,
  flags: Record<string, string | boolean>,
  positionals: string[],
): Promise<number> {
  switch (subcommand) {
    case 'init':
      await runInit(flags as InitFlags)
      return 0
    case 'pipeline':
      return runPipelineCommand(flags, positionals)
    case 'runtime':
      return (await import('../agent-runtime/cli.js')).runRuntimeCommand(flags, positionals)
    case 'install-framework':
      await runInstallFramework(flags as InstallFrameworkFlags)
      return 0
    case 'swap-current':
      await runSwapCurrent(flags as SwapCurrentFlags)
      return 0
    case 'assemble':
      await runAssemble(flags as AssembleFlags)
      return 0
    case 'help':
      process.stdout.write(usageText())
      return 0
    case 'version':
      process.stdout.write(`${readVersion()}\n`)
      return 0
    default:
      process.stderr.write(`Unknown command: ${subcommand}\n`)
      process.stdout.write(usageText())
      return 1
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { subcommand, flags, positionals } = parseArgs(argv)

  // `--version` is global only before a command: `swap-current --version <v>`
  // names a framework version.
  if (subcommand === null) {
    if (flags.version === true || flags.V === true) {
      process.stdout.write(`${readVersion()}\n`)
      return 0
    }
    process.stdout.write(usageText())
    return 0
  }

  // `init --help` must print help, never install.
  if (flags.help === true && subcommand !== 'runtime') {
    process.stdout.write(usageText())
    return 0
  }

  try {
    return await dispatch(subcommand, flags, positionals)
  } catch (err) {
    if (isInstallerError(err)) {
      fatal(err.message)
      return err.exitCode
    }
    const e = err as Error
    fatal(e.message || 'unexpected error', e.stack)
    return 1
  }
}

/**
 * Auto-run guard: when this module is executed DIRECTLY as a script
 * (`node dist/installer/cli.js <subcommand>`), run `main()` and propagate its
 * exit code. specrails-desktop's bundled-core path (server/framework-manager.ts)
 * spawns `node <core>/dist/installer/cli.js install-framework|assemble …` and
 * relies on this — `bin/specrails-core.mjs` imports `main` and is unaffected
 * (it never executes this file as argv[1]).
 *
 * Comparing `import.meta.url` against `process.argv[1]` keeps the guard inert on
 * import (so unit tests that `import { main }` never trigger a process.exit).
 *
 * SYMLINK CAVEAT: Node's ESM loader realpaths the entry module, so
 * `import.meta.url` is the REAL path while `process.argv[1]` is the literal
 * spawn argument. When the package lives behind a symlinked path (macOS
 * `os.tmpdir()` = /var/folders → /private/var/folders — exactly where
 * specrails-desktop's core-update channel stages the download), the raw
 * comparison fails and main() silently never runs (child exits 0 having done
 * nothing). Compare against the realpathed argv[1] too.
 */
const isDirectRun = (() => {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    if (import.meta.url === pathToFileURL(entry).href) return true
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
})()

if (isDirectRun) {
  void main().then((code) => {
    process.exitCode = code
  })
}
