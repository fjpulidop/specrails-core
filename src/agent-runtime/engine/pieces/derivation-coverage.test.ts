import { describe, expect, it } from 'vitest'
import { blastRadiusCoverage, blastRadiusSection, countRequirements, coverageLabel, transcriptTurns } from './derivation-coverage.js'

const file = (path: string, repositoryId = 'repo') => ({ repositoryId, path })
const design = (radius: string, tail = '## Non-Goals\n- `src/out-of-radius.ts` is not a goal\n') => `# Design\n\n## Context\nMentions \`src/context-only.ts\`.\n\n## Blast radius\n${radius}\n${tail}`

describe('blast radius section', () => {
  it('ends at the next heading of the same or a higher level and keeps nested headings', () => {
    const section = blastRadiusSection('## Blast Radius\n- `a.ts`\n### Tests\n- `a.test.ts`\n## Rejected alternatives\n- `b.ts`\n')
    expect(section).toContain('a.test.ts')
    expect(section).not.toContain('b.ts')
  })

  it('accepts numbered and bold headings, ignores headings inside fences and reports a missing section', () => {
    expect(blastRadiusSection('### 3. **Blast radius**\n- `x.ts`')).toContain('x.ts')
    expect(blastRadiusSection('```md\n## Blast radius\n```\n- `x.ts`')).toBeUndefined()
    expect(blastRadiusSection('## Blast radius\n```\n## not a heading\n```\n- `y.ts`\n## Next')).toContain('y.ts')
    expect(blastRadiusSection('## Design\nNo radius.')).toBeUndefined()
  })
})

describe('blast radius coverage', () => {
  it('explains only files named inside the section', () => {
    const result = blastRadiusCoverage(design('- `src/a.ts`: why\n- src/b.ts — plain text'), [file('src/a.ts'), file('src/b.ts'), file('src/context-only.ts'), file('src/out-of-radius.ts')], false)
    expect(result.explained.map(item => item.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.unexplained.map(item => item.path)).toEqual(['src/context-only.ts', 'src/out-of-radius.ts'])
  })

  it('matches whole paths only: no prefix, suffix or parent-directory confusion', () => {
    const result = blastRadiusCoverage(design('- `lib/src/a.ts`\n- `src/a.tsx`\n- `src/` (directory)\n- src/b.ts.'), [file('src/a.ts'), file('a.ts'), file('src/b.ts'), file('src/b.t')], false)
    expect(result.explained.map(item => item.path)).toEqual(['src/b.ts'])
  })

  it('handles spaces, unicode, markdown escapes, ./ prefixes and Windows separators', () => {
    const decomposed = 'docs/café.md'
    const result = blastRadiusCoverage(design('- `docs/my file.md`\n- docs/café.md\n- my\\_module\\_name.ts\n- `./scripts/run.sh`\n- `tools\\gen.js`'),
      [file('docs/my file.md'), file(decomposed), file('my_module_name.ts'), file('scripts/run.sh'), file('tools/gen.js'), file('my file.md')], false)
    expect(result.unexplained.map(item => item.path)).toEqual(['my file.md'])
  })

  it('accepts bare or repository-qualified paths with several repositories and labels them by repository', () => {
    const files = [file('src/a.ts', 'api'), file('src/a.ts', 'web'), file('README.md', 'web'), file('lib/x.ts', 'api')]
    const result = blastRadiusCoverage(design('- `web/README.md`\n- `api:lib/x.ts`\n- `src/a.ts` in both'), files, true)
    expect(result.unexplained).toEqual([])
    const partial = blastRadiusCoverage(design('- `web/README.md`'), files, true)
    expect(partial.unexplained.map(item => coverageLabel(item, true))).toEqual(['api:src/a.ts', 'web:src/a.ts', 'api:lib/x.ts'])
    expect(coverageLabel(file('src/a.ts'), false)).toBe('src/a.ts')
  })

  it('reports every file unexplained without a Blast radius section', () => {
    expect(blastRadiusCoverage('## Design\n- `src/a.ts`\n', [file('src/a.ts')], false).unexplained).toHaveLength(1)
    expect(blastRadiusCoverage('', [file('src/a.ts')], false).explained).toEqual([])
  })
})

describe('derivation counters', () => {
  it('counts added and modified requirements, never removed ones or fenced examples', () => {
    const spec = '## ADDED Requirements\n### Requirement: One\nx\n### Requirement: Two\nx\n```\n### Requirement: Fenced\n```\n## MODIFIED Requirements\n### Requirement: Three\nx\n## REMOVED Requirements\n### Requirement: Gone\n## Notes\n### Requirement: Stray\n'
    expect(countRequirements([spec, '## ADDED Requirements\n### Requirement: Four\n'])).toEqual({ added: 3, modified: 1 })
    expect(countRequirements([])).toEqual({ added: 0, modified: 0 })
  })

  it('reads transcriptTurns only from leading front matter', () => {
    expect(transcriptTurns('---\nsource: flow\ntranscriptTurns: 18\n---\n# Summary\n')).toBe(18)
    expect(transcriptTurns('# Summary\ntranscriptTurns: 4\n')).toBe(0)
    expect(transcriptTurns('---\ntranscriptTurns: many\n---\n')).toBe(0)
    expect(transcriptTurns('')).toBe(0)
  })
})
