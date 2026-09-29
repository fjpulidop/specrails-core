#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { load as loadYaml } from './vendor/js-yaml/js-yaml.mjs'

const SAFE_SKILL_ID = /^[a-z0-9][a-z0-9-]*$/
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/
const MAX_MODEL_ID_LENGTH = 128
const MAX_SESSION_ID_LENGTH = 128
const MAX_EXECUTION_CONTEXT_BYTES = 1_048_576
const WINDOWS_COMMAND_LINE_BUDGET = 30_000
const MAX_MANAGED_PROMPT_BYTES = 1_048_576
const PLAIN_PROMPT_STDIN_FLAG = '--plain-prompt-stdin'
export const WINDOWS_PROMPT_STDIN_TOKEN =
  '__SPECRAILS_KIMI_PROMPT_FROM_STDIN__'
export const WINDOWS_NPM_STDIN_BOOTSTRAP = [
  "const {readFileSync}=require('node:fs');",
  "const {pathToFileURL}=require('node:url');",
  '(async()=>{',
  'const entry=process.argv[1];',
  `const marker=${JSON.stringify(WINDOWS_PROMPT_STDIN_TOKEN)};`,
  "const promptFlag=process.argv.lastIndexOf('-p');",
  'const index=promptFlag+1;',
  "if(promptFlag<2||process.argv[index]!==marker)throw new Error('SpecRails Kimi prompt marker missing');",
  "process.argv[index]=readFileSync(0,'utf8');",
  'await import(pathToFileURL(entry).href);',
  "})().catch(error=>{console.error(error);process.exitCode=1})",
].join('')
const KNOWN_SKILL_TYPES = new Set(['prompt', 'inline', 'flow', 'reference'])
const OFFICIAL_SHORT_MODEL_IDS = new Set([
  'k3',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
])

const VALUE_FLAGS = new Set([
  '--skill',
  '--model',
  '--args',
  '--session',
  '--add-dir',
  '--attachment',
  '--prompt',
])

export class RunnerUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RunnerUsageError'
  }
}

export function normalizeKimiCliModel(model) {
  const value = requireSafeModelId(model)
  return OFFICIAL_SHORT_MODEL_IDS.has(value) ? `kimi-code/${value}` : value
}

export function tokenizeSkillArguments(raw) {
  const out = []
  let current = ''
  let quote
  let hasContent = false

  for (const char of raw) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
        hasContent = true
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasContent = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        out.push(current)
        current = ''
        hasContent = false
      }
      continue
    }
    current += char
    hasContent = true
  }

  if (hasContent) out.push(current)
  return out
}

export function expandSkillParameters(body, rawArgs, context) {
  const tokens = tokenizeSkillArguments(rawArgs)
  let content = body

  for (let index = 0; index < (context.argumentNames?.length ?? 0); index++) {
    const name = context.argumentNames[index]
    if (name === undefined) continue
    const escaped = escapeRegExp(name)
    content = content.replace(
      new RegExp(`\\$${escaped}(?![\\[\\w])`, 'g'),
      escapeXmlTags(tokens[index] ?? ''),
    )
  }

  content = content
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, indexText) => {
      const index = Number.parseInt(indexText, 10)
      return escapeXmlTags(tokens[index] ?? '')
    })
    .replace(/\$(\d+)(?!\w)/g, (_match, indexText) => {
      const index = Number.parseInt(indexText, 10)
      return escapeXmlTags(tokens[index] ?? '')
    })
    .split('$ARGUMENTS')
    .join(escapeXmlTags(rawArgs))

  const hasArgumentPlaceholder = content !== body
  content = content
    .split('${KIMI_SKILL_DIR}')
    .join(context.skillDir)
    .split('${KIMI_SESSION_ID}')
    .join(context.sessionId ?? '')

  if (!hasArgumentPlaceholder && rawArgs.length > 0) {
    return `${content}\n\nARGUMENTS: ${escapeXmlTags(rawArgs)}`
  }
  return content
}

