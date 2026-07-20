import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import {
  chmodSync,
  cpSync,
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

function canonicalPathIdentity(value: string): string {
  const canonical =
    typeof realpathSync.native === 'function'
      ? realpathSync.native(value)
      : realpathSync(value)
  const resolved = path.resolve(canonical)
  return process.platform === 'win32'
    ? resolved.toLowerCase()
    : resolved
}

function expectSamePath(actual: string, expected: string): void {
  expect(canonicalPathIdentity(actual)).toBe(
    canonicalPathIdentity(expected),
  )
}

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
  requestFile?: string
  roleWaveFile?: string
  roleWaveStatus?: string
  roleWaveCleanup?: string
  roleMergeFile?: string
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
  loadRoleRequest: (
    parsed: ParsedRunnerArgs,
    cwd: string,
  ) => ParsedRunnerArgs
  loadRoleWave: (
    parsed: ParsedRunnerArgs,
    cwd: string,
  ) => {
    run: string
    roles: Array<{
      key: string
      skill: string
      model: string
      profile: string
      rawArgs: string
      workspace: string
    }>
    additionalDirs: string[]
  } | undefined
  loadRoleMerge: (
    parsed: ParsedRunnerArgs,
    cwd: string,
  ) => {
    run: string
    actions: Array<{
      worktree: string
      path: string
      operation: 'copy' | 'delete'
    }>
  } | undefined
  inspectRoleWaveStatus: (
    run: string,
    options: Record<string, unknown>,
  ) => {
    run: string
    baseRepo: string
    baseCommit: string
    manifestPath: string
    worktrees: Record<
      string,
      {
        repoDir: string
        changes: Array<{ status: 'A' | 'M' | 'D'; path: string }>
      }
    >
  }
  applyRoleMerge: (
    merge: {
      run: string
      actions: Array<{
        worktree: string
        path: string
        operation: 'copy' | 'delete'
      }>
    },
    options: Record<string, unknown>,
  ) => { run: string; baseRepo: string; applied: number }
  cleanupRoleWave: (
    run: string,
    options: Record<string, unknown>,
  ) => {
    run: string
    baseRepo: string
    removedWorktrees: number
    manifestPath: string
  }
  materializeRoleWaveWorkspaces: (
    wave: {
      run: string
      roles: Array<{
        key: string
        skill: string
        model: string
        profile: string
        rawArgs: string
        workspace: string
      }>
      additionalDirs: string[]
    },
    options: Record<string, unknown>,
  ) => {
    run: string
    baseRepo: string
    baseCommit: string
    manifestPath: string
    roles: Array<{
      key: string
      skill: string
      model: string
      profile: string
      rawArgs: string
      workspace: string
      cwd: string
      repoDir: string
    }>
  }
  ensureProviderOverlay: (
    providerRoot: string,
    workspace: string,
    platform: string,
    dependencies?: Record<string, unknown>,
  ) => void
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
      spawnSync?: typeof spawnSync
      tempRoot?: string
      writeOutput?: (line: string) => void
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

function createWaveRepo(name: string): string {
  const repo = path.join(tmpDir, name)
  mkdirSync(repo, { recursive: true })
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'tests@specrails.dev'],
    ['config', 'user.name', 'SpecRails Tests'],
  ]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  writeFileLf(path.join(repo, 'tracked.txt'), 'base\n')
  const commit = spawnSync(
    'git',
    ['add', 'tracked.txt'],
    { cwd: repo, encoding: 'utf8' },
  )
  if (commit.status !== 0) throw new Error(commit.stderr)
  const committed = spawnSync(
    'git',
    ['commit', '-qm', 'base'],
    { cwd: repo, encoding: 'utf8' },
  )
  if (committed.status !== 0) throw new Error(committed.stderr)
  return repo
}

