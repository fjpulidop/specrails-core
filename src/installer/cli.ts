/**
 * specrails-core CLI entry point (Node / TypeScript).
 *
 * Replaces the legacy bash-dispatch path in `bin/specrails-core.js`.
 * During the port, `bin/specrails-core.js` keeps shelling out to the
 * shell scripts while this module carries the in-progress Node
 * implementation. Once Phases 2–4 ship the command handlers and
 * Phase 5 deletes the shell scripts, the `bin/` dispatcher collapses
 * to a single `import { main } from './dist/installer/cli.js'` call.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDoctor, type DoctorFlags } from './commands/doctor.js'
import { runInit, type InitFlags } from './commands/init.js'
import { runPerfCheck, type PerfCheckFlags } from './commands/perf-check.js'
import { runUpdate, type UpdateFlags } from './commands/update.js'
import { isInstallerError } from './util/errors.js'
import { fatal } from './util/logger.js'

export interface ParsedArgs {
  subcommand: string | null
  flags: Record<string, string | boolean>
  positionals: string[]
}

/**
 * Minimal arg parser, no external dep. Handles:
 *   subcommand                (first bare positional)
 *   --flag                    (boolean true)
 *   --flag=value              (string)
 *   --flag value              (string, consumes next token)
 *   -h / --help               (help alias)
 *   -v / --version            (version alias)
 *   positionals               (everything else)
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  let subcommand: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith('--')) {
      const rest = token.slice(2)
      const eq = rest.indexOf('=')
      if (eq >= 0) {
        flags[rest.slice(0, eq)] = rest.slice(eq + 1)
      } else {
        const peek = argv[i + 1]
        if (peek !== undefined && !peek.startsWith('-')) {
          flags[rest] = peek
          i++
        } else {
          flags[rest] = true
        }
      }
    } else if (token === '-h') {
      flags.help = true
    } else if (token === '-v') {
      flags.version = true
    } else if (token.startsWith('-') && token.length > 1) {
      flags[token.slice(1)] = true
    } else {
      if (subcommand === null) {
        subcommand = token
      } else {
        positionals.push(token)
      }
    }
  }

  return { subcommand, flags, positionals }
}

function usageText(): string {
  return [
    '',
    'specrails-core — AI agent workflow system',
    '',
    'Usage:',
    '  specrails-core <command> [options]',
    '',
    'Commands:',
    '  init           Install specrails into a repository',
    '  update         Update an existing specrails installation',
    '  doctor         Diagnose the health of an existing installation',
    '  perf-check     Run the agent-workflow micro-benchmark',
    '  help           Show this help message',
    '  version        Print the installed version',
    '',
    'Global options:',
    '  -h, --help     Show this help',
    '  -v, --version  Print version',
    '',
  ].join('\n')
}

function readVersion(): string {
  // Resolve VERSION relative to the compiled module location.
  // In src: src/installer/cli.ts → ../../VERSION
  // In dist: dist/installer/cli.js → ../../VERSION
  const here = path.dirname(fileURLToPath(import.meta.url))
  const versionPath = path.resolve(here, '..', '..', 'VERSION')
  try {
    return readFileSync(versionPath, 'utf8').trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Sentinel exit code used during the port: when a Node command is not
 * yet implemented, the CLI exits with this code and the outer bash
 * dispatcher (bin/specrails-core.js) may choose to fall through to
 * the shell path. Removed entirely in Phase 5 when no shell scripts
 * remain.
 */
export const NOT_IMPLEMENTED = 2

async function dispatch(
  subcommand: string,
  flags: Record<string, string | boolean>,
  _positionals: string[],
): Promise<number> {
  switch (subcommand) {
    case 'init':
      await runInit(flags as InitFlags)
      return 0
    case 'update':
      await runUpdate(flags as UpdateFlags)
      return 0
    case 'doctor': {
      const result = await runDoctor(flags as DoctorFlags)
      return result.failed === 0 ? 0 : 1
    }
    case 'perf-check':
      await runPerfCheck(flags as PerfCheckFlags)
      return 0
    case 'help':
    case '':
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

  if (flags.help === true) {
    process.stdout.write(usageText())
    return 0
  }
  if (flags.version === true) {
    process.stdout.write(`${readVersion()}\n`)
    return 0
  }

  try {
    return await dispatch(subcommand ?? '', flags, positionals)
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
