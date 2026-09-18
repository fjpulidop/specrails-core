import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BINARY_ASSET, diagnoseVerificationFailure, duplicateSibling, feedbackExcerpts, foreignLanguageFile, isStubFile, languageProfile, locateNamedFile, misplacedTestFile, namedFiles, siblingTestFile } from './developer.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function repo(files: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'evidence-')); temporary.push(root)
  for (const file of files) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), '') }
  return root
}

describe('namedFiles', () => {
  it('extracts source/test paths from a task sentence and ignores plan paths and prose', () => {
    expect(namedFiles('Create src/game.js implementing GameEngine with tests in tests/game.test.js, then update openspec/changes/x/tasks.md')).toEqual(['src/game.js', 'tests/game.test.js'])
    expect(namedFiles('Create package.json with a test script and jest.config.js')).toEqual([])
    expect(namedFiles('Implement `src/engine/board.ts` (Board class) and `src/engine/__tests__/board.test.ts`.')).toEqual(['src/engine/board.ts', 'src/engine/__tests__/board.test.ts'])
  })
})

describe('diagnoseVerificationFailure', () => {
  it('resolves a wrong relative import to the real file and proposes the exact import path', () => {
    const root = repo(['src/index.js', 'tests/smoke.test.js'])
    const items = diagnoseVerificationFailure("FAIL tests/smoke.test.js\n    Cannot find module '../../src/index' from 'tests/smoke.test.js'\n", [root])
    expect(items).toHaveLength(1)
    expect(items[0]).toContain("tests/smoke.test.js: the import '../../src/index' does not resolve")
    expect(items[0]).toContain("the correct import is '../src/index'")
  })
  it('reports a missing module, a bare package, and Python imports; dedupes repeats', () => {
    const root = repo(['src/index.js'])
    const items = diagnoseVerificationFailure("Cannot find module './game' from 'src/index.js'\nCannot find module './game' from 'src/index.js'\nCannot find module 'lodash' from 'src/index.js'\nModuleNotFoundError: No module named 'engine'", [root])
    expect(items).toHaveLength(3)
    expect(items[0]).toContain('No file named game exists anywhere')
    expect(items[1]).toContain("'lodash' is a package that is not installed")
    expect(items[2]).toContain("Python cannot import 'engine'")
    expect(diagnoseVerificationFailure('expect(received).toBe(expected)', [root])).toEqual([])
  })
})


describe('isStubFile', () => {
  it('flags placeholder modules and accepts real ones, index files and small tests', () => {
    const root = repo([])
    const write = (name: string, text: string) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text); return path.join(root, name) }
    expect(isStubFile(write('src/engine.ts', "import { apply_patch } from '???'\nexport type S = {}\n"))).toBe(true)
    expect(isStubFile(write('src/todo.ts', 'export function f() {\n  // TODO: implement later\n}\n'))).toBe(true)
    expect(isStubFile(write('src/tiny.ts', 'export const a = 1\n'))).toBe(true)
    expect(isStubFile(write('src/real.ts', Array.from({ length: 20 }, (_, n) => `export const v${n} = ${n}`).join('\n')))).toBe(false)
    expect(isStubFile(write('src/index.ts', "export * from './real'\n"))).toBe(false)
    expect(isStubFile(write('tests/a.test.ts', "test('x', () => {\n  expect(1).toBe(1)\n})\n"))).toBe(true)
    expect(isStubFile(write('tests/b.test.ts', Array.from({ length: 6 }, (_, n) => `test('t${n}', () => { expect(${n}).toBe(${n}) })`).join('\n')))).toBe(false)
    expect(isStubFile(path.join(root, 'nope.ts'))).toBe(true)
  })
})

