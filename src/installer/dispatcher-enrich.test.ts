import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const dispatcher = path.resolve(here, '..', '..', 'bin', 'specrails-core.mjs')

describe('specrails-core Kimi enrich launcher', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'specrails-enrich-launch-'))
  })

  afterEach(() => {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  })

  it('resolves a relocated runner/cwd and applies CLI > active profile > config model precedence', () => {
    const home = path.join(root, 'home')
    const repo = path.join(root, 'repo')
    // Registry rows are untrusted and accepted only at the immutable
    // `<home>/.specrails/projects/<slug>/workspace` location. Keep this
    // integration fixture on the real cross-repo layout so a stricter compiled
    // registry cannot silently make enrich fall back to the in-repo provider.
    const workspace = path.join(
      home,
      '.specrails',
      'projects',
      'repo',
      'workspace',
    )
    const capture = path.join(root, 'capture.jsonl')
    mkdirSync(path.join(repo, '.specrails', 'profiles'), { recursive: true })
    mkdirSync(path.join(workspace, '.specrails'), { recursive: true })
    mkdirSync(path.join(workspace, '.kimi-code', 'specrails'), {
      recursive: true,
    })
    writeFileSync(
      path.join(repo, '.specrails', 'profiles', 'active.json'),
      '{"orchestrator":{"model":"profile/model-v2"}}\n',
    )
    writeFileSync(
      path.join(workspace, '.specrails', 'install-config.yaml'),
      [
        'version: 1',
        'provider: kimi',
        'models:',
        '  preset: balanced',
        '  defaults: { model: config/model-v1 }',
        '  overrides: {}',
        '',
      ].join('\n'),
    )
    writeFileSync(
      path.join(workspace, '.kimi-code', 'specrails', 'run-skill.mjs'),
      [
        "import { appendFileSync } from 'node:fs'",
        "appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),repo:process.env.SPECRAILS_REPO_DIR})+'\\n')",
        '',
      ].join('\n'),
    )

    const canonicalRepo = realpathSync(repo)
    const key =
      process.platform === 'darwin' || process.platform === 'win32'
        ? canonicalRepo.toLowerCase()
        : canonicalRepo
    const registryDir = path.join(home, '.specrails')
    mkdirSync(registryDir, { recursive: true })
    writeFileSync(
      path.join(registryDir, 'registry.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        projects: {
          [key]: {
            repoPath: canonicalRepo,
            slug: 'repo',
            workspaceDir: workspace,
            artifactRoot: workspace,
            codeRoot: canonicalRepo,
            stateDir: path.join(workspace, '.kimi-code'),
            ticketsPath: path.join(workspace, '.specrails', 'local-tickets.json'),
            backlogConfigPath: path.join(
              workspace,
              '.specrails',
              'backlog-config.json',
            ),
            profilesDir: path.join(workspace, '.specrails', 'profiles'),
            pluginsStateDir: path.join(workspace, '.specrails', 'plugins'),
            fileSummariesDir: path.join(
              workspace,
              '.specrails',
              'file-summaries',
            ),
            providers: ['kimi'],
            primaryProvider: 'kimi',
            source: 'desktop',
          },
        },
      })}\n`,
    )

    const launch = (
      args: string[],
      extraEnv: Record<string, string | undefined> = {},
    ) =>
      spawnSync(process.execPath, [dispatcher, 'enrich', ...args], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          SPECRAILS_REGISTRY_HOME: home,
          CAPTURE_FILE: capture,
          ...extraEnv,
        },
      })

    const expectLaunchSuccess = (result: ReturnType<typeof launch>) => {
      expect(
        result.status,
        `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
      ).toBe(0)
    }

    expectLaunchSuccess(launch([], {
      SPECRAILS_PROFILE_PATH: '.specrails/profiles/active.json',
    }))
    expectLaunchSuccess(
      launch([], { SPECRAILS_PROFILE_PATH: undefined }),
    )
    expectLaunchSuccess(launch(['--model', 'cli/model-v3'], {
      SPECRAILS_PROFILE_PATH: undefined,
    }))

    const records = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[]
            cwd: string
            repo: string
          },
      )
    expect(records).toHaveLength(3)
    expect(records.map((record) => record.args)).toEqual([
      [
        '--skill',
        'specrails-enrich',
        '--model',
        'profile/model-v2',
        '--add-dir',
        canonicalRepo,
      ],
      [
        '--skill',
        'specrails-enrich',
        '--model',
        'config/model-v1',
        '--add-dir',
        canonicalRepo,
      ],
      [
        '--skill',
        'specrails-enrich',
        '--model',
        'cli/model-v3',
        '--add-dir',
        canonicalRepo,
      ],
    ])
    for (const record of records) {
      expect(record.cwd).toBe(realpathSync(workspace))
      expect(record.repo).toBe(canonicalRepo)
    }
  })
})
