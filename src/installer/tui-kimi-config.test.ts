import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import yaml from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('TUI Kimi default config', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-tui-kimi-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('renders provider-native k3 identifiers instead of Claude aliases', () => {
    const binDir = path.join(tmpDir, 'bin')
    const target = path.join(tmpDir, 'project')
    const fakeKimi =
      process.platform === 'win32'
        ? path.join(binDir, 'kimi.cmd')
        : path.join(binDir, 'kimi')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      fakeKimi,
      process.platform === 'win32'
        ? '@echo off\r\necho kimi 0.27.0\r\n'
        : '#!/bin/sh\nprintf "kimi 0.27.0\\n"\n',
    )
    if (process.platform !== 'win32') chmodSync(fakeKimi, 0o755)

    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), 'bin', 'tui-installer.mjs'),
        target,
        '--yes',
        '--provider',
        'kimi',
        '--with-profiles',
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        },
        stdio: 'pipe',
      },
    )

    const raw = readFileSync(
      path.join(target, '.specrails', 'install-config.yaml'),
      'utf8',
    )
    const config = yaml.load(raw) as {
      provider: string
      models: {
        preset: string
        defaults: { model: string }
        overrides: Record<string, string>
      }
    }
    expect(config.provider).toBe('kimi')
    expect(config.models).toEqual({
      preset: 'balanced',
      defaults: { model: 'k3' },
      overrides: {},
    })
    expect(raw).not.toMatch(/\b(?:sonnet|opus|haiku)\b/)

    const profile = JSON.parse(
      readFileSync(
        path.join(target, '.specrails', 'profiles', 'kimi-default.json'),
        'utf8',
      ),
    ) as { name: string; provider: string; orchestrator: { model: string } }
    expect(profile).toMatchObject({
      name: 'kimi-default',
      provider: 'kimi',
      orchestrator: { model: 'k3' },
    })
    expect(() =>
      readFileSync(
        path.join(target, '.specrails', 'profiles', 'project-default.json'),
        'utf8',
      ),
    ).toThrow()
  })

  it.each([
    ['--provider', 'unknown'],
    ['--provider=unknown'],
    ['--provider'],
  ])('rejects an explicit invalid provider instead of opening the picker: %j', (...providerArgs) => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'bin', 'tui-installer.mjs'),
        tmpDir,
        '--yes',
        ...providerArgs,
      ],
      {
        env: { ...process.env, PATH: '' },
        encoding: 'utf8',
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/--provider/)
    expect(result.stderr).toMatch(/claude, codex, gemini, kimi/)
  })

  it('bounds a hung provider version probe', () => {
    const binDir = path.join(tmpDir, 'hung-bin')
    const target = path.join(tmpDir, 'hung-project')
    const fakeKimi =
      process.platform === 'win32'
        ? path.join(binDir, 'kimi.cmd')
        : path.join(binDir, 'kimi')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      fakeKimi,
      process.platform === 'win32'
        ? '@echo off\r\n%SystemRoot%\\System32\\ping.exe -n 20 127.0.0.1 >nul\r\necho kimi 0.27.0\r\n'
        : '#!/bin/sh\n/bin/sleep 10\nprintf "kimi 0.27.0\\n"\n',
    )
    if (process.platform !== 'win32') chmodSync(fakeKimi, 0o755)

    const started = Date.now()
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'bin', 'tui-installer.mjs'),
        target,
        '--yes',
        '--provider',
        'kimi',
      ],
      {
        env: {
          ...process.env,
          PATH: binDir,
          SPECRAILS_PROVIDER_PROBE_TIMEOUT_MS: '100',
        },
        encoding: 'utf8',
        timeout: 5_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      '--provider kimi requested but Kimi Code is not installed',
    )
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