describe('languageProfile / duplicateSibling', () => {
  const dirs: string[] = []
  const repo = (files: Record<string, string>): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lang-'))
    dirs.push(dir)
    for (const [file, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), content) }
    return dir
  }
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('ranks the language with most source files first and lists the others', () => {
    const dir = repo({ 'src/a.py': '', 'src/b.py': '', 'src/c.py': '', 'tools/x.js': '' })
    expect(languageProfile([dir])).toEqual({ primary: 'Python', others: ['JavaScript'] })
  })
  it('breaks a JS/TS tie towards TypeScript when the project declares it', () => {
    const dir = repo({ 'tsconfig.json': '{}', 'src/index.ts': '', 'jest.config.js': '' })
    expect(languageProfile([dir])?.primary).toBe('TypeScript')
    const tsMain = repo({ 'package.json': '{"main":"src/index.ts"}', 'src/index.ts': '', 'a.js': '', 'b.js': '' })
    expect(languageProfile([tsMain])?.primary).toBe('TypeScript')
  })
  it('a plain JS repository stays JavaScript and an empty one has no profile', () => {
    expect(languageProfile([repo({ 'src/a.js': '', 'src/b.js': '' })])).toEqual({ primary: 'JavaScript', others: [] })
    expect(languageProfile([repo({ 'README.md': '' })])).toBeUndefined()
  })
  it('flags only a NEW file that twins an existing primary-language module', () => {
    const dir = repo({ 'tsconfig.json': '{}', 'src/board.ts': 'x', 'src/legacy.js': 'y' })
    expect(duplicateSibling([dir], 'src/board.js', 'TypeScript')).toBe('src/board.ts')
    expect(duplicateSibling([dir], 'src/board.ts', 'TypeScript')).toBeUndefined()
    expect(duplicateSibling([dir], 'src/legacy.js', 'TypeScript')).toBeUndefined()
    expect(duplicateSibling([dir], 'src/other.js', 'TypeScript')).toBeUndefined()
    expect(duplicateSibling([dir], 'src/board.py', 'TypeScript')).toBe('src/board.ts')
    expect(duplicateSibling([dir], 'README', 'TypeScript')).toBeUndefined()
  })
})

describe('siblingTestFile', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  it('points a new variant test file at the module\'s existing test file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tests-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'tests'))
    writeFileSync(path.join(dir, 'tests/board.test.ts'), 'x')
    writeFileSync(path.join(dir, 'tests/board.gravity.test.ts'), 'y')
    expect(siblingTestFile([dir], 'tests/board.tick.test.ts')).toBe('tests/board.test.ts')
    expect(siblingTestFile([dir], 'tests/board.gravity.test.ts')).toBeUndefined() // rewrite
    expect(siblingTestFile([dir], 'tests/board.test.ts')).toBeUndefined() // canonical
    expect(siblingTestFile([dir], 'tests/engine.tick.test.ts')).toBeUndefined() // no canonical yet
    expect(siblingTestFile([dir], 'src/board.ts')).toBeUndefined()
  })
})

