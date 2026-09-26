import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { Writable } from 'node:stream'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { writeFileLf } from '../util/fs.js'

function toKimiPath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return /^[a-z]:\//.test(normalized)
    ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`
    : normalized
}

interface ParsedRunnerArgs {
  skill?: string
  model?: string
  rawArgs: string
  sessionId?: string
  additionalDirs: string[]
  attachmentPaths: string[]
  extraPrompt?: string
  plainPromptStdin: boolean
}

interface RunnerModule {
  WINDOWS_NPM_STDIN_BOOTSTRAP: string
  WINDOWS_PROMPT_STDIN_TOKEN: string
  expandSkillParameters: (
    body: string,
    rawArgs: string,
    context: {
      skillDir: string
      sessionId?: string
      argumentNames?: string[]
    },
  ) => string
  normalizeKimiCliModel: (model: string) => string
  forwardTerminationSignals: (
    child: { kill?: (signal: string) => void },
    source: EventEmitter,
  ) => () => void
  parseNpmCmdShimEntry: (shimPath: string, contents: string) => string | null
  parseRunnerArgs: (argv: string[]) => ParsedRunnerArgs
  parseSkillDocument: (
    text: string,
    options?: { skillId?: string },
  ) => {
    name: string
    description: string
    argumentNames: string[]
    body: string
  }
  prepareSkillLaunch: (options: {
    providerRoot: string
    skill: string
    model: string
    rawArgs: string
    sessionId?: string
    additionalDirs: string[]
    attachmentPaths: string[]
    extraPrompt?: string
  }, dependencies?: {
    resolvePath?: (file: string) => string
  }) => {
    prompt: string
    kimiArgs: string[]
    skillDir: string
    skillName: string
  }
  renderUserSlashSkillPrompt: (input: {
    skillName: string
    skillArgs: string
    skillContent: string
    skillDir: string
  }) => string
  resolveKimiLaunch: (
    args: string[],
    options?: {
      platform?: string
      binary?: string
      readFile?: (file: string) => string
      fileExists?: (file: string) => boolean
      env?: Record<string, string>
    },
  ) => { command: string; args: string[]; stdinText?: string }
  resolveWindowsKimiBinary: (
    env: Record<string, string>,
    exists: (file: string) => boolean,
  ) => string
  runSkillCli: (
    argv: string[],
    dependencies: {
      scriptPath: string
      cwd: string
      platform?: string
      binary?: string
      readFile?: (file: string) => string
      fileExists?: (file: string) => boolean
      env?: Record<string, string>
      signalSource?: EventEmitter
      writeStdout?: (text: string) => void
      readStdin?: () => string
      spawnChild: (
        command: string,
        args: string[],
        options: Record<string, unknown>,
      ) => EventEmitter
    },
  ) => Promise<number>
  stableKimiEnvironment: (
    env: Record<string, string>,
    model: string,
  ) => Record<string, string>
  tokenizeSkillArguments: (raw: string) => string[]
  windowsCommandLineLength: (command: string, args: string[]) => number
}

let runner: RunnerModule
let tmpDir: string

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'specrails-kimi-runner-'))
  const runnerUrl = pathToFileURL(
    path.join(process.cwd(), 'templates', 'kimi', 'specrails', 'run-skill.mjs'),
  ).href
  runner = (await import(runnerUrl)) as RunnerModule
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function writeSkill(
  id: string,
  body: string,
  frontmatter: string[] = [],
): string {
  const providerRoot = path.join(tmpDir, '.kimi-code')
  const managedRunner = path.join(
    providerRoot,
    'specrails',
    'run-skill.mjs',
  )
  if (!existsSync(managedRunner)) {
    writeFileLf(
      managedRunner,
      readFileSync(
        path.join(
          process.cwd(),
          'templates',
          'kimi',
          'specrails',
          'run-skill.mjs',
        ),
        'utf8',
      ),
    )
  }
  writeFileLf(
    path.join(providerRoot, 'skills', id, 'SKILL.md'),
    [
      '---',
      `name: ${id}`,
      `description: "${id} test skill"`,
      'type: prompt',
      ...frontmatter,
      '---',
      body,
      '',
    ].join('\n'),
  )
  return providerRoot
}

describe('managed Kimi skill runner — upstream-compatible rendering', () => {
  it('tokenizes quotes and Unicode whitespace with Kimi 0.27 semantics', () => {
    expect(runner.tokenizeSkillArguments(`-m "fix login" '第二 行'\n🚀`)).toEqual([
      '-m',
      'fix login',
      '第二 行',
      '🚀',
    ])
    expect(runner.tokenizeSkillArguments(`"" 'unterminated`)).toEqual([
      '',
      'unterminated',
    ])
    expect(runner.tokenizeSkillArguments(String.raw`one\ two`)).toEqual([
      'one\\',
      'two',
    ])
  })

  it('expands raw, indexed, positional, named, directory, and session placeholders', () => {
    const rendered = runner.expandSkillParameters(
      'raw=$ARGUMENTS zero=$0 one=$1 second=$ARGUMENTS[1] flag=$flag ' +
        'message=$message dir=${KIMI_SKILL_DIR} session=${KIMI_SESSION_ID}',
      '-m "fix <login>"',
      {
        skillDir: '/tmp/skills/commit',
        sessionId: 'ses_1',
        argumentNames: ['flag', 'message'],
      },
    )
    expect(rendered).toBe(
      'raw=-m "fix &lt;login&gt;" zero=-m one=fix &lt;login&gt; ' +
        'second=fix &lt;login&gt; flag=-m message=fix &lt;login&gt; ' +
        'dir=/tmp/skills/commit session=ses_1',
    )
  })

  it('appends escaped raw arguments when only context placeholders were used', () => {
    expect(
      runner.expandSkillParameters(
        'Read ${KIMI_SKILL_DIR}; session=${KIMI_SESSION_ID}.',
        '<src/app.ts>',
        { skillDir: '/skills/review' },
      ),
    ).toBe(
      'Read /skills/review; session=.\n\nARGUMENTS: &lt;src/app.ts&gt;',
    )
  })

  it('parses list, inline, and whitespace-separated frontmatter arguments', () => {
    const list = runner.parseSkillDocument(
      [
        '---',
        'name: review',
        'description: Review',
        'arguments:',
        '  - target',
        '  - mode',
        '---',
        '$target $mode',
      ].join('\n'),
    )
    expect(list.argumentNames).toEqual(['target', 'mode'])

    const inline = runner.parseSkillDocument(
      [
        '---',
        'name: review',
        'description: Review',
        'arguments: [target, "review mode", 1]',
        '---',
        '$target',
      ].join('\n'),
    )
    expect(inline.argumentNames).toEqual(['target', 'review mode'])

    const text = runner.parseSkillDocument(
      [
        '---',
        'name: review',
        'description: Review',
        'arguments: target mode',
        '---',
        '$target $mode',
      ].join('\n'),
    )
    expect(text.argumentNames).toEqual(['target', 'mode'])
  })

  it('uses the vendored full YAML parser for folded scalars, anchors, and aliases', () => {
    const parsed = runner.parseSkillDocument(
      [
        '---',
        'name: "review-complex"',
        'description: >-',
        '  Review complex',
        '  requests safely',
        'type: prompt',
        'argument_defaults: &argument_names',
        '  - target',
        '  - 7',
        '  - mode',
        'arguments: *argument_names',
        'metadata:',
        '  nested: { enabled: true }',
        '---',
        '$target $mode',
      ].join('\n'),
    )
    expect(parsed.description).toBe('Review complex requests safely')
    expect(parsed.argumentNames).toEqual(['target', 'mode'])

    expect(() =>
      runner.parseSkillDocument(
        '---\n- not\n- a\n- mapping\n---\nbody',
      ),
    ).toThrow(/must be a mapping/)
  })

  it.each(['type:', "type: ''", 'type: 123'])(
    'rejects a present but invalid upstream skill %s',
    (typeLine) => {
      expect(() =>
        runner.parseSkillDocument(
          [
            '---',
            'name: invalid-type',
            'description: Invalid type',
            typeLine,
            '---',
            'body',
          ].join('\n'),
        ),
      ).toThrow(/invalid type/)
    },
  )

  it('renders the exact user-slash wrapper and XML-escapes attributes', () => {
    expect(
      runner.renderUserSlashSkillPrompt({
        skillName: 'custom-"review"',
        skillArgs: '"a<b>" & notes',
        skillContent: 'Target: a&lt;b&gt;',
        skillDir: '/repo & work/skill',
      }),
    ).toBe(
      'User activated the skill "custom-&quot;review&quot;". Follow the loaded skill instructions.\n\n' +
        '<kimi-skill-loaded name="custom-&quot;review&quot;" trigger="user-slash" ' +
        'source="project" dir="/repo &amp; work/skill" ' +
        'args="&quot;a&lt;b&gt;&quot; &amp; notes">\n' +
        'Target: a&lt;b&gt;\n' +
        '</kimi-skill-loaded>',
    )
  })

  it('rejects malformed directory skills and unsupported activation types', () => {
    expect(() => runner.parseSkillDocument('no frontmatter')).toThrow(/frontmatter/)
    expect(() =>
      runner.parseSkillDocument(
        '---\nname: hidden\ndescription: Hidden\ntype: internal\n---\nbody',
      ),
    ).toThrow(/unsupported type/)
  })
})

