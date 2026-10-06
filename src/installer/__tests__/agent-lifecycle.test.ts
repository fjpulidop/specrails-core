import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Entry-point invariants. The programmatic runtime owns the lifecycle
 * (architect → developer → verify → reviewer → archive) and defines every
 * role itself; the installed entry points only hand control to it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (...parts: string[]): string => readFileSync(path.join(repoRoot, 'templates', ...parts), 'utf8')

describe('implementation entry points use the programmatic lifecycle', () => {
  it.each(['implement', 'retry'])('%s delegates lifecycle control to the runtime', (name) => {
    const text = read('commands', 'specrails', `${name}.md`)
    expect(text).toContain('agent-runtime.mjs')
    expect(text).toContain('resume --context')
    expect(text).not.toContain('spawn_agent')
  })
})
