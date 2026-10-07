import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GLOBAL_SESSION_SCOPE, isSessionScopeKey, sessionsRoot, specrailsHome, userHome } from './specrails-home.js'

describe('specrails home', () => {
  let saved: string | undefined
  beforeEach(() => { saved = process.env.SPECRAILS_REGISTRY_HOME })
  afterEach(() => {
    if (saved === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = saved
  })

  it('prefers an explicit home, then SPECRAILS_REGISTRY_HOME, then the OS home', () => {
    process.env.SPECRAILS_REGISTRY_HOME = '/tmp/registry-home'
    expect(userHome('/explicit')).toBe('/explicit')
    expect(userHome()).toBe('/tmp/registry-home')
    delete process.env.SPECRAILS_REGISTRY_HOME
    expect(userHome()).toBe(os.homedir())
  })

  it('places .specrails under the resolved home', () => {
    expect(specrailsHome('/h')).toBe(path.join('/h', '.specrails'))
  })

  it('groups session journals per scope outside any repository', () => {
    expect(sessionsRoot('my-project', '/h')).toBe(path.join('/h', '.specrails', 'sessions', 'my-project'))
    expect(sessionsRoot(GLOBAL_SESSION_SCOPE, '/h')).toBe(path.join('/h', '.specrails', 'sessions', 'global'))
  })

  it.each(['', '-lead', 'trail-', 'Upper', 'has space', '../escape', 'a/b', 'a'.repeat(129)])('rejects unsafe scope %j', (scope) => {
    expect(isSessionScopeKey(scope)).toBe(false)
    expect(() => sessionsRoot(scope, '/h')).toThrow(/Invalid session scope/)
  })

  it.each(['a', 'my-project', 'p1', 'a'.repeat(128)])('accepts scope %j', (scope) => {
    expect(isSessionScopeKey(scope)).toBe(true)
  })
})
