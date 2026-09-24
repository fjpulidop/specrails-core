import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Dependency direction between the source modules:
 *
 *   shared   ← pipeline ← agent-runtime ← installer (lazily, for `runtime`)
 *
 * `pipeline/pipeline-state.ts` is copied on its own into every project as
 * `.specrails/runtime/pipeline-state.mjs`, so it may import Node built-ins only.
 */
const SRC = path.dirname(fileURLToPath(import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(path.join(SRC, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => path.join(dir, file))
}

function imports(file: string): string[] {
  const text = readFileSync(path.join(SRC, file), 'utf8')
  return [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]!)
}

function resolved(file: string, specifier: string): string {
  return path.relative(SRC, path.resolve(path.join(SRC, path.dirname(file)), specifier)).split(path.sep).join('/')
}

describe('source architecture', () => {
  it.each([
    ['shared', ['pipeline/', 'agent-runtime/', 'installer/']],
    ['pipeline', ['shared/', 'agent-runtime/', 'installer/']],
    ['agent-runtime', ['installer/']],
  ])('%s never imports %j', (module, forbidden) => {
    const violations = sources(module).flatMap((file) =>
      imports(file)
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) => resolved(file, specifier))
        .filter((target) => forbidden.some((prefix) => target.startsWith(prefix)))
        .map((target) => `${file} → ${target}`),
    )
    expect(violations).toEqual([])
  })

  it('keeps the copied pipeline runtime free of package dependencies', () => {
    const external = imports(path.join('pipeline', 'pipeline-state.ts')).filter((specifier) => !specifier.startsWith('node:'))
    expect(external).toEqual([])
  })
})
