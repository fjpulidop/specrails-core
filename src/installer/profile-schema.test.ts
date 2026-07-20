import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { ValidateFunction } from 'ajv'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const Ajv2020 = (
  require('ajv/dist/2020.js') as {
    default: new (options: Record<string, unknown>) => {
      compile: (schema: object) => ValidateFunction
    }
  }
).default

function validator(): ValidateFunction {
  const schema = JSON.parse(
    readFileSync(path.join(process.cwd(), 'schemas', 'profile.v1.json'), 'utf8'),
  ) as object
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema)
}

function baselineProfile(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'baseline',
    orchestrator: { model: 'sonnet' },
    agents: [
      { id: 'sr-architect', model: 'sonnet' },
      { id: 'sr-developer', model: 'sonnet' },
      { id: 'sr-reviewer', model: 'sonnet' },
    ],
    routing: [{ default: true, agent: 'sr-developer' }],
  }
}

describe('profile.v1 provider-aware models', () => {
  it('keeps legacy provider-less Claude profiles valid', () => {
    expect(validator()(baselineProfile())).toBe(true)
  })

  it('accepts exact Kimi model ids and custom role references', () => {
    const profile = {
      ...baselineProfile(),
      provider: 'kimi',
      orchestrator: { model: 'k3' },
      agents: [
        { id: 'sr-architect', model: 'k3' },
        { id: 'sr-developer', model: 'kimi-for-coding-highspeed' },
        { id: 'custom-auditor', model: 'my-provider/exact-model' },
        { id: 'sr-reviewer', model: 'kimi-code/kimi-for-coding' },
      ],
    }
    const validate = validator()
    expect(validate(profile), JSON.stringify(validate.errors)).toBe(true)
    expect((profile.orchestrator as { model: string }).model).toBe('k3')
    expect((profile.agents[2] as { model: string }).model).toBe(
      'my-provider/exact-model',
    )
  })

  it('retains a custom Kimi alias even when its literal name matches a Claude alias', () => {
    const profile = {
      ...baselineProfile(),
      provider: 'kimi',
      orchestrator: { model: 'sonnet' },
      agents: [
        { id: 'sr-architect', model: 'k3' },
        { id: 'sr-developer', model: 'k3' },
        { id: 'sr-reviewer', model: 'k3' },
      ],
    }
    const validate = validator()
    expect(validate(profile), JSON.stringify(validate.errors)).toBe(true)
    expect((profile.orchestrator as { model: string }).model).toBe('sonnet')
  })

  it.each([
    'team model',
    '"; touch /tmp/specrails-pwned; #',
    '--auto',
    `a${'b'.repeat(128)}`,
  ])('rejects Kimi model ids that cannot cross the runtime boundary: %j', (model) => {
    const profile = {
      ...baselineProfile(),
      provider: 'kimi',
      orchestrator: { model },
      agents: [
        { id: 'sr-architect', model: 'k3' },
        { id: 'sr-developer', model: 'k3' },
        { id: 'sr-reviewer', model: 'k3' },
      ],
    }
    expect(validator()(profile)).toBe(false)
  })

  it('ships a valid Kimi default with explicit k3 identifiers', () => {
    const profile = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'templates', 'profiles', 'kimi-default.json'),
        'utf8',
      ),
    ) as { provider: string; orchestrator: { model: string }; agents: Array<{ model?: string }> }
    const validate = validator()
    expect(validate(profile), JSON.stringify(validate.errors)).toBe(true)
    expect(profile.provider).toBe('kimi')
    expect(profile.orchestrator.model).toBe('k3')
    expect(profile.agents.every((agent) => agent.model === 'k3')).toBe(true)
  })
})