function writeRoleWave(
  repo: string,
  value: {
    run: string
    roles: Array<{
      key: string
      skill: string
      model: string
      profile?: string
      args: string
      workspace: string
    }>
  },
): void {
  writeFileLf(
    path.join(repo, '.specrails', 'kimi-role-wave.json'),
    `${JSON.stringify(
      {
        ...value,
        roles: value.roles.map((role) => ({
          ...role,
          profile: role.profile ?? 'inherit',
        })),
      },
      null,
      2,
    )}\n`,
  )
}

function createRoleChild(
  exitCode: number,
  output: unknown,
): EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: Writable
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: Writable
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = vi.fn((signal: string) => {
    child.stdout.end()
    child.stderr.end()
    queueMicrotask(() => child.emit('exit', null, signal))
    return true
  })
  queueMicrotask(() => {
    child.stdout.end(`${JSON.stringify(output)}\n`)
    child.stderr.end()
    child.emit('exit', exitCode, null)
  })
  return child
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
          tempRoot: tmpDir,
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
          tempRoot: tmpDir,
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
    'loads a one-shot fixed role request without evaluating hostile context',
    async () => {
      const cwd = path.join(tmpDir, 'role-request-e2e')
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
          'description: Request-file security test',
          'type: prompt',
          '---',
          'Audit exactly: $ARGUMENTS',
        ].join('\n'),
      )
      const marker = path.join(cwd, 'shell-injection-marker')
      const hostileArgs =
        `"quoted"; $(touch ${marker}) \`touch ${marker}\` <unsafe>`
      const requestPath = path.join(
        cwd,
        '.specrails',
        'kimi-role-request.json',
      )
      writeFileLf(
        requestPath,
        JSON.stringify({
          skill: 'custom-auditor',
          model: 'k3',
          args: hostileArgs,
        }),
      )

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
            '--request-file',
            '.specrails/kimi-role-request.json',
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
      expect(existsSync(requestPath)).toBe(false)
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

  it('bounds and cleans fixed role request files and rejects alternate paths', () => {
    const cwd = path.join(tmpDir, 'role-request-validation')
    const parsed = runner.parseRunnerArgs([
      '--request-file',
      '.specrails/kimi-role-request.json',
    ])
    expect(() =>
      runner.parseRunnerArgs([
        '--request-file',
        '.specrails/kimi-role-request.json',
        '--skill',
        'sr-reviewer',
      ]),
    ).toThrow(/cannot be combined/)
    expect(() =>
      runner.loadRoleRequest(
        {
          ...parsed,
          requestFile: 'elsewhere/request.json',
        },
        cwd,
      ),
    ).toThrow(/must use/)

    const requestPath = path.join(
      cwd,
      '.specrails',
      'kimi-role-request.json',
    )
    writeFileLf(requestPath, 'x'.repeat(1_048_577))
    expect(() => runner.loadRoleRequest(parsed, cwd)).toThrow(/exceeds/)
    expect(existsSync(requestPath)).toBe(false)

    writeFileLf(requestPath, '{invalid json')
    expect(() => runner.loadRoleRequest(parsed, cwd)).toThrow(/Invalid role request JSON/)
    expect(existsSync(requestPath)).toBe(false)
  })

  it('rejects fixed request state through a symlinked .specrails parent', () => {
    const cwd = path.join(tmpDir, 'role-request-symlink')
    const outside = path.join(tmpDir, 'role-request-outside')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, path.join(cwd, '.specrails'), 'dir')
    writeFileLf(
      path.join(outside, 'kimi-role-wave.json'),
      '{"run":"safe-run","roles":[]}\n',
    )
    const parsed = runner.parseRunnerArgs([
      '--role-wave-file',
      '.specrails/kimi-role-wave.json',
    ])
    expect(() => runner.loadRoleWave(parsed, cwd)).toThrow(
      /parent must be a real directory/,
    )
  })

  it('executes one attributed wave for parallel current-repo roles', async () => {
    const repo = createWaveRepo('role-wave-current')
    const providerRoot = writeSkill('wave-a', 'A: $ARGUMENTS')
    writeSkill('wave-b', 'B: $ARGUMENTS')
    writeFileLf(
      path.join(repo, '.specrails', 'profiles', 'rail-fast.json'),
      '{}\n',
    )
    const hostileArgs = '"quoted" $(touch never) `whoami` <unsafe>'
    writeRoleWave(repo, {
      run: 'run-current-01',
      roles: [
        {
          key: 'architect-a',
          skill: 'wave-a',
          model: 'k3',
          args: hostileArgs,
          workspace: 'current',
        },
        {
          key: 'architect-b',
          skill: 'wave-b',
          model: 'company/kimi-v2',
          profile: 'rail-fast',
          args: 'second role',
          workspace: 'current',
        },
      ],
    })
    const calls: Array<{
      args: string[]
      options: Record<string, unknown>
    }> = []
    const output: string[] = []
    const currentTempRoot = path.join(tmpDir, 'role-wave-current-temp')

    const code = await runner.runSkillCli(
      [
        '--role-wave-file',
        '.specrails/kimi-role-wave.json',
        '--add-dir',
        repo,
      ],
      {
        scriptPath: path.join(providerRoot, 'specrails', 'run-skill.mjs'),
        cwd: repo,
        platform: 'linux',
        env: { PATH: '/safe/bin' },
        signalSource: new EventEmitter(),
        tempRoot: currentTempRoot,
        writeOutput: (line) => output.push(line),
        spawnChild: (_command, args, options) => {
          calls.push({ args, options })
          return createRoleChild(0, {
            role: calls.length,
            content: 'ok',
          })
        },
      },
    )

    expect(code).toBe(0)
    expect(calls).toHaveLength(2)
    const executionCwds = calls.map((call) => String(call.options.cwd))
    expect(new Set(executionCwds).size).toBe(2)
    for (const call of calls) {
      expect(call.options).toMatchObject({ shell: false })
      expectSamePath(
        (call.options.env as Record<string, string>).SPECRAILS_REPO_DIR!,
        repo,
      )
    }
    expect(calls[0]?.args.join('\n')).toContain(
      hostileArgs.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    )
    expectSamePath(
      (calls[1]?.options.env as Record<string, string>)
        .SPECRAILS_PROFILE_PATH!,
      path.join(repo, '.specrails', 'profiles', 'rail-fast.json'),
    )
    expect(
      existsSync(path.join(repo, '.specrails', 'kimi-role-wave.json')),
    ).toBe(false)
    const frames = output
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(
      frames.filter((frame) => frame.type === 'specrails.role.workspace'),
    ).toHaveLength(2)
    expect(
      frames.filter((frame) => frame.type === 'specrails.role.event'),
    ).toHaveLength(2)
    expect(
      frames.filter((frame) => frame.type === 'specrails.role.completed'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleKey: 'architect-a', status: 'succeeded' }),
        expect.objectContaining({ roleKey: 'architect-b', status: 'succeeded' }),
      ]),
    )
    const cleaned = runner.cleanupRoleWave('run-current-01', {
      cwd: repo,
      tempRoot: currentTempRoot,
    })
    expect(cleaned.removedWorktrees).toBe(0)
    expect(existsSync(cleaned.manifestPath)).toBe(false)
    for (const executionCwd of executionCwds) {
      expect(existsSync(executionCwd)).toBe(false)
    }
  })

  it('creates, snapshots, records, and reuses isolated role worktrees', async () => {
    const repo = createWaveRepo('role-wave-worktrees')
    const providerRoot = writeSkill('developer-wave', 'Develop $ARGUMENTS')
    writeSkill('test-wave', 'Test $ARGUMENTS')
    writeFileLf(path.join(repo, 'tracked.txt'), 'dirty tracked\n')
    writeFileLf(path.join(repo, 'openspec', 'change.md'), 'untracked spec\n')
    const tempRoot = path.join(tmpDir, 'role-wave-worktree-temp')
    const runWave = async (
      roles: Array<{
        key: string
        skill: string
        model: string
        args: string
        workspace: string
      }>,
    ) => {
      writeRoleWave(repo, { run: 'run-isolated-01', roles })
      const calls: Array<Record<string, unknown>> = []
      const output: string[] = []
      const code = await runner.runSkillCli(
        ['--role-wave-file', '.specrails/kimi-role-wave.json'],
        {
          scriptPath: path.join(providerRoot, 'specrails', 'run-skill.mjs'),
          cwd: repo,
          platform: 'linux',
          env: { PATH: '/safe/bin' },
          signalSource: new EventEmitter(),
          tempRoot,
          writeOutput: (line) => output.push(line),
          spawnChild: (_command, _args, options) => {
            calls.push(options)
            return createRoleChild(0, { content: 'done' })
          },
        },
      )
      return {
        code,
        calls,
        frames: output
          .join('')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      }
    }

    const first = await runWave([
      {
        key: 'developer-a',
        skill: 'developer-wave',
        model: 'k3',
        args: 'feature a',
        workspace: 'worktree:feature-a',
      },
      {
        key: 'developer-b',
        skill: 'developer-wave',
        model: 'k3',
        args: 'feature b',
        workspace: 'worktree:feature-b',
      },
    ])
    expect(first.code).toBe(0)
    const workspaceFrames = first.frames.filter(
      (frame) => frame.type === 'specrails.role.workspace',
    )
    const featureA = workspaceFrames.find(
      (frame) => frame.roleKey === 'developer-a',
    )!
    const featureB = workspaceFrames.find(
      (frame) => frame.roleKey === 'developer-b',
    )!
    expect(featureA.repoDir).not.toBe(featureB.repoDir)
    for (const frame of [featureA, featureB]) {
      const repoDir = String(frame.repoDir)
      expect(readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8')).toBe(
        'dirty tracked\n',
      )
      expect(readFileSync(path.join(repoDir, 'openspec', 'change.md'), 'utf8'))
        .toBe('untracked spec\n')
      expect(realpathSync(path.join(repoDir, '.kimi-code'))).toBe(
        realpathSync(providerRoot),
      )
    }
    writeFileLf(path.join(String(featureA.repoDir), 'role-change.txt'), 'kept\n')

    const second = await runWave([
      {
        key: 'test-a',
        skill: 'test-wave',
        model: 'k3',
        args: 'feature a',
        workspace: 'worktree:feature-a',
      },
    ])
    expect(second.code).toBe(0)
    const reused = second.frames.find(
      (frame) => frame.type === 'specrails.role.workspace',
    )!
    expect(reused.repoDir).toBe(featureA.repoDir)
    expect(
      readFileSync(path.join(String(reused.repoDir), 'role-change.txt'), 'utf8'),
    ).toBe('kept\n')

    const manifest = JSON.parse(
      readFileSync(String(reused.manifestPath), 'utf8'),
    ) as {
      baseCommit: string
      worktrees: Record<string, string>
      roles: Record<string, { repoDir: string }>
    }
    expect(manifest.baseCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.worktrees).toMatchObject({
      'feature-a': featureA.repoDir,
      'feature-b': featureB.repoDir,
    })
    expect(manifest.roles['developer-a']?.repoDir).toBe(featureA.repoDir)
    expect(manifest.roles['test-a']?.repoDir).toBe(featureA.repoDir)
  })

  it('merges A/M/D role deltas without attributing the dirty baseline or provider overlay', async () => {
    const repo = createWaveRepo('role-wave-merge')
    const providerRoot = writeSkill('merge-developer', 'Develop $ARGUMENTS')
    writeFileLf(path.join(repo, 'tracked.txt'), 'dirty baseline\n')
    writeFileLf(
      path.join(repo, 'baseline untracked 🚀.txt'),
      'baseline only\n',
    )
    writeRoleWave(repo, {
      run: 'run-merge-01',
      roles: [
        {
          key: 'developer-feature',
          skill: 'merge-developer',
          model: 'k3',
          args: 'implement safely',
          workspace: 'worktree:feature-safe',
        },
      ],
    })
    let spawnedOptions: Record<string, unknown> | undefined
    const mergeTempRoot = path.join(tmpDir, 'role-wave-merge-temp')
    await expect(
      runner.runSkillCli(
        ['--role-wave-file', '.specrails/kimi-role-wave.json'],
        {
          scriptPath: path.join(providerRoot, 'specrails', 'run-skill.mjs'),
          cwd: repo,
          platform: 'linux',
          env: { PATH: '/safe/bin' },
          signalSource: new EventEmitter(),
          tempRoot: mergeTempRoot,
          writeOutput: () => {},
          spawnChild: (_command, _args, options) => {
            spawnedOptions = options
            return createRoleChild(0, { content: 'done' })
          },
        },
      ),
    ).resolves.toBe(0)
    const initial = runner.inspectRoleWaveStatus('run-merge-01', {
      cwd: repo,
      tempRoot: mergeTempRoot,
    })
    expect(initial.worktrees['feature-safe']?.changes).toEqual([])

    const worktree = initial.worktrees['feature-safe']!.repoDir
    const hostileName = 'src/new $(touch never-created) 🚀.txt'
    writeFileLf(path.join(worktree, hostileName), 'new role output\n')
    rmSync(path.join(worktree, 'tracked.txt'))
    const roleEnv = spawnedOptions!.env as Record<string, string>
    const gitEnv = { ...roleEnv, PATH: process.env.PATH ?? '' }
    const staged = spawnSync('git', ['add', '-A'], {
      cwd: worktree,
      env: gitEnv,
      encoding: 'utf8',
    })
    expect(staged.status).toBe(0)
    const providerStatus = spawnSync(
      'git',
      ['status', '--porcelain=v1', '--', '.kimi-code'],
      { cwd: worktree, env: gitEnv, encoding: 'utf8' },
    )
    expect(providerStatus.stdout).toBe('')
    const committed = spawnSync(
      'git',
      ['commit', '-qm', 'role delta'],
      { cwd: worktree, env: gitEnv, encoding: 'utf8' },
    )
    expect(committed.status).toBe(0)

    const inventory = runner.inspectRoleWaveStatus('run-merge-01', {
      cwd: repo,
      tempRoot: mergeTempRoot,
    })
    expect(inventory.worktrees['feature-safe']?.changes).toEqual([
      { status: 'A', path: hostileName },
      { status: 'D', path: 'tracked.txt' },
    ])
    expect(
      inventory.worktrees['feature-safe']?.changes.some(
        (change) => change.path.includes('baseline untracked'),
      ),
    ).toBe(false)

    const marker = path.join(repo, 'never-created')
    writeFileLf(
      path.join(repo, '.specrails', 'kimi-role-merge.json'),
      `${JSON.stringify({
        run: 'run-merge-01',
        actions: [
          {
            worktree: 'feature-safe',
            path: hostileName,
            operation: 'copy',
          },
          {
            worktree: 'feature-safe',
            path: 'tracked.txt',
            operation: 'delete',
          },
        ],
      })}\n`,
    )
    const parsed = runner.parseRunnerArgs([
      '--role-merge-file',
      '.specrails/kimi-role-merge.json',
    ])
    const merge = runner.loadRoleMerge(parsed, repo)!
    expect(
      runner.applyRoleMerge(merge, {
        cwd: repo,
        tempRoot: mergeTempRoot,
      }),
    ).toMatchObject({
      run: 'run-merge-01',
      applied: 2,
    })
    expect(readFileSync(path.join(repo, hostileName), 'utf8')).toBe(
      'new role output\n',
    )
    expect(existsSync(path.join(repo, 'tracked.txt'))).toBe(false)
    expect(existsSync(marker)).toBe(false)

    const cleaned = runner.cleanupRoleWave('run-merge-01', {
      cwd: repo,
      tempRoot: mergeTempRoot,
    })
    expect(cleaned.removedWorktrees).toBe(1)
    expect(existsSync(cleaned.manifestPath)).toBe(false)
    expect(existsSync(worktree)).toBe(false)
    const privateRefs = spawnSync(
      'git',
      ['for-each-ref', '--format=%(refname)', 'refs/specrails/kimi/'],
      { cwd: repo, encoding: 'utf8' },
    )
    expect(privateRefs.status).toBe(0)
    expect(privateRefs.stdout).toBe('')
  })

  it('rejects a tampered manifest git oid before invoking a ref-like git argument', async () => {
    const repo = createWaveRepo('role-wave-tampered-manifest')
    const providerRoot = writeSkill('tamper-role', 'body')
    writeRoleWave(repo, {
      run: 'run-tampered-01',
      roles: [
        {
          key: 'tamper-role',
          skill: 'tamper-role',
          model: 'k3',
          args: '',
          workspace: 'worktree:feature-tamper',
        },
      ],
    })
    const tamperedTempRoot = path.join(
      tmpDir,
      'role-wave-tampered-temp',
    )
    await runner.runSkillCli(
      ['--role-wave-file', '.specrails/kimi-role-wave.json'],
      {
        scriptPath: path.join(providerRoot, 'specrails', 'run-skill.mjs'),
        cwd: repo,
        platform: 'linux',
        env: { PATH: '/safe/bin' },
        signalSource: new EventEmitter(),
        tempRoot: tamperedTempRoot,
        writeOutput: () => {},
        spawnChild: () => createRoleChild(0, { content: 'done' }),
      },
    )
    const manifestPath = path.join(
      repo,
      '.specrails',
      'kimi-role-worktrees',
      'run-tampered-01.json',
    )
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >
    manifest.baseCommit = '--help'
    writeFileLf(manifestPath, `${JSON.stringify(manifest)}\n`)
    expect(() =>
      runner.inspectRoleWaveStatus('run-tampered-01', {
        cwd: repo,
        tempRoot: tamperedTempRoot,
      }),
    ).toThrow(/Invalid role wave manifest/)
  })

  it('rejects registered foreign worktree paths and a retargeted private baseline ref', async () => {
    const repo = createWaveRepo('role-wave-manifest-integrity')
    const providerRoot = writeSkill('integrity-role', 'body')
    const tempRoot = path.join(tmpDir, 'role-wave-integrity-temp')
    writeRoleWave(repo, {
      run: 'run-integrity-01',
      roles: [
        {
          key: 'integrity-role',
          skill: 'integrity-role',
          model: 'k3',
          args: '',
          workspace: 'worktree:feature-integrity',
        },
      ],
    })
    await runner.runSkillCli(
      ['--role-wave-file', '.specrails/kimi-role-wave.json'],
      {
        scriptPath: path.join(providerRoot, 'specrails', 'run-skill.mjs'),
        cwd: repo,
        platform: 'linux',
        env: { PATH: '/safe/bin' },
        signalSource: new EventEmitter(),
        tempRoot,
        writeOutput: () => {},
        spawnChild: () => createRoleChild(0, { content: 'done' }),
      },
    )
    const manifestPath = path.join(
      repo,
      '.specrails',
      'kimi-role-worktrees',
      'run-integrity-01.json',
    )
    const original = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      baseCommit: string
      worktrees: Record<string, string>
      roles: Record<
        string,
        {
          executionCwd: string
          repoDir: string
          workspace: string
          gitExcludeFile: string
        }
      >
    }
    const foreign = path.join(tmpDir, 'foreign-registered-worktree')
    const added = spawnSync(
      'git',
      ['worktree', 'add', '--detach', foreign, 'HEAD'],
      { cwd: repo, encoding: 'utf8' },
    )
    expect(added.status).toBe(0)
    const tampered = structuredClone(original)
    tampered.worktrees['feature-integrity'] = realpathSync(foreign)
    tampered.roles['integrity-role']!.executionCwd = realpathSync(foreign)
    tampered.roles['integrity-role']!.repoDir = realpathSync(foreign)
    writeFileLf(manifestPath, `${JSON.stringify(tampered)}\n`)

    expect(() =>
      runner.inspectRoleWaveStatus('run-integrity-01', {
        cwd: repo,
        tempRoot,
      }),
    ).toThrow(/worktree path mismatch/)
    expect(() =>
      runner.cleanupRoleWave('run-integrity-01', {
        cwd: repo,
        tempRoot,
      }),
    ).toThrow(/worktree path mismatch/)
    expect(existsSync(foreign)).toBe(true)
    const removed = spawnSync(
      'git',
      ['worktree', 'remove', '--force', foreign],
      { cwd: repo, encoding: 'utf8' },
    )
    expect(removed.status).toBe(0)

    writeFileLf(manifestPath, `${JSON.stringify(original)}\n`)
    const privateRef = spawnSync(
      'git',
      [
        'for-each-ref',
        '--format=%(refname)',
        'refs/specrails/kimi/',
      ],
      { cwd: repo, encoding: 'utf8' },
    ).stdout.trim()
    expect(privateRef).toMatch(/^refs\/specrails\/kimi\//)
    const retargeted = spawnSync(
      'git',
      ['update-ref', privateRef, 'HEAD'],
      { cwd: repo, encoding: 'utf8' },
    )
    expect(retargeted.status).toBe(0)
    expect(() =>
      runner.inspectRoleWaveStatus('run-integrity-01', {
        cwd: repo,
        tempRoot,
      }),
    ).toThrow(/private ref does not match/)

    const restored = spawnSync(
      'git',
      ['update-ref', privateRef, original.baseCommit],
      { cwd: repo, encoding: 'utf8' },
    )
    expect(restored.status).toBe(0)
    expect(
      runner.cleanupRoleWave('run-integrity-01', {
        cwd: repo,
        tempRoot,
      }).removedWorktrees,
    ).toBe(1)
  })

  it('waits for the whole wave and reports partial failure', async () => {
    const repo = createWaveRepo('role-wave-partial')
    const providerRoot = writeSkill('partial-a', 'A')
    writeSkill('partial-b', 'B')
    writeRoleWave(repo, {
      run: 'run-partial-01',
      roles: [
        {
          key: 'required-a',
          skill: 'partial-a',
          model: 'k3',
          args: '',
          workspace: 'current',
        },
        {
          key: 'required-b',
          skill: 'partial-b',
          model: 'k3',
          args: '',
          workspace: 'current',
        },
      ],
    })
    const output: string[] = []
    let index = 0
    const code = await runner.runSkillCli(
      ['--role-wave-file', '.specrails/kimi-role-wave.json'],
      {
        scriptPath: path.join(providerRoot, 'specrails', 'run-skill.mjs'),
        cwd: repo,
        platform: 'linux',
        env: { PATH: '/safe/bin' },
        signalSource: new EventEmitter(),
        tempRoot: path.join(tmpDir, 'role-wave-partial-temp'),
        writeOutput: (line) => output.push(line),
        spawnChild: () =>
          createRoleChild(index++ === 0 ? 0 : 7, { content: 'finished' }),
      },
    )
    expect(code).toBe(7)
    const completed = output
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((frame) => frame.type === 'specrails.role.completed')
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleKey: 'required-a', status: 'succeeded' }),
        expect.objectContaining({
          roleKey: 'required-b',
          status: 'failed',
          exitCode: 7,
        }),
      ]),
    )
  })

  it('forwards one cancellation signal to every live role child', async () => {
    const repo = createWaveRepo('role-wave-cancel')
    const providerRoot = writeSkill('cancel-a', 'A')
    writeSkill('cancel-b', 'B')
    writeRoleWave(repo, {
      run: 'run-cancel-01',
      roles: [
        {
          key: 'cancel-a',
          skill: 'cancel-a',
          model: 'k3',
          args: '',
          workspace: 'current',
        },
        {
          key: 'cancel-b',
          skill: 'cancel-b',
          model: 'k3',
          args: '',
          workspace: 'current',
        },
      ],
    })
    const signalSource = new EventEmitter()
    const children: Array<ReturnType<typeof createRoleChild>> = []
    const codePromise = runner.runSkillCli(
      ['--role-wave-file', '.specrails/kimi-role-wave.json'],
      {
        scriptPath: path.join(providerRoot, 'specrails', 'run-skill.mjs'),
        cwd: repo,
        platform: 'linux',
        env: { PATH: '/safe/bin' },
        signalSource,
        tempRoot: path.join(tmpDir, 'role-wave-cancel-temp'),
        writeOutput: () => {},
        spawnChild: () => {
          const child = createRoleChild(0, { content: 'unused' })
          // Suppress the helper's scheduled normal completion for this test by
          // returning a fresh child that exits only when killed.
          const pending = new EventEmitter() as ReturnType<typeof createRoleChild>
          pending.stdout = new PassThrough()
          pending.stderr = new PassThrough()
          pending.stdin = new PassThrough()
          pending.kill = vi.fn((signal: string) => {
            pending.stdout.end()
            pending.stderr.end()
            queueMicrotask(() => pending.emit('exit', null, signal))
            return true
          })
          child.removeAllListeners()
          children.push(pending)
          if (children.length === 2) {
            queueMicrotask(() => signalSource.emit('SIGTERM'))
          }
          return pending
        },
      },
    )
    await expect(codePromise).resolves.toBe(143)
    expect(children).toHaveLength(2)
    for (const child of children) {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    }
  })

  it('falls back to a copied Windows provider overlay without replacing one', () => {
    const providerRoot = writeSkill('overlay-role', 'body')
    const workspace = path.join(tmpDir, 'windows-overlay')
    mkdirSync(workspace, { recursive: true })
    const createLink = vi.fn(() => {
      throw new Error('junction privilege unavailable')
    })
    const copyTree = vi.fn((source: string, destination: string) => {
      cpSync(source, destination, {
        recursive: true,
        dereference: true,
        errorOnExist: true,
      })
    })
    runner.ensureProviderOverlay(providerRoot, workspace, 'win32', {
      symlink: createLink,
      copyTree,
    })
    expect(createLink).toHaveBeenCalledWith(
      realpathSync(providerRoot),
      path.join(workspace, '.kimi-code'),
      'junction',
    )
    expect(copyTree).toHaveBeenCalled()
    expect(
      readFileSync(
        path.join(
          workspace,
          '.kimi-code',
          'skills',
          'overlay-role',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).toContain('overlay-role test skill')

    writeFileLf(
      path.join(
        workspace,
        '.kimi-code',
        'skills',
        'overlay-role',
        'SKILL.md',
      ),
      'tampered\n',
    )
    runner.ensureProviderOverlay(providerRoot, workspace, 'win32', {
      symlink: createLink,
      copyTree,
    })
    expect(copyTree).toHaveBeenCalledTimes(2)
    expect(
      readFileSync(
        path.join(
          workspace,
          '.kimi-code',
          'skills',
          'overlay-role',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).toContain('overlay-role test skill')

    const owned = path.join(tmpDir, 'windows-overlay-owned')
    writeFileLf(path.join(owned, '.kimi-code', 'user.txt'), 'preserve\n')
    const shouldNotLink = vi.fn()
    expect(() =>
      runner.ensureProviderOverlay(providerRoot, owned, 'win32', {
        symlink: shouldNotLink,
      }),
    ).toThrow(/unverified worktree provider directory/)
    expect(shouldNotLink).not.toHaveBeenCalled()
    expect(
      readFileSync(path.join(owned, '.kimi-code', 'user.txt'), 'utf8'),
    ).toBe('preserve\n')

    const wrongLinkWorkspace = path.join(tmpDir, 'windows-overlay-wrong-link')
    const wrongTarget = path.join(tmpDir, 'wrong-kimi-provider')
    mkdirSync(wrongTarget, { recursive: true })
    mkdirSync(wrongLinkWorkspace, { recursive: true })
    symlinkSync(
      wrongTarget,
      path.join(wrongLinkWorkspace, '.kimi-code'),
      'dir',
    )
    expect(() =>
      runner.ensureProviderOverlay(
        providerRoot,
        wrongLinkWorkspace,
        'win32',
      ),
    ).toThrow(/does not target the managed provider/)
  })

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
