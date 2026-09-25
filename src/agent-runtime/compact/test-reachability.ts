// Test reachability: does any verification command actually execute the test
// files the developer wrote?
//
// Observed (tetris, local 30B developer): the developer created
// tests/browser.test.js (622 lines, 6 failing cases) but package.json's test
// script stayed `node tests/board.test.js && node tests/tetromino.test.js &&
// node tests/game.test.js`. Verify ran the script, exited 0, the reviewer
// approved, and the run shipped a test nobody had ever run. The developer even
// confessed it in its summary ("commands you could not run: …").
//
// The host knows both halves — the files the developer reported as tests and
// the exact commands verify executes — so the check is deterministic and needs
// no model. It is deliberately conservative (fail-open): a command whose
// discovery cannot be judged (a shell script, `make test`, an unknown runner
// with no path arguments) is assumed to reach everything. Only a command that
// ENUMERATES test files, or a discovery runner pointed at specific paths, can
// leave a file unreached.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface ReachabilityCommand { command: string; args: string[]; cwd?: string }

/** Test-file shapes across ecosystems (`tests/x.test.js`, `x.spec.ts`, `test_x.py`, `x_test.go`, `spec/x_spec.rb`, anything under a test(s)/spec(s) dir). */
export const TEST_FILE_PATTERN = /(?:\.|_|\/|^)(?:test|spec)s?[./_]|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py|rs|rb|exs?)$|_spec\.rb$/i

/** A file that IS a test (not a helper that merely lives under tests/): `x.test.js`, `x.spec.ts`, `test_x.py`, `x_test.go`, `x_spec.rb`, `XTest.java`, `x.t.cpp`… */
export const STRICT_TEST_FILE_PATTERN = /(?:^|\/)(?:test_[^/]+\.py|[^/]+(?:\.(?:test|spec)\.[a-z]+|_test\.(?:go|py|rs|rb|exs?|ts|js)|_spec\.rb|Tests?\.(?:java|kt|cs|swift)))$/i

/** Runners that discover tests by convention when given no explicit path (the file is then reached unless the runner is pointed elsewhere). */
const DISCOVERY_RUNNERS = /(?:^|[\s/])(?:jest|vitest|mocha|ava|tap|tape|uvu|jasmine|karma|cypress|playwright|bun|deno|node|pytest|py\.test|python3?|go|cargo|dotnet|mvn|mvnw|gradle|gradlew|rspec|phpunit|pest|mix|swift|ctest|tsx|ts-node)(?:\.exe|\.cmd)?\b/i
const RUNNER_TEST_VERBS = /(?:^|\s)--test\b|\b(?:test|check)\b/

const SCRIPT_DEPTH = 3
const posix = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '')

/**
 * Resolves the command line verify runs: an `npm test` / `pnpm run x` /
 * `yarn x` invocation becomes the script body from package.json (nested
 * `npm run` references followed up to a small depth); anything else is the
 * literal argv. Returns the text to inspect for paths.
 */
export function expandCommandText(root: string, command: ReachabilityCommand, depth = 0): string {
  const literal = [command.command, ...command.args].join(' ')
  const runner = path.basename(command.command).replace(/\.(?:cmd|exe)$/i, '')
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(runner) || depth > SCRIPT_DEPTH) return literal
  const args = command.args.filter(arg => !arg.startsWith('-'))
  const name = args[0] === 'run' || args[0] === 'run-script' ? args[1] : args[0] === 'test' || args[0] === 'start' ? args[0] : runner === 'yarn' || runner === 'bun' ? args[0] : undefined
  if (!name) return literal
  const script = readScript(path.resolve(root, command.cwd ?? '.'), name)
  if (!script) return literal
  // A script that itself runs `npm run other` is followed; anything else is inspected as written.
  return script.replace(/\b(?:npm|pnpm|yarn|bun)(?:\s+run(?:-script)?)?\s+([\w:.-]+)/g, (match, inner: string) => {
    if (inner === 'test' && name === 'test') return match
    const nested = readScript(path.resolve(root, command.cwd ?? '.'), inner)
    return nested && depth < SCRIPT_DEPTH ? `(${expandCommandText(root, { command: runner, args: ['run', inner], cwd: command.cwd }, depth + 1)})` : match
  })
}
function readScript(dir: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    const script = manifest.scripts?.[name]
    return typeof script === 'string' && script.trim() ? script : undefined
  } catch { return undefined }
}