describe('locateNamedFile', () => {
  it('accepts the same module in a sibling extension of the language family', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'locate-'))
    try {
      mkdirSync(path.join(dir, 'src'))
      writeFileSync(path.join(dir, 'src/engine.ts'), 'x')
      expect(locateNamedFile([dir], 'src/engine.js')).toBe(path.join(dir, 'src/engine.ts'))
      expect(locateNamedFile([dir], 'src/engine.ts')).toBe(path.join(dir, 'src/engine.ts'))
      expect(locateNamedFile([dir], 'src/engine.py')).toBeUndefined()
      expect(locateNamedFile([dir], 'src/board.js')).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('namedFiles relative paths', () => {
  it('normalises ../ and ./ prefixes and ignores bare file names', () => {
    expect(namedFiles('Wire ../src/tetris.js and ./tetromino.js into ../src/index.js with tests/engine.test.js')).toEqual(['src/tetris.js', 'src/index.js', 'tests/engine.test.js'])
  })
})

describe('feedbackExcerpts', () => {
  it('reads the lines around every file:line the feedback names, in the shapes Jest/Babel, TypeScript and mocha print', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'excerpt-'))
    try {
      mkdirSync(path.join(dir, 'src')); mkdirSync(path.join(dir, 'tests'))
      writeFileSync(path.join(dir, 'src/state.js'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'))
      writeFileSync(path.join(dir, 'tests/game.test.ts'), Array.from({ length: 40 }, (_, i) => `t ${i + 1}`).join('\n'))
      const feedback = [
        `SyntaxError: ${dir}/src/state.js: Identifier 'GameState' has already been declared. (16:21)`,
        'tests/game.test.ts(25,104): error TS1005',
        'at Object.<anonymous> (tests/game.test.ts:33:9)',
        'Cannot find module node_modules/foo/index.js:1:1',
      ].join('\n')
      const out = feedbackExcerpts(feedback, [dir])
      expect(out).toContain('--- src/state.js (lines 1-31, error at 16) ---')
      expect(out).toContain('  16> line 16')
      expect(out).toContain('--- tests/game.test.ts (lines 10-40, error at 25) ---')
      expect(out).toContain('error at 33')
      expect(out).not.toContain('node_modules')
      expect(feedbackExcerpts('nothing here', [dir])).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('isStubFile barrels', () => {
  it('a short file made only of re-exports is a barrel, not a stub', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'barrel-'))
    try {
      writeFileSync(path.join(dir, 'exports.js'), "// Barrel\nexport * from './board.js';\nexport { Game, PieceImpl as Piece } from './game.js';\nexport { default as Renderer } from './renderer.js';\n")
      writeFileSync(path.join(dir, 'cjs.js'), "module.exports = require('./impl.js');\n")
      writeFileSync(path.join(dir, 'tiny.js'), "export function f() { return 1 }\n")
      expect(isStubFile(path.join(dir, 'exports.js'))).toBe(false)
      expect(isStubFile(path.join(dir, 'cjs.js'))).toBe(false)
      expect(isStubFile(path.join(dir, 'tiny.js'))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('new-file guards for small models (observed: src/feature.ts and src/hold.test.js in a vanilla-JS game)', () => {
  let root: string
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  function repo(files: string[]): void {
    root = mkdtempSync(path.join(tmpdir(), 'guards-'))
    for (const file of files) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), '// x\n') }
  }
  it('refuses a new source file in a language a monolingual repository does not use, never a rewrite, a config file or a mixed repository', () => {
    repo(['game.js', 'tests/game.test.js'])
    const js = { primary: 'JavaScript', others: [] }
    expect(foreignLanguageFile([root], 'src/feature.ts', js)).toMatch(/JavaScript-only/)
    expect(foreignLanguageFile([root], 'src/hold.js', js)).toBeUndefined()
    expect(foreignLanguageFile([root], 'game.js', js)).toBeUndefined()
    expect(foreignLanguageFile([root], 'tsconfig.json', js)).toBeUndefined()
    expect(foreignLanguageFile([root], 'src/feature.ts', { primary: 'JavaScript', others: ['TypeScript'] })).toBeUndefined()
    writeFileSync(path.join(root, 'legacy.ts'), '')
    expect(foreignLanguageFile([root], 'legacy.ts', js)).toBeUndefined()
  })
  it('refuses a new test file outside the existing test directory, accepts co-located tests when there is none', () => {
    repo(['game.js', 'tests/game.test.js'])
    expect(misplacedTestFile([root], 'src/hold.test.js')).toMatch(/under tests\//)
    expect(misplacedTestFile([root], 'tests/hold.test.js')).toBeUndefined()
    expect(misplacedTestFile([root], 'src/hold.js')).toBeUndefined()
    expect(misplacedTestFile([root], 'tests/game.test.js')).toBeUndefined()
    rmSync(root, { recursive: true, force: true }); repo(['src/game.js', 'src/game.test.js'])
    expect(misplacedTestFile([root], 'src/hold.test.js')).toBeUndefined()
  })
})

describe('binary asset pattern', () => {
  it('matches media the text-only write tool cannot produce, never source or data files', () => {
    for (const file of ['audio/move.wav', 'assets/bg.mp3', 'img/logo.png', 'fonts/x.woff2', 'a.PNG']) expect(BINARY_ASSET.test(file), file).toBe(true)
    for (const file of ['game.js', 'style.css', 'index.html', 'data.json', 'README.md', 'scripts/generate-audio.js', 'audio/index.js']) expect(BINARY_ASSET.test(file), file).toBe(false)
  })
})
