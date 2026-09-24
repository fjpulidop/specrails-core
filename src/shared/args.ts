/** Parsed command line shared by the installer and runtime CLIs. */
interface ParsedArgs {
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