describe('managed Kimi skill runner — secure invocation', () => {
  it.each([
    '../sr-reviewer',
    '/absolute',
    'sr-reviewer;touch-pwned',
    'sr-reviewer$(whoami)',
    'sr_review',
    'SR-reviewer',
  ])('rejects malicious or non-canonical skill id %s', (skill) => {
    expect(() =>
      runner.parseRunnerArgs(['--skill', skill, '--model', 'k3']),
    ).toThrow(/Invalid skill id/)
  })

  it('retains exact Unicode and multiline args without shell parsing', () => {
    const parsed = runner.parseRunnerArgs([
      '--skill',
      'sr-reviewer',
      '--model',
      'company/Kimi-Custom:v2',
      '--args',
      'línea uno\n第二行 $(touch should-not-run) 🚀',
    ])
    expect(parsed.rawArgs).toBe('línea uno\n第二行 $(touch should-not-run) 🚀')
    expect(parsed.model).toBe('company/Kimi-Custom:v2')
  })

  it('trims raw arguments like activateSkill and rejects duplicate empty --args', () => {
    expect(
      runner.parseRunnerArgs([
        '--skill',
        'sr-reviewer',
        '--model',
        'k3',
        '--args',
        '  \nreview this\n  ',
      ]).rawArgs,
    ).toBe('review this')
    expect(() =>
      runner.parseRunnerArgs([
        '--skill',
        'sr-reviewer',
        '--model',
        'k3',
        '--args',
        '',
        '--args',
        'second',
      ]),
    ).toThrow(/may be supplied once/)
  })

  it('normalizes only the three managed aliases and preserves custom aliases', () => {
    expect(runner.normalizeKimiCliModel('k3')).toBe('kimi-code/k3')
    expect(runner.normalizeKimiCliModel('kimi-for-coding')).toBe(
      'kimi-code/kimi-for-coding',
    )
    expect(runner.normalizeKimiCliModel('kimi-for-coding-highspeed')).toBe(
      'kimi-code/kimi-for-coding-highspeed',
    )
    expect(runner.normalizeKimiCliModel('company/Kimi-Custom:v2')).toBe(
      'company/Kimi-Custom:v2',
    )
    expect(runner.normalizeKimiCliModel('sonnet')).toBe('sonnet')
  })

  it.each([
    '',
    '--yolo',
    'team model',
    ' team/model',
    'team/model ',
    'team/model\n--yolo',
    'team/model$HOME',
    `a${'b'.repeat(128)}`,
  ])('rejects unsafe model id %j at the helper boundary', (model) => {
    expect(() => runner.normalizeKimiCliModel(model)).toThrow(/Invalid model id/)
    expect(() =>
      runner.parseRunnerArgs([
        '--skill',
        'sr-reviewer',
        '--model',
        model,
      ]),
    ).toThrow(/model/i)
  })

  it('loads the direct skill, expands it, and builds a shell-free Kimi argv', () => {
    const providerRoot = writeSkill(
      'sr-reviewer',
      'Target: $target\nRaw: $ARGUMENTS\nDir: ${KIMI_SKILL_DIR}\nSession: ${KIMI_SESSION_ID}',
      ['arguments: [target]'],
    )
    const attachment = path.join(tmpDir, 'captura 🚀.png')
    writeFileLf(attachment, 'png')
    const prepared = runner.prepareSkillLaunch({
      providerRoot,
      skill: 'sr-reviewer',
      model: 'company/Kimi-Custom:v2',
      rawArgs: '"src/área crítica.ts"\nsegunda línea',
      sessionId: 'ses_known',
      additionalDirs: [path.join(tmpDir, 'repo')],
      attachmentPaths: [attachment],
      extraPrompt: 'Keep every finding.',
    })

    expect(prepared.prompt).toContain(
      'User activated the skill "sr-reviewer". Follow the loaded skill instructions.',
    )
    expect(prepared.prompt).toContain('Target: src/área crítica.ts')
    expect(prepared.prompt).toContain('Session: ses_known')
    expect(prepared.prompt).toContain('Keep every finding.')
    expect(prepared.prompt).toContain(attachment)
    expect(prepared.prompt).not.toContain('/skill:sr-reviewer')
    expect(prepared.kimiArgs).toEqual([
      '--session=ses_known',
      '--add-dir',
      path.join(tmpDir, 'repo'),
      '--add-dir',
      realpathSync(tmpDir),
      '-m',
      'company/Kimi-Custom:v2',
      '-p',
      prepared.prompt,
      '--output-format',
      'stream-json',
    ])
  })

  it('rejects missing, directory, and symlink attachment inputs', () => {
    const providerRoot = writeSkill('attachment-safety', 'Inspect attachments.')
    const directory = path.join(tmpDir, 'attachment-directory')
    const regular = path.join(tmpDir, 'attachment-regular.txt')
    const linked = path.join(tmpDir, 'attachment-linked.txt')
    mkdirSync(directory)
    writeFileLf(regular, 'evidence')

    for (const attachment of [
      path.join(tmpDir, 'attachment-missing.txt'),
      directory,
    ]) {
      expect(() =>
        runner.prepareSkillLaunch({
          providerRoot,
          skill: 'attachment-safety',
          model: 'k3',
          rawArgs: '',
          additionalDirs: [],
          attachmentPaths: [attachment],
        }),
      ).toThrow(/readable regular non-symlink file/)
    }

    if (process.platform !== 'win32') {
      symlinkSync(regular, linked)
      expect(() =>
        runner.prepareSkillLaunch({
          providerRoot,
          skill: 'attachment-safety',
          model: 'k3',
          rawArgs: '',
          additionalDirs: [],
          attachmentPaths: [linked],
        }),
      ).toThrow(/readable regular non-symlink file/)
    }
  })

  it('fails closed for a mismatched frontmatter name', () => {
    const providerRoot = writeSkill('expected-name', 'body')
    writeFileLf(
      path.join(providerRoot, 'skills', 'expected-name', 'SKILL.md'),
      [
        '---',
        'name: different-name',
        'description: Mismatched',
        'type: prompt',
        '---',
        'body',
      ].join('\n'),
    )
    expect(() =>
      runner.prepareSkillLaunch({
        providerRoot,
        skill: 'expected-name',
        model: 'k3',
        rawArgs: '',
        additionalDirs: [],
        attachmentPaths: [],
      }),
    ).toThrow(/mismatched name/)
  })

  it('rejects an empty skill body before launching Kimi', () => {
    const providerRoot = writeSkill('empty-skill', '')
    expect(() =>
      runner.prepareSkillLaunch({
        providerRoot,
        skill: 'empty-skill',
        model: 'k3',
        rawArgs: '',
        additionalDirs: [],
        attachmentPaths: [],
      }),
    ).toThrow(/empty body/)
  })

  it('requires a known session before expanding KIMI_SESSION_ID', () => {
    const providerRoot = writeSkill(
      'session-aware',
      'Continue session ${KIMI_SESSION_ID}',
    )
    expect(() =>
      runner.prepareSkillLaunch({
        providerRoot,
        skill: 'session-aware',
        model: 'k3',
        rawArgs: '',
        additionalDirs: [],
        attachmentPaths: [],
      }),
    ).toThrow(/only with --session/)

    expect(
      runner.prepareSkillLaunch({
        providerRoot,
        skill: 'session-aware',
        model: 'k3',
        rawArgs: '',
        sessionId: 'ses_known',
        additionalDirs: [],
        attachmentPaths: [],
      }).prompt,
    ).toContain('Continue session ses_known')
  })

  it('renders Windows skill directories as uppercase-drive POSIX paths', () => {
    const providerRoot = writeSkill(
      'windows-path',
      'Directory=${KIMI_SKILL_DIR}',
    )
    const prepared = runner.prepareSkillLaunch(
      {
        providerRoot,
        skill: 'windows-path',
        model: 'k3',
        rawArgs: '',
        additionalDirs: [],
        attachmentPaths: [],
      },
      {
        resolvePath: () =>
          'c:\\Users\\Jane Doe\\repo\\.kimi-code\\skills\\windows-path',
      },
    )
    expect(prepared.skillDir).toBe(
      'C:/Users/Jane Doe/repo/.kimi-code/skills/windows-path',
    )
    expect(prepared.prompt).toContain(
      'Directory=C:/Users/Jane Doe/repo/.kimi-code/skills/windows-path',
    )
  })

  it('uses Kimi-compatible realpaths when a relocated skill is a symlink', () => {
    const frameworkRoot = writeSkill(
      'linked-skill',
      'Directory=${KIMI_SKILL_DIR}',
    )
    const workspaceRoot = path.join(tmpDir, 'workspace', '.kimi-code')
    const linkedDir = path.join(
      workspaceRoot,
      'skills',
      'linked-skill',
    )
    mkdirSync(path.dirname(linkedDir), { recursive: true })
    symlinkSync(
      path.join(frameworkRoot, 'skills', 'linked-skill'),
      linkedDir,
      'dir',
    )

    const prepared = runner.prepareSkillLaunch({
      providerRoot: workspaceRoot,
      skill: 'linked-skill',
      model: 'k3',
      rawArgs: '',
      additionalDirs: [],
      attachmentPaths: [],
    })
    const canonicalDir = realpathSync(
      path.join(frameworkRoot, 'skills', 'linked-skill'),
    )
    const kimiCanonicalDir = toKimiPath(canonicalDir)
    expect(prepared.skillDir).toBe(kimiCanonicalDir)
    expect(prepared.prompt).toContain(`Directory=${kimiCanonicalDir}`)
    expect(prepared.prompt).not.toContain(toKimiPath(linkedDir))
  })

  it('spawns directly with shell disabled so hostile args remain prompt text', async () => {
    const providerRoot = writeSkill(
      'custom-auditor',
      'Audit this request: $ARGUMENTS',
    )
    const scriptPath = path.join(providerRoot, 'specrails', 'run-skill.mjs')
    const spawnChild = vi.fn(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
      ) => {
        const child = new EventEmitter()
        queueMicrotask(() => child.emit('exit', 0, null))
        return child
      },
    )
    const rawArgs = 'uno\n二 $(touch never-created)'
    await expect(
      runner.runSkillCli(
        [
          '--skill',
          'custom-auditor',
          '--model',
          'k3',
          '--args',
          rawArgs,
        ],
        {
          scriptPath,
          cwd: tmpDir,
          platform: 'linux',
          env: {
            PATH: '/safe/bin',
            KIMI_CODE_EXPERIMENTAL_FLAG: 'true',
            kimi_code_experimental_flag: 'v2',
            kimi_disable_cron: '0',
            KIMI_CODE_NO_AUTO_UPDATE: '0',
            KIMI_MODEL_THINKING_EFFORT: 'high',
            SPECRAILS_SAFE: 'yes',
          },
          spawnChild,
        },
      ),
    ).resolves.toBe(0)

    const [command, args, options] = spawnChild.mock.calls[0]
    expect(command).toBe('kimi')
    expect(options).toMatchObject({ shell: false, cwd: tmpDir })
    expect(options.env).toEqual({
      PATH: '/safe/bin',
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_THINKING_EFFORT: 'high',
      SPECRAILS_SAFE: 'yes',
      SPECRAILS_BACKLOG_ROOT: tmpDir,
      SPECRAILS_BACKLOG_PATH: path.join(tmpDir, '.specrails', 'local-tickets.json'),
      SPECRAILS_PIPELINE_RUNTIME: path.join(tmpDir, '.specrails', 'runtime', 'pipeline.mjs'),
    })
    expect(args).toContain('kimi-code/k3')
    expect(args.join('\n')).toContain('$(touch never-created)')
  })

  it('receives long Unicode plain prompts over runner stdin without changing the turn', async () => {
    const providerRoot = writeSkill('plain-transport-anchor', 'unused')
    const scriptPath = path.join(providerRoot, 'specrails', 'run-skill.mjs')
    const prompt = `Inicio 🚀\n${'第二行 con datos\n'.repeat(5_000)}Fin`
    let capturedArgs: string[] = []

    await expect(
      runner.runSkillCli(
        [
          '--plain-prompt-stdin',
          '--model',
          'k3',
          '--session=ses_plain',
          '--add-dir',
          tmpDir,
        ],
        {
          scriptPath,
          cwd: tmpDir,
          platform: 'linux',
          signalSource: new EventEmitter(),
          readStdin: () => prompt,
          spawnChild: (_command, args) => {
            capturedArgs = args
            const child = new EventEmitter()
            queueMicrotask(() => child.emit('exit', 0, null))
            return child
          },
        },
      ),
    ).resolves.toBe(0)

    expect(capturedArgs).toContain(prompt)
    expect(capturedArgs).toContain('--session=ses_plain')
    expect(capturedArgs).toContain('kimi-code/k3')
  })

  it('propagates native spawn failure from stdin prompt mode', async () => {
    const providerRoot = writeSkill('plain-spawn-failure', 'unused')
    await expect(
      runner.runSkillCli(
        ['--plain-prompt-stdin', '--model', 'k3'],
        {
          scriptPath: path.join(
            providerRoot,
            'specrails',
            'run-skill.mjs',
          ),
          cwd: tmpDir,
          platform: 'linux',
          readStdin: () => 'sensitive prompt',
          spawnChild: () => {
            throw new Error('simulated spawn failure')
          },
        },
      ),
    ).rejects.toThrow(/simulated spawn failure/)
  })

  it('rejects invalid or oversized stdin prompt mode before spawning', async () => {
    const providerRoot = writeSkill('plain-validation', 'unused')
    const common = {
      scriptPath: path.join(providerRoot, 'specrails', 'run-skill.mjs'),
      cwd: tmpDir,
      platform: 'linux',
      spawnChild: vi.fn(() => new EventEmitter()),
    }
    expect(() =>
      runner.parseRunnerArgs([
        '--plain-prompt-stdin',
        '--model',
        'k3',
        '--skill',
        'plain-validation',
      ]),
    ).toThrow(/cannot be combined/)
    await expect(
      runner.runSkillCli(
        ['--plain-prompt-stdin', '--model', 'k3'],
        { ...common, readStdin: () => ' \n ' },
      ),
    ).rejects.toThrow(/must not be empty/)
    await expect(
      runner.runSkillCli(
        ['--plain-prompt-stdin', '--model', 'k3'],
        { ...common, readStdin: () => '🚀'.repeat(300_000) },
      ),
    ).rejects.toThrow(/exceeds 1048576 UTF-8 bytes/)
    expect(common.spawnChild).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'passes hostile skill args to a real Kimi process without shell evaluation',
    async () => {
      const cwd = path.join(tmpDir, 'hostile-args-e2e')
      const providerRoot = path.join(cwd, '.kimi-code')
      writeFileLf(
        path.join(
          providerRoot,
          'skills',
          'custom-auditor',
          'SKILL.md',
        ),
        [
          '---',
          'name: custom-auditor',
          'description: Hostile argument security test',
          'type: prompt',
          '---',
          'Audit exactly: $ARGUMENTS',
        ].join('\n'),
      )
      const marker = path.join(cwd, 'shell-injection-marker')
      const hostileArgs =
        `"quoted"; $(touch ${marker}) \`touch ${marker}\` <unsafe>`

      const fakeBin = path.join(cwd, 'bin')
      const capturePath = path.join(cwd, 'captured-argv.json')
      const fakeKimi = path.join(fakeBin, 'kimi')
      writeFileLf(
        fakeKimi,
        [
          '#!/usr/bin/env node',
          "const { writeFileSync } = require('node:fs')",
          'const args = process.argv.slice(2)',
          'writeFileSync(process.env.SPECRAILS_CAPTURE, JSON.stringify(args))',
        ].join('\n'),
      )
      chmodSync(fakeKimi, 0o755)

      await expect(
        runner.runSkillCli(
          [
            '--skill',
            'custom-auditor',
            '--model',
            'k3',
            '--args',
            hostileArgs,
            '--add-dir',
            cwd,
          ],
          {
            scriptPath: path.join(
              providerRoot,
              'specrails',
              'run-skill.mjs',
            ),
            cwd,
            platform: 'linux',
            signalSource: new EventEmitter(),
            env: {
              PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
              SPECRAILS_CAPTURE: capturePath,
            },
            spawnChild: (command, args, options) => {
              return spawn(
                command,
                args,
                options as Parameters<typeof spawn>[2],
              )
            },
          },
        ),
      ).resolves.toBe(0)

      expect(existsSync(marker)).toBe(false)
      const captured = JSON.parse(
        readFileSync(capturePath, 'utf8'),
      ) as string[]
      const promptIndex = captured.indexOf('-p') + 1
      expect(promptIndex).toBeGreaterThan(0)
      expect(captured[promptIndex]).toContain(
        hostileArgs.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
      )
    },
  )

  it('forwards helper termination signals to the Kimi child', () => {
    const source = new EventEmitter()
    const child = { kill: vi.fn() }
    const cleanup = runner.forwardTerminationSignals(child, source)
    source.emit('SIGINT')
    source.emit('SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGINT')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGTERM')
    cleanup()
    source.emit('SIGHUP')
    expect(child.kill).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['--role-wave-file', '.specrails/kimi-role-wave.json'],
    ['--role-wave-status', 'run-1'],
    ['--role-wave-cleanup', 'run-1'],
    ['--role-merge-file', '.specrails/kimi-role-merge.json'],
    ['--request-file', '.specrails/kimi-role-request.json'],
  ])('rejects the removed role-wave option %s as unknown', (flag, value) => {
    expect(() => runner.parseRunnerArgs([flag, value])).toThrow(
      new RegExp(`Unknown option: ${flag}$`),
    )
  })

  it('rejects experimental runner flags instead of forwarding them to Kimi', () => {
    expect(() =>
      runner.parseRunnerArgs([
        '--skill',
        'sr-reviewer',
        '--model',
        'k3',
        '--experimental',
        'v2',
      ]),
    ).toThrow(/Unknown option: --experimental/)
  })

  it('scopes inherited thinking effort to K3 and removes invalid values', () => {
    const inherited = {
      PATH: '/safe/bin',
      KIMI_MODEL_THINKING_EFFORT: 'max',
    }
    expect(runner.stableKimiEnvironment(inherited, 'k3')).toEqual({
      ...inherited,
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
    expect(
      runner.stableKimiEnvironment(inherited, 'kimi-for-coding'),
    ).toEqual({
      PATH: '/safe/bin',
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
    expect(
      runner.stableKimiEnvironment(
        {
          PATH: '/safe/bin',
          KIMI_MODEL_THINKING_EFFORT: 'medium',
        },
        'k3',
      ),
    ).toEqual({
      PATH: '/safe/bin',
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
  })
})

describe('managed Kimi skill runner — Windows npm shim', () => {
  const shim =
    'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\kimi.cmd'
  const entry =
    'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs'
  const contents =
    '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs" %*\r\n'

  it('extracts the npm JavaScript entry and launches it with Node', () => {
    expect(runner.parseNpmCmdShimEntry(shim, contents)).toBe(entry)
    const prompt = 'uno\n二 🚀'
    const launch = runner.resolveKimiLaunch(
      ['-p', prompt, '--output-format', 'stream-json'],
      {
        platform: 'win32',
        binary: shim,
        readFile: () => contents,
        fileExists: () => false,
      },
    )
    expect(launch.command).toBe('node')
    expect(launch.stdinText).toBe(prompt)
    expect(launch.args).toEqual([
      '-e',
      runner.WINDOWS_NPM_STDIN_BOOTSTRAP,
      entry,
      '-p',
      runner.WINDOWS_PROMPT_STDIN_TOKEN,
      '--output-format',
      'stream-json',
    ])
    expect(launch.args).not.toContain(prompt)
  })

  it('fails the invocation when Windows stdin prompt transport errors', async () => {
    const providerRoot = writeSkill('stdin-failure', 'Review $ARGUMENTS')
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('simulated broken pipe'))
      },
    })
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable
      kill: ReturnType<typeof vi.fn>
    }
    child.stdin = stdin
    child.kill = vi.fn()

    await expect(
      runner.runSkillCli(
        [
          '--skill',
          'stdin-failure',
          '--model',
          'k3',
          '--args',
          'large prompt',
        ],
        {
          scriptPath: path.join(
            providerRoot,
            'specrails',
            'run-skill.mjs',
          ),
          cwd: tmpDir,
          platform: 'win32',
          binary: shim,
          readFile: (file) =>
            file.toLowerCase().endsWith('.cmd')
              ? contents
              : readFileSync(file, 'utf8'),
          fileExists: () => false,
          signalSource: new EventEmitter(),
          env: { PATH: 'C:\\npm' },
          spawnChild: () => child,
        },
      ),
    ).rejects.toThrow(/Cannot transport.*simulated broken pipe/)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reconstructs a large Unicode prompt from stdin before importing the npm entry', () => {
    const fakeEntry = path.join(tmpDir, 'fake-kimi-entry.mjs')
    writeFileLf(
      fakeEntry,
      'process.stdout.write(JSON.stringify(process.argv))\n',
    )
    const prompt = `Inicio 🚀\n${'第二行 con datos\n'.repeat(5_000)}Fin`
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        runner.WINDOWS_NPM_STDIN_BOOTSTRAP,
        fakeEntry,
        '-m',
        'kimi-code/k3',
        '-p',
        runner.WINDOWS_PROMPT_STDIN_TOKEN,
        '--output-format',
        'stream-json',
      ],
      {
        encoding: 'utf8',
        input: prompt,
      },
    )
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual([
      process.execPath,
      fakeEntry,
      '-m',
      'kimi-code/k3',
      '-p',
      prompt,
      '--output-format',
      'stream-json',
    ])
  })

  it('replaces only the -p marker when another argument equals the marker', () => {
    const fakeEntry = path.join(tmpDir, 'fake-kimi-marker-entry.mjs')
    writeFileLf(
      fakeEntry,
      'process.stdout.write(JSON.stringify(process.argv))\n',
    )
    const prompt = 'prompt restored from stdin'
    const hostileArgument = runner.WINDOWS_PROMPT_STDIN_TOKEN
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        runner.WINDOWS_NPM_STDIN_BOOTSTRAP,
        fakeEntry,
        hostileArgument,
        '-p',
        runner.WINDOWS_PROMPT_STDIN_TOKEN,
      ],
      {
        encoding: 'utf8',
        input: prompt,
      },
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      process.execPath,
      fakeEntry,
      hostileArgument,
      '-p',
      prompt,
    ])
  })

  it('binds option-like session ids to the Kimi session option', () => {
    expect(
      runner.parseRunnerArgs([
        '--skill',
        'session-option',
        '--model',
        'k3',
        '--session=--continue',
      ]).sessionId,
    ).toBe('--continue')
    const providerRoot = writeSkill('session-option', 'hello')
    const prepared = runner.prepareSkillLaunch({
      providerRoot,
      skill: 'session-option',
      model: 'k3',
      rawArgs: '',
      sessionId: '--continue',
      additionalDirs: [],
      attachmentPaths: [],
    })
    expect(prepared.kimiArgs[0]).toBe('--session=--continue')
    expect(prepared.kimiArgs).not.toContain('-S')
  })

  it('rejects unsafe session ids at parse and materialization boundaries', () => {
    const providerRoot = writeSkill('session-safe', 'hello')
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
        runner.parseRunnerArgs([
          '--skill',
          'session-safe',
          '--model',
          'k3',
          '--session',
          sessionId,
        ]),
      ).toThrow(/session/)
      expect(() =>
        runner.prepareSkillLaunch({
          providerRoot,
          skill: 'session-safe',
          model: 'k3',
          rawArgs: '',
          sessionId,
          additionalDirs: [],
          attachmentPaths: [],
        }),
      ).toThrow(/session/)
    }
  })

  it('keeps oversized prompts off npm argv and rejects oversized native argv', () => {
    const prompt = `🚀${'x'.repeat(70_000)}`
    const npmLaunch = runner.resolveKimiLaunch(
      ['-m', 'kimi-code/k3', '-p', prompt, '--output-format', 'stream-json'],
      {
        platform: 'win32',
        binary: shim,
        readFile: () => contents,
        fileExists: () => false,
      },
    )
    expect(npmLaunch.stdinText).toBe(prompt)
    expect(npmLaunch.args).not.toContain(prompt)
    expect(
      runner.windowsCommandLineLength(npmLaunch.command, npmLaunch.args),
    ).toBeLessThanOrEqual(30_000)

    expect(() =>
      runner.resolveKimiLaunch(['-p', prompt], {
        platform: 'win32',
        binary: 'C:\\Kimi\\kimi.exe',
      }),
    ).toThrow(/above 30000.*standard npm kimi\.cmd/s)
  })

  it('prefers a native executable and resolves PATH keys case-insensitively', () => {
    const binary = 'C:\\Kimi\\kimi.EXE'
    expect(
      runner.resolveWindowsKimiBinary(
        { Path: 'C:\\Other;C:\\Kimi', PATHEXT: '.EXE;.CMD' },
        (candidate) => candidate.toLowerCase() === binary.toLowerCase(),
      ),
    ).toBe('C:\\Kimi\\kimi.exe')
    expect(
      runner.resolveKimiLaunch(['--version'], {
        platform: 'win32',
        binary,
      }),
    ).toEqual({ command: binary, args: ['--version'] })
  })

  it('prefers the npm command shim when its extensionless sibling also exists', () => {
    const bare = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\kimi'
    expect(
      runner.resolveWindowsKimiBinary(
        {
          Path: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm',
          PATHEXT: '.EXE;.CMD;.BAT;.COM',
        },
        (candidate) =>
          candidate.toLowerCase() === bare.toLowerCase() ||
          candidate.toLowerCase() === shim.toLowerCase(),
      ),
    ).toBe('C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\kimi.cmd')
  })

  it('rejects PowerShell-only and extensionless Windows installations', () => {
    expect(() =>
      runner.resolveWindowsKimiBinary(
        { Path: 'C:\\Kimi', PATHEXT: '.PS1' },
        (candidate) =>
          candidate.toLowerCase() === 'c:\\kimi\\kimi.ps1' ||
          candidate.toLowerCase() === 'c:\\kimi\\kimi',
      ),
    ).toThrow(/No shell-free Kimi executable/)
  })

  it('fails closed for a non-standard command shim instead of using cmd.exe', () => {
    expect(() =>
      runner.resolveKimiLaunch(['-p', 'safe'], {
        platform: 'win32',
        binary: shim,
        readFile: () => '@echo off\r\nsome-custom-launcher %*\r\n',
      }),
    ).toThrow(/Refusing to execute non-standard/)
  })
})


describe('native skill rendering without provider execution', () => {
  it('returns the exact expanded skill while leaving the executor in charge of permissions', async () => {
    const providerRoot = path.join(tmpDir, '.kimi-code')
    writeSkill('custom-auditor', 'Audit $ARGUMENTS')
    const writeStdout = vi.fn(), spawnChild = vi.fn()
    const status = await runner.runSkillCli(['--skill', 'custom-auditor', '--model', 'k3', '--args', 'literal $(data)', '--render-only'], { scriptPath: path.join(providerRoot, 'specrails/run-skill.mjs'), cwd: tmpDir, writeStdout, spawnChild })
    expect(status).toBe(0)
    expect(JSON.parse(writeStdout.mock.calls[0]![0]).prompt).toContain('Audit literal $(data)')
    expect(spawnChild).not.toHaveBeenCalled()
    expect(() => runner.parseRunnerArgs(['--render-only', '--plain-prompt-stdin', '--model', 'k3'])).toThrow('requires a skill')
  })
})
