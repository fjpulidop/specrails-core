import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const dispatcher = path.resolve(here, '..', '..', 'bin', 'specrails-core.mjs')

interface Profile {
  schemaVersion: number
  name: string
  orchestrator: { model: string }
  agents: Array<{ id: string; model: string }>
  routing: Array<
    | { tags: string[]; agent: string }
    | { default: true; agent: string }
  >
}

function baselineProfile(): Profile {
  return {
    schemaVersion: 1,
    name: 'semantic-validation',
    orchestrator: { model: 'sonnet' },
    agents: [
      { id: 'sr-architect', model: 'sonnet' },
      { id: 'sr-developer', model: 'sonnet' },
      { id: 'sr-reviewer', model: 'sonnet' },
    ],
    routing: [{ default: true, agent: 'sr-developer' }],
  }
}

describe('profile validate semantic invariants', () => {
  let root: string
  let sequence: number

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'specrails-profile-cli-'))
    sequence = 0
  })

  afterEach(() => {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  })

  function validate(profile: Profile) {
    const profilePath = path.join(root, `profile-${sequence++}.json`)
    writeFileSync(profilePath, `${JSON.stringify(profile)}\n`)
    return spawnSync(
      process.execPath,
      [dispatcher, 'profile', 'validate', profilePath],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          SPECRAILS_REGISTRY_HOME: path.join(root, 'home'),
        },
      },
    )
  }

  it('accepts valid routing and keeps an empty routing list valid', () => {
    const routed = validate(baselineProfile())
    expect(routed.status).toBe(0)
    expect(routed.stderr).toBe('')

    const empty = baselineProfile()
    empty.routing = []
    const emptyResult = validate(empty)
    expect(emptyResult.status).toBe(0)
    expect(emptyResult.stderr).toBe('')
  })

  it('rejects duplicate agent ids after schema validation', () => {
    const profile = baselineProfile()
    profile.agents.push({ id: 'sr-developer', model: 'sonnet' })

    const result = validate(profile)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      '/agents/3/id duplicates agent id "sr-developer"',
    )
  })

  it('rejects routing rules that reference an absent agent', () => {
    const profile = baselineProfile()
    profile.routing = [{ default: true, agent: 'custom-missing' }]

    const result = validate(profile)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      '/routing/0/agent references unknown agent "custom-missing"',
    )
  })

  it('rejects multiple default routing rules', () => {
    const profile = baselineProfile()
    profile.routing = [
      { default: true, agent: 'sr-architect' },
      { default: true, agent: 'sr-developer' },
    ]

    const result = validate(profile)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      '/routing must contain at most one default rule (found 2)',
    )
  })

  it('rejects a default routing rule that is not terminal', () => {
    const profile = baselineProfile()
    profile.routing = [
      { default: true, agent: 'sr-developer' },
      { tags: ['architecture'], agent: 'sr-architect' },
    ]

    const result = validate(profile)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      '/routing/0 default rule must be the last routing entry',
    )
  })
})
