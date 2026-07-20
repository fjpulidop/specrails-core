import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildKimiInvocation,
  extractKimiSessionHint,
  KIMI_SKILL_RUNNER_PATH,
  normalizeKimiCliModel,
  parseKimiStreamLine,
} from './kimi.js'

describe('Kimi headless invocation', () => {
  it('routes skill execution through the managed runner instead of literal /skill text', () => {
    expect(
      buildKimiInvocation({
        model: 'k3',
        skill: 'specrails-implement',
        skillArguments: '#42',
      }),
    ).toEqual({
      bin: 'node',
      args: [
        '.kimi-code/specrails/run-skill.mjs',
        '--skill',
        'specrails-implement',
        '--model',
        'k3',
        '--args',
        '#42',
      ],
      env: {
        KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
        KIMI_DISABLE_CRON: '1',
        KIMI_CODE_NO_AUTO_UPDATE: '1',
        KIMI_MODEL_THINKING_EFFORT: undefined,
      },
      prompt: '',
    })
  })

  it('adds a known session and thinking effort without server or skills-dir flags', () => {
    const invocation = buildKimiInvocation({
      model: 'kimi-code/k3',
      prompt: 'continue the review',
      sessionId: 'ses_123',
      thinkingEffort: 'high',
      additionalDirs: ['/repo/source', '/repo/worktree'],
    })
    expect(invocation).toMatchObject({
      bin: 'node',
      stdinText: 'continue the review',
      prompt: 'continue the review',
    })
    expect(invocation.args).toEqual([
      '.kimi-code/specrails/run-skill.mjs',
      '--plain-prompt-stdin',
      '--model',
      'kimi-code/k3',
      '--session=ses_123',
      '--add-dir',
      '/repo/source',
      '--add-dir',
      '/repo/worktree',
    ])
    expect(invocation.args).not.toContain('continue the review')
    expect(invocation.env).toEqual({
      KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_THINKING_EFFORT: 'high',
    })
    expect(invocation.args).not.toContain('--skills-dir')
    expect(invocation.args).not.toContain('server')
  })

  it('binds option-like session ids into a single CLI argument', () => {
    const invocation = buildKimiInvocation({
      model: 'k3',
      prompt: 'continue safely',
      sessionId: '--auto',
    })
    expect(invocation.args).toContain('--session=--auto')
    expect(invocation.args).not.toContain('-S')
  })

  it('rejects unsafe session ids for both plain prompts and skills', () => {
    for (const sessionId of [
      '',
      '.',
      '..',
      'session/escape',
      'session with spaces',
      ' ses_1',
      'ses_1 ',
      'x'.repeat(129),
    ]) {
      expect(() =>
        buildKimiInvocation({
          model: 'k3',
          prompt: 'continue safely',
          sessionId,
        }),
      ).toThrow(/session id/)
      expect(() =>
        buildKimiInvocation({
          model: 'k3',
          skill: 'sr-reviewer',
          sessionId,
        }),
      ).toThrow(/session id/)
    }
  })

  it('emits thinking effort only for raw or prefixed K3', () => {
    expect(
      buildKimiInvocation({
        model: 'k3',
        prompt: 'think',
        thinkingEffort: 'max',
      }).env,
    ).toEqual({
      KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_THINKING_EFFORT: 'max',
    })
    expect(
      buildKimiInvocation({
        model: 'kimi-for-coding',
        prompt: 'think',
        thinkingEffort: 'max',
      }).env,
    ).toEqual({
      KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_THINKING_EFFORT: undefined,
    })
    expect(
      buildKimiInvocation({
        model: 'company/custom',
        prompt: 'think',
        thinkingEffort: 'high',
      }).env,
    ).toEqual({
      KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_THINKING_EFFORT: undefined,
    })
  })

  it('retains arbitrary provider model ids and normalizes only official short ids', () => {
    expect(normalizeKimiCliModel('k3')).toBe('kimi-code/k3')
    expect(normalizeKimiCliModel('kimi-for-coding-highspeed')).toBe(
      'kimi-code/kimi-for-coding-highspeed',
    )
    expect(normalizeKimiCliModel('my-provider/exact-model')).toBe(
      'my-provider/exact-model',
    )
    expect(normalizeKimiCliModel('sonnet')).toBe('sonnet')
  })

  it.each([
    '',
    '--yolo',
    'team model',
    ' team/model',
    'team/model ',
    'team/model\n--yolo',
    'team/model\u0001',
    `a${'b'.repeat(128)}`,
  ])('rejects unsafe model id %j before building spawn argv', (model) => {
    expect(() => normalizeKimiCliModel(model)).toThrow(/model id/)
    expect(() =>
      buildKimiInvocation({
        model,
        skill: 'sr-reviewer',
      }),
    ).toThrow(/model id/)
  })

  it('delegates absolute attachment paths to the managed skill runner', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'specrails-kimi-attachments-'))
    try {
      const report = path.join(directory, 'report.txt')
      const screenshot = path.join(directory, 'screenshot.png')
      writeFileSync(report, 'report')
      writeFileSync(screenshot, 'png')
      const invocation = buildKimiInvocation({
        model: 'k3',
        skill: 'sr-reviewer',
        attachmentPaths: [report, screenshot],
      })
      expect(invocation.bin).toBe('node')
      expect(invocation.args).toContain('.kimi-code/specrails/run-skill.mjs')
      expect(invocation.args).toContain('sr-reviewer')
      expect(invocation.args).toContain(realpathSync(report))
      expect(invocation.args).toContain(realpathSync(screenshot))
      expect(invocation.args).not.toContain('/skill:sr-reviewer')
      expect(invocation.args.filter((arg) => arg === '--attachment')).toHaveLength(2)
      expect(invocation.args.filter((arg) => arg === '--add-dir')).toHaveLength(1)
      expect(invocation.args).toContain(realpathSync(directory))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('exposes attachment parents for plain prompts without duplicate add-dir flags', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'specrails-kimi-plain-'))
    try {
      const attachment = path.join(directory, 'evidence.txt')
      writeFileSync(attachment, 'evidence')
      const invocation = buildKimiInvocation({
        model: 'k3',
        prompt: 'inspect',
        attachmentPaths: [attachment],
        additionalDirs: [directory],
      })
      expect(invocation.args.filter((arg) => arg === '--add-dir')).toHaveLength(1)
      expect(invocation.args).toContain(realpathSync(directory))
      expect(invocation.prompt).toContain(realpathSync(attachment))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves custom aliases and multiline Unicode skill arguments as argv', () => {
    const invocation = buildKimiInvocation({
      model: 'company/Kimi-Custom:v2',
      skill: 'custom-auditor',
      skillArguments: 'línea uno\n第二行 🚀',
      sessionId: 'ses_123',
      additionalDirs: ['/repo/source'],
    })
    expect(invocation.bin).toBe('node')
    expect(invocation.args).toEqual([
      '.kimi-code/specrails/run-skill.mjs',
      '--skill',
      'custom-auditor',
      '--model',
      'company/Kimi-Custom:v2',
      '--args',
      'línea uno\n第二行 🚀',
      '--session=ses_123',
      '--add-dir',
      '/repo/source',
    ])
    expect(invocation.args.join('\n')).not.toContain('/skill:')
  })

  it('rejects relative attachments and malformed skill names', () => {
    expect(() =>
      buildKimiInvocation({
        model: 'k3',
        prompt: 'inspect',
        attachmentPaths: ['relative.png'],
      }),
    ).toThrow(/must be absolute/)
    expect(() =>
      buildKimiInvocation({ model: 'k3', skill: '/skill:specrails-implement' }),
    ).toThrow(/invalid Kimi skill/)
  })

  it('rejects missing, directory, symlink, and unreadable attachments', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'specrails-kimi-invalid-'))
    const regular = path.join(directory, 'regular.txt')
    const nestedDirectory = path.join(directory, 'nested')
    const link = path.join(directory, 'link.txt')
    writeFileSync(regular, 'secret')
    mkdirSync(nestedDirectory)
    try {
      for (const attachment of [
        path.join(directory, 'missing.txt'),
        nestedDirectory,
      ]) {
        expect(() =>
          buildKimiInvocation({
            model: 'k3',
            skill: 'sr-reviewer',
            attachmentPaths: [attachment],
          }),
        ).toThrow(/regular non-symlink file/)
      }

      if (process.platform !== 'win32') {
        symlinkSync(regular, link)
        expect(() =>
          buildKimiInvocation({
            model: 'k3',
            skill: 'sr-reviewer',
            attachmentPaths: [link],
          }),
        ).toThrow(/regular non-symlink file/)

        chmodSync(regular, 0o000)
        expect(() =>
          buildKimiInvocation({
            model: 'k3',
            skill: 'sr-reviewer',
            attachmentPaths: [regular],
          }),
        ).toThrow(/regular non-symlink file/)
        chmodSync(regular, 0o600)
      }
    } finally {
      try {
        chmodSync(regular, 0o600)
      } catch {
        // The file may already have been removed by a failed setup.
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('publishes helper argv, never literal slash text, for headless enrich', () => {
    const contract = JSON.parse(
      readFileSync(path.join(process.cwd(), 'integration-contract.json'), 'utf8'),
    ) as {
      providers: {
        kimi: {
          cli: {
            binary: string
            skillRunner: string
            nestedSkillInvocation: string
            modelIdPattern: string
            sessionIdPattern: string
            roleWave: {
              path: string
              schema: string
              maxBytes: number
              maxRoles: number
              transport: string
              workspaces: string
              manifest: string
              status: string
              merge: string
              cleanup: string
              output: string
            }
            stableEngineEnv: Record<string, string | null>
            windowsPromptTransport: string
            initialActivationTelemetry: string
            cancellation: string
            enrichArgs: string[]
            enrichFromConfigArgs: string[]
          }
        }
      }
    }
    const cli = contract.providers.kimi.cli
    expect(cli.binary).toBe('node')
    expect(cli.skillRunner).toBe(KIMI_SKILL_RUNNER_PATH)
    expect(cli.nestedSkillInvocation).toContain('built-in Skill tool')
    expect(cli.nestedSkillInvocation).toContain('{ skill, args }')
    expect(cli.modelIdPattern).toBe(
      '^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$',
    )
    expect(cli.sessionIdPattern).toBe(
      '^(?!\\.{1,2}$)[A-Za-z0-9._-]{1,128}$',
    )
    expect(cli.roleWave.path).toBe(
      '.specrails/kimi-role-wave.json',
    )
    expect(cli.roleWave.maxBytes).toBe(1_048_576)
    expect(cli.roleWave.maxRoles).toBe(32)
    expect(cli.roleWave.schema).toContain('profile: "inherit" | safe-id')
    expect(cli.roleWave.transport).toContain('static foreground --role-wave-file')
    expect(cli.roleWave.transport).toContain('--role-wave-status')
    expect(cli.roleWave.workspaces).toContain('detached git worktrees')
    expect(cli.roleWave.workspaces).toContain('synthetic baseline')
    expect(cli.roleWave.manifest).toContain('<run>.json')
    expect(cli.roleWave.manifest).toContain('source head')
    expect(cli.roleWave.status).toContain('specrails.merge.inventory')
    expect(cli.roleWave.merge).toContain('.specrails/kimi-role-merge.json')
    expect(cli.roleWave.merge).toContain('A/M/D')
    expect(cli.roleWave.cleanup).toContain('--role-wave-cleanup')
    expect(cli.roleWave.output).toContain('specrails.role.completed')
    expect(cli.roleWave.output).toContain('specrails.merge.applied')
    expect(cli.roleWave.output).toContain('specrails.role.cleanup')
    expect(cli.stableEngineEnv).toEqual({
      KIMI_CODE_EXPERIMENTAL_FLAG: null,
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_THINKING_EFFORT:
        "low|high|max only for kimi-code/k3; omitted K3 effort preserves Kimi's documented high default; unset for every other model",
    })
    expect(cli.windowsPromptTransport).toContain('prompt bytes travel over stdin')
    expect(cli.windowsPromptTransport).toContain('30000 UTF-16')
    expect(cli.initialActivationTelemetry).toContain('cannot emit')
    expect(cli.cancellation).toContain('forwards SIGINT/SIGTERM/SIGHUP')
    expect(cli.enrichArgs).toEqual([
      KIMI_SKILL_RUNNER_PATH,
      '--skill',
      'specrails-enrich',
      '--model',
      'k3',
    ])
    expect(cli.enrichFromConfigArgs).toEqual([
      ...cli.enrichArgs,
      '--args',
      '--from-config',
    ])
    expect([...cli.enrichArgs, ...cli.enrichFromConfigArgs].join(' ')).not.toContain(
      '/skill:',
    )
  })
})