export function renderUserSlashSkillPrompt(input) {
  return [
    `User activated the skill "${escapeXml(input.skillName)}". Follow the loaded skill instructions.`,
    '',
    `<kimi-skill-loaded name="${escapeXml(input.skillName)}" trigger="user-slash" source="project" dir="${escapeXml(input.skillDir)}" args="${escapeXml(input.skillArgs)}">`,
    input.skillContent,
    '</kimi-skill-loaded>',
  ].join('\n')
}

export function parseSkillDocument(text, options = {}) {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    throw new RunnerUsageError(
      `Skill ${options.skillId ?? ''} is missing required frontmatter`.trim(),
    )
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close === -1) {
    throw new RunnerUsageError(
      `Skill ${options.skillId ?? ''} has no closing frontmatter fence`.trim(),
    )
  }

  const yamlText = lines.slice(1, close).join('\n').trim()
  let frontmatter
  try {
    frontmatter = yamlText === '' ? {} : (loadYaml(yamlText) ?? {})
  } catch (error) {
    throw new RunnerUsageError(
      `Invalid frontmatter in skill ${options.skillId ?? ''}: ${errorMessage(error)}`.trim(),
    )
  }
  if (!isRecord(frontmatter)) {
    throw new RunnerUsageError(
      `Frontmatter in skill ${options.skillId ?? ''} must be a mapping`.trim(),
    )
  }

  const name = nonEmptyString(frontmatter.name)
  const description = nonEmptyString(frontmatter.description)
  const hasType = Object.prototype.hasOwnProperty.call(frontmatter, 'type')
  if (
    hasType &&
    (typeof frontmatter.type !== 'string' || frontmatter.type.trim() === '')
  ) {
    throw new RunnerUsageError(
      `Skill ${options.skillId ?? ''} has an invalid type`.trim(),
    )
  }
  const type = nonEmptyString(frontmatter.type)
  if (name === undefined) {
    throw new RunnerUsageError(`Skill ${options.skillId ?? ''} has no valid name`.trim())
  }
  if (description === undefined) {
    throw new RunnerUsageError(
      `Skill ${options.skillId ?? ''} has no valid description`.trim(),
    )
  }
  if (type !== undefined && !KNOWN_SKILL_TYPES.has(type)) {
    throw new RunnerUsageError(`Skill "${name}" has unsupported type "${type}"`)
  }
  if (type === 'reference') {
    throw new RunnerUsageError(
      `Skill "${name}" has type "reference" and cannot be activated by the user`,
    )
  }

  return {
    name,
    description,
    type,
    argumentNames: skillArgumentNames(frontmatter.arguments),
    body: lines.slice(close + 1).join('\n').trim(),
  }
}

