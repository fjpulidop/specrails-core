import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

  describe('agent session runtime layering', () => {
    // domain ← application ← (drivers | journal | host) ← session/index.ts ← cli.ts
    // Adapters meet only in the composition root; provider vocabulary stays in its driver.
    const SESSION = 'agent-runtime/session/'
    const posix = (file: string) => file.split(path.sep).join('/')
    const existing = (dir: string) => existsSync(path.join(SRC, dir)) ? sources(dir) : []
    const relativeTargets = (file: string) => imports(file).filter((s) => s.startsWith('.')).map((s) => resolved(file, s))
    const outside = (file: string, allowed: string[]) =>
      relativeTargets(file).filter((target) => !allowed.some((prefix) => target === prefix || target.startsWith(prefix))).map((target) => `${file} → ${target}`)

    it('keeps the domain pure', () => {
      const violations = existing(`${SESSION}domain`).flatMap((file) => [
        ...outside(file, [`${SESSION}domain/`, 'shared/']),
        ...imports(file).filter((s) => !s.startsWith('.')).map((s) => `${file} → ${s}`),
      ])
      expect(violations).toEqual([])
    })

    it('lets application code see only the domain and ports', () => {
      const violations = existing(`${SESSION}application`).flatMap((file) => [
        ...outside(file, [`${SESSION}domain/`, `${SESSION}application/`, `${SESSION}ports.js`, 'shared/']),
        ...imports(file).filter((s) => !s.startsWith('.')).map((s) => `${file} → ${s}`),
      ])
      expect(violations).toEqual([])
    })

    it.each([
      ['drivers', ['journal/', 'host/', 'application/']],
      ['journal', ['drivers/', 'host/', 'application/']],
      ['host', ['drivers/', 'journal/']],
    ])('keeps session/%s isolated from %j', (adapter, forbidden) => {
      const violations = existing(`${SESSION}${adapter}`).flatMap((file) =>
        relativeTargets(file)
          .filter((target) => forbidden.some((prefix) => target.startsWith(`${SESSION}${prefix}`)))
          .map((target) => `${file} → ${target}`))
      expect(violations).toEqual([])
    })

    it('keeps each provider driver independent of the others', () => {
      // agent-runtime/session/drivers/<driver>/<file>: a driver may use `common/`, never
      // another driver. Top-level files (the registry) may wire every driver.
      const driverOf = (p: string) => { const parts = p.split('/'); return parts.length > 4 ? parts[3]! : null }
      const violations = existing(`${SESSION}drivers`).flatMap((file) => {
        const own = driverOf(posix(file))
        if (!own || own === 'common') return []
        return relativeTargets(file)
          .filter((target) => { const other = target.startsWith(`${SESSION}drivers/`) ? driverOf(target) : null; return other !== null && other !== own && other !== 'common' })
          .map((target) => `${posix(file)} → ${target}`)
      })
      expect(violations).toEqual([])
    })

    it('exposes the host only to the runtime CLI', () => {
      const violations = sources('.')
        .filter((file) => !posix(file).startsWith(`${SESSION}host/`) && posix(file) !== 'agent-runtime/cli.ts')
        .flatMap((file) => relativeTargets(file).filter((target) => target.startsWith(`${SESSION}host/`)).map((target) => `${file} → ${target}`))
      expect(violations).toEqual([])
    })

    it('never branches on provider ids outside the drivers', () => {
      const providerCheck = /[=!]==?\s*['"](?:claude|codex|gemini|kimi|openai-compatible)['"]|['"](?:claude|codex|gemini|kimi|openai-compatible)['"]\s*[=!]==?/
      const violations = ['domain', 'application', 'journal', 'host']
        .flatMap((dir) => existing(`${SESSION}${dir}`))
        .filter((file) => providerCheck.test(readFileSync(path.join(SRC, file), 'utf8')))
      expect(violations).toEqual([])
    })
  })

  it('keeps the copied pipeline runtime free of package dependencies', () => {
    const external = imports(path.join('pipeline', 'pipeline-state.ts')).filter((specifier) => !specifier.startsWith('node:'))
    expect(external).toEqual([])
  })
})
