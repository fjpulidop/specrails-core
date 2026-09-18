import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandReachesTest, expandCommandText, relativeTestPath, unreachedTestFiles, unreachedTestsReason } from './test-reachability.js'

let root: string
const file = (relative: string, content = '// test'): void => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), content) }
const manifest = (scripts: Record<string, string>): void => file('package.json', JSON.stringify({ name: 'x', scripts }))

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'reach-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('expandCommandText', () => {
  it('resolves npm/pnpm/yarn test scripts and follows nested npm run one level at a time', () => {
    manifest({ test: 'npm run unit && npm run e2e', unit: 'node tests/a.test.js', e2e: 'node tests/e2e.test.js' })
    expect(expandCommandText(root, { command: 'npm', args: ['test', '--silent'] })).toBe('(node tests/a.test.js) && (node tests/e2e.test.js)')
    expect(expandCommandText(root, { command: 'pnpm', args: ['run', 'unit'] })).toBe('node tests/a.test.js')
    expect(expandCommandText(root, { command: 'yarn', args: ['e2e'] })).toBe('node tests/e2e.test.js')
  })
  it('keeps the literal argv when there is no manifest or script', () => {
    expect(expandCommandText(root, { command: 'npm', args: ['test'] })).toBe('npm test')
    expect(expandCommandText(root, { command: 'jest', args: ['--ci'] })).toBe('jest --ci')
  })
})

describe('commandReachesTest', () => {
  it('flags the observed shape: an enumerating test script that omits a new file', () => {
    manifest({ test: 'node tests/board.test.js && node tests/tetromino.test.js && node tests/game.test.js' })
    for (const name of ['board', 'tetromino', 'game', 'browser']) file(`tests/${name}.test.js`)
    const npmTest = { command: 'npm', args: ['test', '--silent'] }
    expect(commandReachesTest(root, npmTest, 'tests/board.test.js')).toBe(true)
    expect(commandReachesTest(root, npmTest, 'tests/browser.test.js')).toBe(false)
  })
  it('treats discovery runners without paths as reaching everything', () => {
    for (const script of ['jest', 'vitest run', 'mocha', 'pytest', 'go test ./...', 'cargo test', 'node --test', 'bun test', 'deno test']) {
      manifest({ test: script })
      expect(commandReachesTest(root, { command: 'npm', args: ['test'] }, 'tests/new.test.js'), script).toBe(true)
    }
    expect(commandReachesTest(root, { command: 'go', args: ['test', './...'] }, 'pkg/x_test.go')).toBe(true)
    expect(commandReachesTest(root, { command: 'python3', args: ['-m', 'pytest', '-q'] }, 'tests/test_x.py')).toBe(true)
  })
  it('honours directories, globs and runner name patterns', () => {
    file('tests/unit/a.test.js'); file('tests/e2e/b.test.js')
    expect(commandReachesTest(root, { command: 'mocha', args: ['tests/unit/'] }, 'tests/unit/a.test.js')).toBe(true)
    expect(commandReachesTest(root, { command: 'mocha', args: ['tests/unit'] }, 'tests/e2e/b.test.js')).toBe(false)
    expect(commandReachesTest(root, { command: 'mocha', args: ['tests/**/*.test.js'] }, 'tests/e2e/b.test.js')).toBe(true)
    expect(commandReachesTest(root, { command: 'mocha', args: ['tests/*.test.js'] }, 'tests/e2e/b.test.js')).toBe(false)
    expect(commandReachesTest(root, { command: 'jest', args: ['board'] }, 'tests/board.test.js')).toBe(true)
  })
  it('fails open on commands it cannot judge', () => {
    expect(commandReachesTest(root, { command: 'make', args: ['test'] }, 'tests/a.test.js')).toBe(true)
    expect(commandReachesTest(root, { command: './scripts/test.sh', args: [] }, 'tests/a.test.js')).toBe(true)
    expect(commandReachesTest(root, { command: 'node', args: ['scripts/run-tests.js'] }, 'tests/a.test.js')).toBe(true)
    expect(commandReachesTest(root, { command: 'tsx', args: ['src/cli.ts', 'check'] }, 'tests/a.test.js')).toBe(true)
  })
  it('reaches a file when at least one segment names it', () => {
    manifest({ test: 'node tests/a.test.js && jest' })
    expect(commandReachesTest(root, { command: 'npm', args: ['test'] }, 'tests/zzz.test.js')).toBe(true)
  })
})

describe('unreachedTestFiles', () => {
  it('returns only existing, test-shaped, repository-relative files no command reaches', () => {
    manifest({ test: 'node tests/a.test.js' })
    file('tests/a.test.js'); file('tests/b.test.js'); file('src/game.js'); file('tests/helpers.js')
    const commands = [{ command: 'npm', args: ['test'] }]
    // tests/helpers.js lives under tests/ but is not a test: never flagged.
    expect(unreachedTestFiles(root, commands, ['tests/a.test.js', path.join(root, 'tests/b.test.js'), 'tests/missing.test.js', 'src/game.js', 'tests/helpers.js', '../outside.test.js'])).toEqual(['tests/b.test.js'])
    expect(unreachedTestFiles(root, [], ['tests/b.test.js'])).toEqual([])
    expect(unreachedTestFiles(root, [{ command: 'make', args: ['test'] }], ['tests/b.test.js'])).toEqual([])
  })
  it('relativizes absolute paths under the root and rejects the rest', () => {
    file('tests/a.test.js')
    expect(relativeTestPath(root, path.join(root, 'tests', 'a.test.js'))).toBe('tests/a.test.js')
    expect(relativeTestPath(root, 'tests/a.test.js')).toBe('tests/a.test.js')
    expect(relativeTestPath(root, '/definitely/elsewhere/a.test.js')).toBeUndefined()
  })
  it('phrases the reason as a correction task', () => {
    expect(unreachedTestsReason(['tests/browser.test.js'])).toMatch(/^Test file written by the developer is not executed by any verification command: tests\/browser\.test\.js\./)
    expect(unreachedTestsReason(['a.test.js', 'b.test.js'])).toMatch(/^Test files .* are not executed/)
  })
})