export function parseRunnerArgs(argv) {
  const parsed = {
    skill: undefined,
    model: undefined,
    rawArgs: '',
    sessionId: undefined,
    additionalDirs: [],
    attachmentPaths: [],
    extraPrompt: undefined,
    plainPromptStdin: false,
    renderOnly: false,
  }
  let positionalArgs
  const seenSingleValueFlags = new Set()

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--') {
      positionalArgs = argv.slice(index + 1).join(' ')
      break
    }
    if (token.startsWith('--session=')) {
      if (seenSingleValueFlags.has('--session')) {
        throw new RunnerUsageError('--session may be supplied once')
      }
      const value = token.slice('--session='.length)
      assertNoNul(value, '--session')
      seenSingleValueFlags.add('--session')
      parsed.sessionId = value
      continue
    }
    if (token === '--render-only') {
      if (parsed.renderOnly) throw new RunnerUsageError('--render-only may be supplied once')
      parsed.renderOnly = true
      continue
    }
    if (token === PLAIN_PROMPT_STDIN_FLAG) {
      if (parsed.renderOnly && parsed.plainPromptStdin) throw new RunnerUsageError('--render-only requires a skill')
  if (parsed.plainPromptStdin) {
        throw new RunnerUsageError(
          `${PLAIN_PROMPT_STDIN_FLAG} may be supplied once`,
        )
      }
      parsed.plainPromptStdin = true
      continue
    }
    if (!VALUE_FLAGS.has(token)) {
      throw new RunnerUsageError(`Unknown option: ${token}`)
    }
    if (index + 1 >= argv.length) {
      throw new RunnerUsageError(`${token} requires a value`)
    }
    const value = argv[++index]
    assertNoNul(value, token)
    if (token === '--add-dir') {
      parsed.additionalDirs.push(path.resolve(requireNonEmpty(value, token)))
    } else if (token === '--attachment') {
      if (!path.isAbsolute(value)) {
        throw new RunnerUsageError(`Attachment path must be absolute: ${value}`)
      }
      parsed.attachmentPaths.push(value)
    } else {
      if (seenSingleValueFlags.has(token)) {
        throw new RunnerUsageError(`${token} may be supplied once`)
      }
      seenSingleValueFlags.add(token)
      if (token === '--skill') {
        parsed.skill = value
      } else if (token === '--model') {
        parsed.model = value
      } else if (token === '--args') {
        parsed.rawArgs = value
      } else if (token === '--session') {
        parsed.sessionId = value
      } else if (token === '--prompt') {
        parsed.extraPrompt = value
      }
    }
  }

  if (positionalArgs !== undefined) {
    if (seenSingleValueFlags.has('--args')) {
      throw new RunnerUsageError('Use either --args or positional arguments after --, not both')
    }
    parsed.rawArgs = positionalArgs
  }

  if (parsed.renderOnly && parsed.plainPromptStdin) throw new RunnerUsageError('--render-only requires a skill')
  if (parsed.plainPromptStdin) {
    for (const flag of ['--skill', '--args', '--prompt', '--attachment']) {
      if (
        seenSingleValueFlags.has(flag) ||
        (flag === '--attachment' && parsed.attachmentPaths.length > 0)
      ) {
        throw new RunnerUsageError(
          `${PLAIN_PROMPT_STDIN_FLAG} cannot be combined with ${flag}`,
        )
      }
    }
    if (positionalArgs !== undefined) {
      throw new RunnerUsageError(
        `${PLAIN_PROMPT_STDIN_FLAG} cannot be combined with positional arguments`,
      )
    }
    parsed.model = requireSafeModelId(parsed.model)
    if (parsed.sessionId !== undefined) {
      parsed.sessionId = requireSafeSessionId(parsed.sessionId)
    }
  } else {
    parsed.skill = requireSafeSkillId(parsed.skill)
    parsed.model = requireSafeModelId(parsed.model)
    parsed.rawArgs = parsed.rawArgs.trim()
    if (parsed.sessionId !== undefined) {
      parsed.sessionId = requireSafeSessionId(parsed.sessionId)
    }
  }
  return parsed
}