/** Splits a shell command line into its `&&` / `||` / `;` / `|` segments, each tokenized on whitespace (quotes stripped). */
function segments(text: string): string[][] {
  return text.split(/\s*(?:&&|\|\||;|\|)\s*/).map(segment => segment.replace(/^\(|\)$/g, '').trim()).filter(Boolean)
    .map(segment => segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map(token => token.replace(/^["']|["']$/g, '')) ?? [])
}
/** Tokens that address files or directories: a slash, a test-file shape, or a glob. */
function pathTokens(tokens: string[]): string[] {
  return tokens.slice(1).filter(token => !token.startsWith('-') && !/^[A-Z_][A-Z0-9_]*=/.test(token) && (token.includes('/') || token.includes('*') || TEST_FILE_PATTERN.test(token) || /\.[cm]?[jt]sx?$|\.py$|\.rb$|\.go$/.test(token)))
}
function globToRegExp(glob: string): RegExp {
  // Placeholders keep the generated regex syntax out of the later `*` / `?` substitutions.
  const source = posix(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*')
  return new RegExp(`^${source}$`)
}
function tokenReaches(token: string, file: string, root: string, discovery: boolean): boolean {
  let target = posix(token)
  // Go's `./...` (and `pkg/...`) recurse into every package below.
  if (target === '...' || target === './...') return true
  if (target.endsWith('/...')) target = target.slice(0, -4)
  if (target === file || path.posix.basename(target) === file || file.startsWith(target.replace(/\/$/, '') + '/')) return true
  if (target.includes('*')) return globToRegExp(target).test(file)
  const absolute = path.resolve(root, target)
  if (existsSync(absolute) && file.startsWith(posix(path.relative(root, absolute)) + '/')) return true
  // A discovery runner treats a bare argument as a name pattern (`jest board` runs board.test.js).
  return discovery && !target.includes('/') && file.includes(target)
}

/**
 * Whether one verification command reaches the (repository-relative) test
 * file. Unknown ⇒ true: only an enumerating command can prove absence.
 */
export function commandReachesTest(root: string, command: ReachabilityCommand, file: string): boolean {
  // Path arguments are relative to the directory the command runs in (a
  // package inside a larger checkout), while reported files are relative to
  // the checkout: compare both from the command's directory.
  const base = path.resolve(root, command.cwd ?? '.')
  const target = posix(path.relative(base, path.resolve(root, file)))
  let judged = false
  for (const tokens of segments(expandCommandText(root, command))) {
    if (!tokens.length) continue
    const head = tokens.join(' ')
    const discovery = DISCOVERY_RUNNERS.test(head)
    const paths = pathTokens(tokens)
    if (discovery && !paths.length) {
      // `npm test` → `jest` discovers everything; `node --test` likewise; but bare `node`/`python` with no path runs nothing test-shaped.
      if (!/^(?:node|python3?|deno|bun)$/i.test(path.basename(tokens[0]!)) || RUNNER_TEST_VERBS.test(head)) return true
      continue
    }
    // Paths that are not test-shaped (`node scripts/run-tests.js`, `tsx src/cli.ts`)
    // enumerate nothing we can judge: the script may discover tests itself.
    if (!paths.some(token => TEST_FILE_PATTERN.test(posix(token)) || token.includes('*') || token.endsWith('...'))) continue
    judged = true
    if (paths.some(token => tokenReaches(token, target, base, discovery))) return true
  }
  return !judged
}

/** Repository-relative POSIX path for a reported test file (absolute paths under the root are relativized), or undefined when outside the root or missing. */
export function relativeTestPath(root: string, file: string): string | undefined {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = posix(path.relative(root, absolute))
  if (!relative || relative.startsWith('..') || !existsSync(absolute)) return undefined
  return relative
}

/**
 * The test files (repository-relative) among `reported` that exist on disk and
 * that NO command reaches. Empty when every command is unjudgeable.
 */
export function unreachedTestFiles(root: string, commands: readonly ReachabilityCommand[], reported: readonly string[]): string[] {
  if (!commands.length) return []
  const files = [...new Set(reported.map(file => relativeTestPath(root, file)).filter((file): file is string => !!file && STRICT_TEST_FILE_PATTERN.test(file)))]
  return files.filter(file => !commands.some(command => commandReachesTest(root, command, file)))
}

/** The feedback sentence the developer receives; starts with a capital so the synthetic-corrections parser turns it into a task. */
export function unreachedTestsReason(files: readonly string[]): string {
  return `Test file${files.length === 1 ? '' : 's'} written by the developer ${files.length === 1 ? 'is' : 'are'} not executed by any verification command: ${files.join(', ')}. A test nobody runs proves nothing. Wire ${files.length === 1 ? 'it' : 'them'} into the repository's test command (for example the package.json "test" script) or propose a verificationCheck that runs ${files.length === 1 ? 'it' : 'them'}, then make ${files.length === 1 ? 'it' : 'them'} pass.`
}