describe('Kimi stream-json parsing', () => {
  it('parses assistant, tool, meta, unknown, and malformed lines tolerantly', () => {
    expect(parseKimiStreamLine('{"role":"assistant","content":"done"}')).toMatchObject({
      kind: 'assistant',
      content: 'done',
    })
    expect(parseKimiStreamLine('{"role":"tool","content":"ok"}')).toMatchObject({
      kind: 'tool',
    })
    expect(parseKimiStreamLine('{"role":"meta","type":"system.version","version":"0.27"}'))
      .toMatchObject({ kind: 'meta' })
    expect(parseKimiStreamLine('{"future":"event"}')).toMatchObject({ kind: 'unknown' })
    expect(parseKimiStreamLine('not-json')).toEqual({ kind: 'invalid', raw: 'not-json' })
    expect(parseKimiStreamLine('  ')).toEqual({ kind: 'empty' })
  })

  it('exposes resume only after a session.resume_hint line', () => {
    const beforeHint = [
      '{"role":"assistant","content":"partial"}',
      '{"role":"tool","content":"work"}',
    ]
    expect(extractKimiSessionHint(beforeHint, 0)).toBeNull()
    expect(
      extractKimiSessionHint([
        ...beforeHint,
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt"}',
      ], 0),
    ).toBe('ses_prompt')
  })

  it('trusts only a canonical terminal hint from a zero-exit process', () => {
    const hint =
      '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt"}'
    expect(extractKimiSessionHint([hint], 7)).toBeNull()
    expect(extractKimiSessionHint([hint], null)).toBeNull()
    expect(
      extractKimiSessionHint([
        hint,
        '{"role":"meta","type":"turn.step.retrying"}',
      ], 0),
    ).toBeNull()
    expect(
      extractKimiSessionHint([
        '{"role":"meta","type":"session.resume_hint","session_id":"../escape"}',
      ], 0),
    ).toBeNull()
    expect(
      extractKimiSessionHint([
        hint,
        '',
        '   ',
      ], 0),
    ).toBe('ses_prompt')
  })
})