export function prepareSkillLaunch(options, dependencies = {}) {
  const readFile = dependencies.readFile ?? ((file) => readFileSync(file, 'utf8'))
  const resolvePath = dependencies.resolvePath ?? realpathSync
  const stat = dependencies.stat ?? statSync
  const attachments = validateAttachmentPaths(
    options.attachmentPaths,
    dependencies,
  )
  const skillId = requireSafeSkillId(options.skill)
  const sessionId =
    options.sessionId === undefined
      ? undefined
      : requireSafeSessionId(options.sessionId)
  const skillDirCandidate = path.join(options.providerRoot, 'skills', skillId)
  const skillPathCandidate = path.join(skillDirCandidate, 'SKILL.md')

  let text
  try {
    if (!stat(skillPathCandidate).isFile()) {
      throw new Error('not a regular file')
    }
    text = readFile(skillPathCandidate)
  } catch (error) {
    throw new RunnerUsageError(
      `Cannot read skill "${skillId}" at ${skillPathCandidate}: ${errorMessage(error)}`,
    )
  }

  // Kimi's scanner canonicalizes each discovered skill root. Use the same
  // real path for context placeholders and the activation envelope.
  const skillDir = toPromptPath(resolvePath(skillDirCandidate))
  const parsed = parseSkillDocument(text, { skillId })
  if (parsed.name.toLowerCase() !== skillId.toLowerCase()) {
    throw new RunnerUsageError(
      `Skill directory "${skillId}" declares mismatched name "${parsed.name}"`,
    )
  }
  if (parsed.body.length === 0) {
    throw new RunnerUsageError(`Skill "${skillId}" has an empty body`)
  }
  if (sessionId === undefined && parsed.body.includes('${KIMI_SESSION_ID}')) {
    throw new RunnerUsageError(
      `Skill "${skillId}" requires KIMI_SESSION_ID; start it only with --session=<id>`,
    )
  }
  const expanded = expandSkillParameters(parsed.body, options.rawArgs, {
    skillDir,
    sessionId,
    argumentNames: parsed.argumentNames,
  })
  let prompt = renderUserSlashSkillPrompt({
    skillName: parsed.name,
    skillArgs: options.rawArgs,
    skillContent: expanded,
    skillDir,
  })

  if (options.extraPrompt?.trim()) {
    prompt += `\n\n${options.extraPrompt.trim()}`
  }
  if (attachments.length > 0) {
    prompt += [
      '',
      '',
      'Attached files (absolute paths):',
      ...attachments.map((attachment) => `- ${attachment}`),
      '',
      'Read textual files with ReadFile. For images or other media, use',
      'ReadMediaFile on the exact path. Kimi prompt mode has no attachment flag.',
    ].join('\n')
  }

  const kimiArgs = [
    ...(sessionId ? [`--session=${sessionId}`] : []),
    ...Array.from(
      new Set([
        ...options.additionalDirs.map(canonicalizeExistingPath),
        ...attachments.map((attachment) => path.dirname(attachment)),
      ]),
    ).flatMap((dir) => ['--add-dir', dir]),
    '-m',
    normalizeKimiCliModel(options.model),
    '-p',
    prompt,
    '--output-format',
    'stream-json',
  ]
  return { prompt, kimiArgs, skillDir, skillName: parsed.name }
}

function canonicalizeExistingPath(value) {
  try {
    return canonicalRealpath(value)
  } catch {
    return path.resolve(value)
  }
}

/**
 * Node's legacy realpath implementation can preserve an input's Windows 8.3
 * spelling. Use the native resolver so --add-dir receives the long name.
 */
function canonicalRealpath(value) {
  const resolved =
    typeof realpathSync.native === 'function'
      ? realpathSync.native(value)
      : realpathSync(value)
  return path.resolve(resolved)
}

function validateAttachmentPaths(attachmentPaths = [], dependencies = {}) {
  const inspect = dependencies.lstat ?? lstatSync
  const resolvePath = dependencies.resolvePath ?? realpathSync
  const assertReadable =
    dependencies.access ??
    ((file) => {
      accessSync(file, fsConstants.R_OK)
    })
  return attachmentPaths.map((attachment) => {
    if (!path.isAbsolute(attachment)) {
      throw new RunnerUsageError(
        `Attachment path must be absolute: ${attachment}`,
      )
    }
    try {
      const metadata = inspect(attachment)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('not a regular non-symlink file')
      }
      const canonical = resolvePath(attachment)
      assertReadable(canonical)
      return canonical
    } catch (error) {
      throw new RunnerUsageError(
        `Attachment must be a readable regular non-symlink file: ` +
          `${attachment}: ${errorMessage(error)}`,
      )
    }
  })
}

