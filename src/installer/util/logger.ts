import pc from 'picocolors'

/**
 * Coloured output helpers for the installer. The emoji prefixes match
 * what the retired bash scripts printed (`✓ ⚠ ✗ →`) so existing user
 * bug reports and screenshots still read the same.
 *
 * The logger writes to stdout by default; callers may override via
 * {@link setLoggerStreams} (useful in tests that capture output).
 */

interface Streams {
  out: NodeJS.WritableStream
  err: NodeJS.WritableStream
}

let streams: Streams = {
  out: process.stdout,
  err: process.stderr,
}

export function setLoggerStreams(next: Partial<Streams>): void {
  streams = { ...streams, ...next }
}

/** Restore logger to process.stdout/stderr. */
export function resetLoggerStreams(): void {
  streams = { out: process.stdout, err: process.stderr }
}

function writeOut(line: string): void {
  streams.out.write(line + '\n')
}

function writeErr(line: string): void {
  streams.err.write(line + '\n')
}

/** Section heading — bold, no prefix, leading blank line. */
export function step(title: string): void {
  writeOut('')
  writeOut(pc.bold(title))
}

/** Success line. Prefix: `  ✓ ` in green. */
export function ok(msg: string): void {
  writeOut(`  ${pc.green('✓')} ${msg}`)
}

/** Warning line. Prefix: `  ⚠ ` in yellow. */
export function warn(msg: string): void {
  writeOut(`  ${pc.yellow('⚠')} ${msg}`)
}

/** Failure line, routed to stderr. Prefix: `  ✗ ` in red. */
export function fail(msg: string): void {
  writeErr(`  ${pc.red('✗')} ${msg}`)
}

/** Info line. Prefix: `  → ` in blue. */
export function info(msg: string): void {
  writeOut(`  ${pc.blue('→')} ${msg}`)
}

/** Print a fatal error and its hint, routed to stderr. */
export function fatal(message: string, hint?: string): void {
  writeErr('')
  writeErr(pc.red(pc.bold(`✗ ${message}`)))
  if (hint) {
    writeErr(pc.dim(`  ${hint}`))
  }
}

/** Primitive write for cases where the caller owns formatting. */
export function rawOut(text: string): void {
  streams.out.write(text)
}

export function rawErr(text: string): void {
  streams.err.write(text)
}