export function parseNpmCmdShimEntry(shimPath, contents) {
  const match = contents.match(
    /%dp0%[\\/]([^"\r\n]*?\.(?:mjs|cjs|js))["']?\s+%\*/i,
  )
  if (!match?.[1]) return null
  return path.win32.join(path.win32.dirname(shimPath), match[1])
}

export function resolveWindowsKimiBinary(env = process.env, fileExists = existsSync) {
  const pathValue = getEnvCaseInsensitive(env, 'PATH') ?? ''
  // npm installs three siblings on Windows: `kimi`, `kimi.cmd`, and
  // `kimi.ps1`. The extensionless sibling is a POSIX shell script and cannot
  // be passed to CreateProcess, while PowerShell scripts cannot be spawned
  // directly with shell:false. Probe only executable-safe forms, with the npm
  // command shim first so large prompts can use the stdin bootstrap.
  const names = ['kimi.cmd', 'kimi.bat', 'kimi.exe', 'kimi.com']

  for (const rawEntry of pathValue.split(';')) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1')
    if (entry === '') continue
    for (const name of names) {
      const candidate = path.win32.join(entry, name)
      if (fileExists(candidate)) return candidate
    }
  }
  throw new RunnerUsageError(
    'No shell-free Kimi executable (.cmd, .bat, .exe, or .com) was found on PATH',
  )
}

export function resolveKimiLaunch(kimiArgs, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return { command: 'kimi', args: kimiArgs }
  }

  const fileExists = options.fileExists ?? existsSync
  const readFile = options.readFile ?? ((file) => readFileSync(file, 'utf8'))
  const binary = options.binary ?? resolveWindowsKimiBinary(options.env, fileExists)
  const extension = path.win32.extname(binary).toLowerCase()
  if (extension !== '.cmd' && extension !== '.bat') {
    assertWindowsCommandLineBudget(binary, kimiArgs)
    return { command: binary, args: kimiArgs }
  }

  let entry
  try {
    entry = parseNpmCmdShimEntry(binary, readFile(binary))
  } catch (error) {
    throw new RunnerUsageError(
      `Cannot read the Kimi Windows shim ${binary}: ${errorMessage(error)}`,
    )
  }
  if (entry === null) {
    throw new RunnerUsageError(
      `Refusing to execute non-standard Kimi Windows shim through cmd.exe: ${binary}`,
    )
  }
  const localNode = path.win32.join(path.win32.dirname(binary), 'node.exe')
  const nodeBinary = fileExists(localNode) ? localNode : 'node'
  const promptFlag = kimiArgs.indexOf('-p')
  if (promptFlag === -1 || promptFlag + 1 >= kimiArgs.length) {
    const args = [entry, ...kimiArgs]
    assertWindowsCommandLineBudget(nodeBinary, args)
    return { command: nodeBinary, args }
  }

  const transportedArgs = [...kimiArgs]
  const prompt = transportedArgs[promptFlag + 1]
  transportedArgs[promptFlag + 1] = WINDOWS_PROMPT_STDIN_TOKEN
  const args = [
    '-e',
    WINDOWS_NPM_STDIN_BOOTSTRAP,
    entry,
    ...transportedArgs,
  ]
  assertWindowsCommandLineBudget(nodeBinary, args)
  return { command: nodeBinary, args, stdinText: prompt }
}

/** Resolve the shared backlog and pipeline runtime locations for the skill. */
export function resolvePipelineEnvironment(cwd, env = process.env) {
  const contextPath = nonEmptyString(env.SPECRAILS_EXECUTION_CONTEXT)
  let context
  if (contextPath) {
    if (!path.isAbsolute(contextPath)) throw new RunnerUsageError('SPECRAILS_EXECUTION_CONTEXT must be absolute')
    const metadata = lstatSync(contextPath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_EXECUTION_CONTEXT_BYTES) {
      throw new RunnerUsageError('Execution context must be a bounded regular non-symlink file')
    }
    context = JSON.parse(readFileSync(contextPath, 'utf8'))
    if (!isRecord(context) || context.schemaVersion !== 1 ||
        typeof context.backlogRoot !== 'string' || !path.isAbsolute(context.backlogRoot)) {
      throw new RunnerUsageError('Execution context requires schemaVersion 1 and an absolute backlogRoot')
    }
    if (context.backlogPath !== undefined &&
        (typeof context.backlogPath !== 'string' || !path.isAbsolute(context.backlogPath))) {
      throw new RunnerUsageError('Execution context backlogPath must be absolute')
    }
  }
  const backlogRoot = context?.backlogRoot ?? nonEmptyString(env.SPECRAILS_BACKLOG_ROOT) ?? path.resolve(cwd)
  return {
    ...env,
    SPECRAILS_BACKLOG_ROOT: path.resolve(backlogRoot),
    SPECRAILS_BACKLOG_PATH: context?.backlogPath ?? nonEmptyString(env.SPECRAILS_BACKLOG_PATH) ??
      path.join(path.resolve(backlogRoot), '.specrails', 'local-tickets.json'),
    SPECRAILS_PIPELINE_RUNTIME: nonEmptyString(env.SPECRAILS_PIPELINE_RUNTIME) ??
      path.join(path.resolve(cwd), '.specrails', 'runtime', 'pipeline.mjs'),
    ...(contextPath ? { SPECRAILS_EXECUTION_CONTEXT: contextPath } : {}),
  }
}

export async function runSkillCli(argv, dependencies = {}) {
  const cwd = dependencies.cwd ?? process.cwd()
  const parsedArgs = parseRunnerArgs(argv)
  dependencies = {
    ...dependencies,
    env: resolvePipelineEnvironment(cwd, dependencies.env ?? process.env),
  }
  const scriptPath = dependencies.scriptPath ?? process.argv[1]
  const providerRoot = resolveProviderRoot(scriptPath)
  if (parsedArgs.renderOnly) {
    const { prompt } = prepareSkillLaunch({ ...parsedArgs, providerRoot }, dependencies)
    assertManagedPrompt(prompt)
    ;(dependencies.writeStdout ?? (text => process.stdout.write(text)))(JSON.stringify({ prompt }) + '\n')
    return 0
  }
  if (parsedArgs.plainPromptStdin) {
    const readStdin =
      dependencies.readStdin ??
      (() => readFileSync(0, 'utf8'))
    const prompt = String(readStdin())
    assertManagedPrompt(prompt)
    const kimiArgs = [
      ...(parsedArgs.sessionId
        ? [`--session=${parsedArgs.sessionId}`]
        : []),
      ...parsedArgs.additionalDirs.flatMap((dir) => ['--add-dir', dir]),
      '-m',
      normalizeKimiCliModel(parsedArgs.model),
      '-p',
      prompt,
      '--output-format',
      'stream-json',
    ]
    return runPreparedPrompt(kimiArgs, prompt, {
      ...dependencies,
      cwd,
      model: parsedArgs.model,
    })
  }
  return runPreparedSkill(parsedArgs, {
    ...dependencies,
    cwd,
    providerRoot,
  })
}

async function runPreparedSkill(parsed, dependencies) {
  const prepared = prepareSkillLaunch(
    { ...parsed, providerRoot: dependencies.providerRoot },
    dependencies,
  )
  return runPreparedPrompt(
    prepared.kimiArgs,
    prepared.prompt,
    {
      ...dependencies,
      model: parsed.model,
    },
  )
}

async function runPreparedPrompt(kimiArgs, prompt, dependencies) {
  assertManagedPrompt(prompt)
  let removeSignalForwarding = () => {}
  try {
    // Kimi 0.27 exposes only `-p <prompt>` for an exact non-interactive user
    // turn. The managed runner receives plain prompts over stdin so the host
    // process does not expose them, but a native Kimi binary must still receive
    // the exact prompt in its own argv. npm Windows shims use the exact stdin
    // bootstrap in resolveKimiLaunch instead. Do not replace this with a
    // prompt-file instruction: that changes the first user turn and telemetry.
    const launch = resolveKimiLaunch(kimiArgs, dependencies)
    const spawnChild = dependencies.spawnChild ?? spawn
    const env = stableKimiEnvironment(
      dependencies.env ?? process.env,
      dependencies.model,
    )
    const child = spawnChild(launch.command, launch.args, {
      cwd: dependencies.cwd,
      env,
      shell: false,
      stdio:
        launch.stdinText === undefined
          ? 'inherit'
          : ['pipe', 'inherit', 'inherit'],
    })
    const completion = waitForChild(child)
    removeSignalForwarding = forwardTerminationSignals(
      child,
      dependencies.signalSource ?? process,
    )
    if (launch.stdinText === undefined) {
      return await completion
    }
    try {
      const [code] = await Promise.all([
        completion,
        writePromptToChild(child, launch.stdinText),
      ])
      return code
    } catch (error) {
      child.kill?.('SIGTERM')
      throw error
    }
  } finally {
    removeSignalForwarding()
  }
}

function assertManagedPrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new RunnerUsageError('Kimi prompt must not be empty')
  }
  const byteLength = Buffer.byteLength(prompt, 'utf8')
  if (byteLength > MAX_MANAGED_PROMPT_BYTES) {
    throw new RunnerUsageError(
      `Kimi prompt exceeds ${MAX_MANAGED_PROMPT_BYTES} UTF-8 bytes`,
    )
  }
}

export function forwardTerminationSignals(child, signalSource = process) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const handlers = new Map()
  for (const signal of signals) {
    const handler = () => {
      try {
        child.kill?.(signal)
      } catch {
        // The child may already have exited; waitForChild owns final status.
      }
    }
    handlers.set(signal, handler)
    signalSource.on(signal, handler)
  }
  return () => {
    for (const [signal, handler] of handlers) {
      signalSource.off(signal, handler)
    }
  }
}

export function resolveProviderRoot(scriptPath) {
  const absolute = path.resolve(requireNonEmpty(scriptPath, 'runner path'))
  const runnerDir = path.dirname(absolute)
  const providerRoot = path.dirname(runnerDir)
  if (
    path.basename(runnerDir) !== 'specrails' ||
    path.basename(providerRoot) !== '.kimi-code'
  ) {
    throw new RunnerUsageError(
      'run-skill.mjs must be invoked from .kimi-code/specrails/run-skill.mjs',
    )
  }
  return providerRoot
}

function skillArgumentNames(value) {
  const isValidName = (name) => name.trim() !== '' && !/^\d+$/.test(name)
  if (typeof value === 'string') return value.split(/\s+/).filter(isValidName)
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && isValidName(item))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined
}

function escapeXml(input) {
  return input
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;')
    .split('"')
    .join('&quot;')
}

function escapeXmlTags(input) {
  return input.split('<').join('&lt;').split('>').join('&gt;')
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toPromptPath(nativePath) {
  const slashPath = nativePath.split('\\').join('/').split(path.sep).join('/')
  return /^[a-z]:\//.test(slashPath)
    ? slashPath[0].toUpperCase() + slashPath.slice(1)
    : slashPath
}

function requireSafeSkillId(value) {
  const skill = requireNonEmpty(value, 'skill')
  if (!SAFE_SKILL_ID.test(skill)) {
    throw new RunnerUsageError(`Invalid skill id: ${skill}`)
  }
  return skill
}

function requireSafeModelId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MODEL_ID_LENGTH ||
    !SAFE_MODEL_ID.test(value)
  ) {
    throw new RunnerUsageError(
      'Invalid model id: expected 1-128 characters matching ' +
        '[A-Za-z0-9][A-Za-z0-9._/:-]*',
    )
  }
  return value
}

function requireSafeSessionId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SESSION_ID_LENGTH ||
    !SAFE_SESSION_ID.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new RunnerUsageError(
      'Invalid session id: expected 1-128 characters matching ' +
        '[A-Za-z0-9._-]+, excluding "." and ".."',
    )
  }
  return value
}

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerUsageError(`Missing or empty ${label}`)
  }
  assertNoNul(value, label)
  return value.trim()
}

function assertNoNul(value, label) {
  if (value.includes('\0')) throw new RunnerUsageError(`${label} contains a NUL byte`)
}

function getEnvCaseInsensitive(env, key) {
  const found = Object.entries(env ?? {}).find(
    ([candidate]) => candidate.toUpperCase() === key,
  )
  return found?.[1]
}

export function windowsCommandLineLength(command, args) {
  return [command, ...args].map(quoteWindowsArgument).join(' ').length
}

function assertWindowsCommandLineBudget(command, args) {
  const length = windowsCommandLineLength(command, args)
  if (length > WINDOWS_COMMAND_LINE_BUDGET) {
    throw new RunnerUsageError(
      `Kimi Windows command line requires ${length} UTF-16 code units, above ` +
        `${WINDOWS_COMMAND_LINE_BUDGET}. Use the standard npm kimi.cmd shim so ` +
        'SpecRails can transport the materialized prompt over stdin.',
    )
  }
}

function quoteWindowsArgument(value) {
  if (value !== '' && !/[\s"]/u.test(value)) return value
  return (
    '"' +
    value
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\+)$/g, '$1$1') +
    '"'
  )
}

export function stableKimiEnvironment(source, model) {
  const env = { ...source }
  let validThinkingEffort
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase()
    if (normalizedKey === 'KIMI_CODE_EXPERIMENTAL_FLAG') {
      delete env[key]
    } else if (
      normalizedKey === 'KIMI_DISABLE_CRON' ||
      normalizedKey === 'KIMI_CODE_NO_AUTO_UPDATE'
    ) {
      delete env[key]
    } else if (normalizedKey === 'KIMI_MODEL_THINKING_EFFORT') {
      const value = env[key]
      if (
        validThinkingEffort === undefined &&
        (value === 'low' || value === 'high' || value === 'max')
      ) {
        validThinkingEffort = value
      }
      delete env[key]
    }
  }
  // A managed `-p` run owns one bounded foreground invocation. It must not
  // create persistent schedules or mutate the external CLI during startup.
  env.KIMI_DISABLE_CRON = '1'
  env.KIMI_CODE_NO_AUTO_UPDATE = '1'
  if (
    normalizeKimiCliModel(model) === 'kimi-code/k3' &&
    validThinkingEffort !== undefined
  ) {
    env.KIMI_MODEL_THINKING_EFFORT = validThinkingEffort
  }
  return env
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code !== null) {
        resolve(code)
        return
      }
      resolve(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143)
    })
  })
}

function writePromptToChild(child, prompt) {
  if (!child.stdin || typeof child.stdin.end !== 'function') {
    return Promise.reject(new RunnerUsageError(
      'Cannot transport the Kimi prompt: child stdin is unavailable',
    ))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, keepErrorListener = false) => {
      if (settled) return
      settled = true
      // Node's Writable.end callback receives a write error before the stream
      // emits its corresponding `error` event. Keep the once-listener in that
      // case so the later event is consumed instead of becoming unhandled.
      if (!keepErrorListener) child.stdin.off?.('error', onError)
      if (error) {
        reject(
          new RunnerUsageError(
            `Cannot transport the Kimi prompt: ${errorMessage(error)}`,
          ),
        )
      } else {
        resolve()
      }
    }
    const onError = (error) => finish(error)
    child.stdin.once('error', onError)
    child.stdin.end(prompt, 'utf8', (error) =>
      finish(error, Boolean(error)),
    )
  })
}

function isDirectExecution() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectExecution()) {
  try {
    process.exitCode = await runSkillCli(process.argv.slice(2))
  } catch (error) {
    const prefix = error instanceof RunnerUsageError ? 'usage error' : 'error'
    process.stderr.write(`specrails Kimi skill runner ${prefix}: ${errorMessage(error)}\n`)
    process.exitCode = error instanceof RunnerUsageError ? 2 : 1
  }
}
