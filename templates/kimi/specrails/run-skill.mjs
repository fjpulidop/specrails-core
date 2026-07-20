#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  copyFileSync,
  cpSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

import { load as loadYaml } from './vendor/js-yaml/js-yaml.mjs'

const SAFE_SKILL_ID = /^[a-z0-9][a-z0-9-]*$/
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/
const SAFE_WAVE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const SAFE_GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const MAX_MODEL_ID_LENGTH = 128
const MAX_SESSION_ID_LENGTH = 128
const MAX_ROLE_REQUEST_BYTES = 1_048_576
const MAX_ROLE_WAVE_SIZE = 32
const ROLE_REQUEST_RELATIVE_PATH = path.join(
  '.specrails',
  'kimi-role-request.json',
)
const ROLE_WAVE_RELATIVE_PATH = path.join(
  '.specrails',
  'kimi-role-wave.json',
)
const ROLE_MERGE_RELATIVE_PATH = path.join(
  '.specrails',
  'kimi-role-merge.json',
)
const ROLE_WORKTREE_MANIFEST_DIR = path.join(
  '.specrails',
  'kimi-role-worktrees',
)
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
  '--request-file',
  '--role-wave-file',
  '--role-wave-status',
  '--role-wave-cleanup',
  '--role-merge-file',
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
    requestFile: undefined,
    roleWaveFile: undefined,
    roleWaveStatus: undefined,
    roleWaveCleanup: undefined,
    roleMergeFile: undefined,
    plainPromptStdin: false,
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
    if (token === PLAIN_PROMPT_STDIN_FLAG) {
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
      } else if (token === '--request-file') {
        parsed.requestFile = value
      } else if (token === '--role-wave-file') {
        parsed.roleWaveFile = value
      } else if (token === '--role-wave-status') {
        parsed.roleWaveStatus = value
      } else if (token === '--role-wave-cleanup') {
        parsed.roleWaveCleanup = value
      } else if (token === '--role-merge-file') {
        parsed.roleMergeFile = value
      }
    }
  }

  if (positionalArgs !== undefined) {
    if (seenSingleValueFlags.has('--args')) {
      throw new RunnerUsageError('Use either --args or positional arguments after --, not both')
    }
    parsed.rawArgs = positionalArgs
  }

  if (
    parsed.requestFile !== undefined ||
    parsed.roleWaveFile !== undefined ||
    parsed.roleWaveStatus !== undefined ||
    parsed.roleWaveCleanup !== undefined ||
    parsed.roleMergeFile !== undefined
  ) {
    const modes = [
      parsed.requestFile !== undefined,
      parsed.roleWaveFile !== undefined,
      parsed.roleWaveStatus !== undefined,
      parsed.roleWaveCleanup !== undefined,
      parsed.roleMergeFile !== undefined,
    ].filter(Boolean).length
    if (modes !== 1) {
      throw new RunnerUsageError(
        'Use only one request, role-wave, status, or merge mode',
      )
    }
    const requestFlag =
      parsed.roleWaveFile !== undefined
        ? '--role-wave-file'
        : parsed.roleWaveStatus !== undefined
          ? '--role-wave-status'
          : parsed.roleWaveCleanup !== undefined
            ? '--role-wave-cleanup'
          : parsed.roleMergeFile !== undefined
            ? '--role-merge-file'
            : '--request-file'
    for (const flag of [
      '--skill',
      '--model',
      '--args',
      '--session',
      '--prompt',
    ]) {
      if (seenSingleValueFlags.has(flag)) {
        throw new RunnerUsageError(
          `${requestFlag} cannot be combined with ${flag}`,
        )
      }
    }
    if (positionalArgs !== undefined) {
      throw new RunnerUsageError(
        `${requestFlag} cannot be combined with positional arguments`,
      )
    }
    if (parsed.plainPromptStdin) {
      throw new RunnerUsageError(
        `${requestFlag} cannot be combined with ${PLAIN_PROMPT_STDIN_FLAG}`,
      )
    }
    if (parsed.requestFile !== undefined) {
      parsed.requestFile = requireNonEmpty(
        parsed.requestFile,
        'request file',
      )
    } else if (parsed.roleWaveFile !== undefined) {
      parsed.roleWaveFile = requireNonEmpty(
        parsed.roleWaveFile,
        'role wave file',
      )
    } else if (parsed.roleWaveStatus !== undefined) {
      parsed.roleWaveStatus = requireSafeWaveId(
        parsed.roleWaveStatus,
        'role wave status run',
      )
    } else if (parsed.roleWaveCleanup !== undefined) {
      parsed.roleWaveCleanup = requireSafeWaveId(
        parsed.roleWaveCleanup,
        'role wave cleanup run',
      )
    } else {
      parsed.roleMergeFile = requireNonEmpty(
        parsed.roleMergeFile,
        'role merge file',
      )
    }
  } else if (parsed.plainPromptStdin) {
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

export function loadRoleRequest(parsed, cwd) {
  if (parsed.requestFile === undefined) return parsed
  const requestPath = path.resolve(cwd, parsed.requestFile)
  const expectedPath = path.resolve(cwd, ROLE_REQUEST_RELATIVE_PATH)
  if (requestPath !== expectedPath) {
    throw new RunnerUsageError(
      `Role request must use ${ROLE_REQUEST_RELATIVE_PATH}`,
    )
  }
  assertManagedPathParents(cwd, requestPath, 'role request')

  let metadata
  try {
    metadata = lstatSync(requestPath)
  } catch (error) {
    throw new RunnerUsageError(
      `Cannot inspect role request ${requestPath}: ${errorMessage(error)}`,
    )
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RunnerUsageError(
      `Role request must be a regular non-symlink file: ${requestPath}`,
    )
  }
  if (metadata.size > MAX_ROLE_REQUEST_BYTES) {
    unlinkSync(requestPath)
    throw new RunnerUsageError(
      `Role request exceeds ${MAX_ROLE_REQUEST_BYTES} bytes`,
    )
  }

  let source
  try {
    source = readFileSync(requestPath, 'utf8')
  } finally {
    // The fixed request is one-shot. Removing it before spawn prevents stale
    // context from being reused by a later role invocation.
    unlinkSync(requestPath)
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_ROLE_REQUEST_BYTES) {
    throw new RunnerUsageError(
      `Role request exceeds ${MAX_ROLE_REQUEST_BYTES} bytes`,
    )
  }

  let request
  try {
    request = JSON.parse(source)
  } catch (error) {
    throw new RunnerUsageError(
      `Invalid role request JSON: ${errorMessage(error)}`,
    )
  }
  if (!isRecord(request)) {
    throw new RunnerUsageError('Role request must be a JSON object')
  }
  const keys = Object.keys(request).sort()
  if (
    keys.length !== 3 ||
    keys[0] !== 'args' ||
    keys[1] !== 'model' ||
    keys[2] !== 'skill'
  ) {
    throw new RunnerUsageError(
      'Role request must contain exactly skill, model, and args',
    )
  }
  if (typeof request.args !== 'string') {
    throw new RunnerUsageError('Role request args must be a string')
  }
  assertNoNul(request.args, 'role request args')

  return {
    ...parsed,
    skill: requireSafeSkillId(request.skill),
    model: requireSafeModelId(request.model),
    rawArgs: request.args.trim(),
    requestFile: undefined,
  }
}

export function loadRoleWave(parsed, cwd) {
  if (parsed.roleWaveFile === undefined) return undefined
  const requestPath = path.resolve(cwd, parsed.roleWaveFile)
  const expectedPath = path.resolve(cwd, ROLE_WAVE_RELATIVE_PATH)
  if (requestPath !== expectedPath) {
    throw new RunnerUsageError(
      `Role wave must use ${ROLE_WAVE_RELATIVE_PATH}`,
    )
  }
  assertManagedPathParents(cwd, requestPath, 'role wave')

  let metadata
  try {
    metadata = lstatSync(requestPath)
  } catch (error) {
    throw new RunnerUsageError(
      `Cannot inspect role wave ${requestPath}: ${errorMessage(error)}`,
    )
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RunnerUsageError(
      `Role wave must be a regular non-symlink file: ${requestPath}`,
    )
  }
  if (metadata.size > MAX_ROLE_REQUEST_BYTES) {
    unlinkSync(requestPath)
    throw new RunnerUsageError(
      `Role wave exceeds ${MAX_ROLE_REQUEST_BYTES} bytes`,
    )
  }

  let source
  try {
    source = readFileSync(requestPath, 'utf8')
  } finally {
    // A whole wave is one-shot. Deleting before any worktree or process is
    // created prevents stale context and removes the parallel WriteFile race.
    unlinkSync(requestPath)
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_ROLE_REQUEST_BYTES) {
    throw new RunnerUsageError(
      `Role wave exceeds ${MAX_ROLE_REQUEST_BYTES} bytes`,
    )
  }

  let request
  try {
    request = JSON.parse(source)
  } catch (error) {
    throw new RunnerUsageError(
      `Invalid role wave JSON: ${errorMessage(error)}`,
    )
  }
  if (!isRecord(request)) {
    throw new RunnerUsageError('Role wave must be a JSON object')
  }
  const requestKeys = Object.keys(request).sort()
  if (
    requestKeys.length !== 2 ||
    requestKeys[0] !== 'roles' ||
    requestKeys[1] !== 'run'
  ) {
    throw new RunnerUsageError(
      'Role wave must contain exactly run and roles',
    )
  }
  const run = requireSafeWaveId(request.run, 'run')
  if (
    !Array.isArray(request.roles) ||
    request.roles.length === 0 ||
    request.roles.length > MAX_ROLE_WAVE_SIZE
  ) {
    throw new RunnerUsageError(
      `Role wave roles must contain 1-${MAX_ROLE_WAVE_SIZE} entries`,
    )
  }

  const seenKeys = new Set()
  const seenWorktrees = new Set()
  const roles = request.roles.map((value, index) => {
    if (!isRecord(value)) {
      throw new RunnerUsageError(
        `Role wave entry ${index} must be a JSON object`,
      )
    }
    const keys = Object.keys(value).sort()
    if (
      keys.length !== 6 ||
      keys[0] !== 'args' ||
      keys[1] !== 'key' ||
      keys[2] !== 'model' ||
      keys[3] !== 'profile' ||
      keys[4] !== 'skill' ||
      keys[5] !== 'workspace'
    ) {
      throw new RunnerUsageError(
        `Role wave entry ${index} must contain exactly ` +
          'key, skill, model, profile, args, and workspace',
      )
    }
    const key = requireSafeWaveId(value.key, `role key ${index}`)
    if (seenKeys.has(key)) {
      throw new RunnerUsageError(`Duplicate role wave key: ${key}`)
    }
    seenKeys.add(key)
    if (typeof value.args !== 'string') {
      throw new RunnerUsageError(`Role wave entry ${key} args must be a string`)
    }
    assertNoNul(value.args, `role wave entry ${key} args`)
    if (typeof value.workspace !== 'string') {
      throw new RunnerUsageError(
        `Role wave entry ${key} workspace must be a string`,
      )
    }
    let workspace = value.workspace
    if (workspace !== 'current') {
      if (!workspace.startsWith('worktree:')) {
        throw new RunnerUsageError(
          `Role wave entry ${key} workspace must be current or worktree:<id>`,
        )
      }
      const worktreeId = requireSafeWaveId(
        workspace.slice('worktree:'.length),
        `worktree id for ${key}`,
      )
      workspace = `worktree:${worktreeId}`
      if (seenWorktrees.has(workspace)) {
        throw new RunnerUsageError(
          `Concurrent roles cannot share workspace ${workspace}`,
        )
      }
      seenWorktrees.add(workspace)
    }
    return {
      key,
      skill: requireSafeSkillId(value.skill),
      model: requireSafeModelId(value.model),
      profile:
        value.profile === 'inherit'
          ? 'inherit'
          : requireSafeWaveId(value.profile, `profile for ${key}`),
      rawArgs: value.args.trim(),
      workspace,
    }
  })

  return {
    run,
    roles,
    additionalDirs: parsed.additionalDirs,
  }
}

export function loadRoleMerge(parsed, cwd) {
  if (parsed.roleMergeFile === undefined) return undefined
  const requestPath = path.resolve(cwd, parsed.roleMergeFile)
  const expectedPath = path.resolve(cwd, ROLE_MERGE_RELATIVE_PATH)
  if (requestPath !== expectedPath) {
    throw new RunnerUsageError(
      `Role merge must use ${ROLE_MERGE_RELATIVE_PATH}`,
    )
  }
  assertManagedPathParents(cwd, requestPath, 'role merge')
  let metadata
  try {
    metadata = lstatSync(requestPath)
  } catch (error) {
    throw new RunnerUsageError(
      `Cannot inspect role merge ${requestPath}: ${errorMessage(error)}`,
    )
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_ROLE_REQUEST_BYTES
  ) {
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      unlinkSync(requestPath)
    }
    throw new RunnerUsageError(
      `Role merge must be a regular file at most ${MAX_ROLE_REQUEST_BYTES} bytes`,
    )
  }
  let source
  try {
    source = readFileSync(requestPath, 'utf8')
  } finally {
    unlinkSync(requestPath)
  }
  let request
  try {
    request = JSON.parse(source)
  } catch (error) {
    throw new RunnerUsageError(
      `Invalid role merge JSON: ${errorMessage(error)}`,
    )
  }
  if (
    !isRecord(request) ||
    Object.keys(request).sort().join(',') !== 'actions,run'
  ) {
    throw new RunnerUsageError(
      'Role merge must contain exactly run and actions',
    )
  }
  const run = requireSafeWaveId(request.run, 'role merge run')
  if (
    !Array.isArray(request.actions) ||
    request.actions.length === 0 ||
    request.actions.length > 4_096
  ) {
    throw new RunnerUsageError(
      'Role merge actions must contain 1-4096 entries',
    )
  }
  const targets = new Set()
  const actions = request.actions.map((value, index) => {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(',') !==
        'operation,path,worktree'
    ) {
      throw new RunnerUsageError(
        `Role merge action ${index} must contain exactly ` +
          'worktree, path, and operation',
      )
    }
    const worktree = requireSafeWaveId(
      value.worktree,
      `role merge worktree ${index}`,
    )
    const relativePath = requireSafeRelativePath(
      value.path,
      `role merge path ${index}`,
    )
    if (value.operation !== 'copy' && value.operation !== 'delete') {
      throw new RunnerUsageError(
        `Role merge action ${index} operation must be copy or delete`,
      )
    }
    if (targets.has(relativePath)) {
      throw new RunnerUsageError(
        `Role merge contains duplicate target path: ${relativePath}`,
      )
    }
    targets.add(relativePath)
    return {
      worktree,
      path: relativePath,
      operation: value.operation,
    }
  })
  return { run, actions }
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
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
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

export function materializeRoleWaveWorkspaces(wave, options = {}) {
  const initialCwd = realpathSync(options.cwd ?? process.cwd())
  const git = options.spawnSync ?? spawnSync
  const gitBinary = options.gitBinary ?? 'git'
  const tempRoot = ensureManagedTempRoot(options.tempRoot ?? os.tmpdir())
  const providerRoot = realpathSync(options.providerRoot)
  const runGit = (cwd, args, input, extraEnv = {}) => {
    const result = git(gitBinary, ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      input,
      maxBuffer: 256 * 1024 * 1024,
      shell: false,
    })
    if (result.error || result.status !== 0) {
      const detail =
        errorMessage(result.error ?? '').trim() ||
        String(result.stderr ?? '').trim() ||
        `exit ${String(result.status)}`
      throw new RunnerUsageError(
        `git ${args.join(' ')} failed in ${cwd}: ${detail}`,
      )
    }
    return String(result.stdout ?? '')
  }

  const baseRepo = realpathSync(
    runGit(initialCwd, ['rev-parse', '--show-toplevel']).trim(),
  )
  const manifestPath = path.join(
    baseRepo,
    ROLE_WORKTREE_MANIFEST_DIR,
    `${wave.run}.json`,
  )
  ensureRealDirectoryTree(baseRepo, path.dirname(manifestPath))
  const existingManifest = readRoleWaveManifest(manifestPath)
  const head = requireGitOid(
    runGit(baseRepo, ['rev-parse', 'HEAD']).trim(),
    'repository HEAD',
  )
  if (
    existingManifest &&
    (
      existingManifest.run !== wave.run ||
      realpathSync(existingManifest.baseRepo) !== baseRepo
    )
  ) {
    throw new RunnerUsageError(
      `Role wave manifest does not belong to ${wave.run} in ${baseRepo}`,
    )
  }
  const worktrees = { ...(existingManifest?.worktrees ?? {}) }
  const repoKey = createHash('sha256')
    .update(baseRepo)
    .digest('hex')
    .slice(0, 16)
  const needsWorktrees = wave.roles.some(
    (role) => role.workspace !== 'current',
  )
  let baseCommit = existingManifest?.baseCommit ?? null
  let sourceHead = existingManifest?.sourceHead ?? null
  let createdBaseline = false
  if (baseCommit !== null) {
    baseCommit = requireGitOid(baseCommit, 'role wave base commit')
    runGit(baseRepo, ['cat-file', '-e', `${baseCommit}^{commit}`])
  } else if (needsWorktrees) {
    sourceHead = head
    baseCommit = createSyntheticBaselineCommit({
      baseRepo,
      head,
      repoKey,
      run: wave.run,
      tempRoot,
      runGit,
    })
    createdBaseline = true
  }
  const worktreeRoot = path.join(
    tempRoot,
    'specrails-kimi-worktrees',
    repoKey,
    wave.run,
  )
  const executionRoot = path.join(
    tempRoot,
    'specrails-kimi-execution',
    repoKey,
    wave.run,
  )
  ensureRealDirectoryTree(tempRoot, worktreeRoot)
  ensureRealDirectoryTree(tempRoot, executionRoot)
  const gitExcludeDirectory = path.join(
    tempRoot,
    'specrails-kimi-git-excludes',
    repoKey,
  )
  ensureRealDirectoryTree(tempRoot, gitExcludeDirectory)
  const gitExcludeFile = writeRoleGitExclude(
    path.join(gitExcludeDirectory, `${wave.run}.txt`),
  )

  const listed = parseGitWorktreeList(
    runGit(baseRepo, ['worktree', 'list', '--porcelain', '-z']),
  )
  if (existingManifest) {
    validateRoleWaveManifestIntegrity(existingManifest, {
      baseRepo,
      run: wave.run,
      tempRoot,
      repoKey,
      registered: listed,
      runGit: (args) => runGit(baseRepo, args),
    })
  }
  const createdThisCall = []
  try {
    const roles = wave.roles.map((role) => {
      if (role.profile !== 'inherit') {
        const profilePath = path.join(
          baseRepo,
          '.specrails',
          'profiles',
          `${role.profile}.json`,
        )
        assertWorkspaceParentSafety(baseRepo, profilePath)
        let profileMetadata
        try {
          profileMetadata = lstatSync(profilePath)
        } catch (error) {
          throw new RunnerUsageError(
            `Cannot read role profile ${role.profile}: ${errorMessage(error)}`,
          )
        }
        if (!profileMetadata.isFile() || profileMetadata.isSymbolicLink()) {
          throw new RunnerUsageError(
            `Role profile must be a regular non-symlink file: ${profilePath}`,
          )
        }
      }
      if (role.workspace === 'current') {
        const executionCwd = path.join(executionRoot, role.key)
        ensureExecutionWorkspace(
          executionCwd,
          providerRoot,
          {
            run: wave.run,
            roleKey: role.key,
            repoDir: baseRepo,
          },
          options.platform ?? process.platform,
        )
        return {
          ...role,
          cwd: executionCwd,
          repoDir: baseRepo,
          gitExcludeFile,
        }
      }
      const worktreeId = role.workspace.slice('worktree:'.length)
      const target = path.join(worktreeRoot, worktreeId)
      const recorded = worktrees[worktreeId]
      if (recorded !== undefined && path.resolve(recorded) !== target) {
        throw new RunnerUsageError(
          `Role worktree mapping changed for ${worktreeId}`,
        )
      }
      const registeredTarget = existsSync(target)
        ? realpathSync(target)
        : path.resolve(target)
      if (!listed.has(registeredTarget)) {
        if (existsSync(target)) {
          throw new RunnerUsageError(
            `Unregistered path blocks role worktree ${worktreeId}: ${target}`,
          )
        }
        mkdirSync(path.dirname(target), { recursive: true })
        runGit(baseRepo, [
          'worktree',
          'add',
          '--detach',
          target,
          requireGitOid(baseCommit, 'role wave base commit'),
        ])
        createdThisCall.push(target)
      }
      ensureProviderOverlay(
        providerRoot,
        target,
        options.platform ?? process.platform,
      )
      worktrees[worktreeId] = target
      return {
        ...role,
        cwd: target,
        repoDir: target,
        gitExcludeFile,
      }
    })

    writeRoleWaveManifest(manifestPath, {
      schemaVersion: 1,
      run: wave.run,
      baseRepo,
      baseCommit,
      sourceHead,
      worktrees,
      roles: {
        ...(existingManifest?.roles ?? {}),
        ...Object.fromEntries(
          roles.map((role) => [
            role.key,
            {
              executionCwd: role.cwd,
              repoDir: role.repoDir,
              workspace: role.workspace,
              gitExcludeFile: role.gitExcludeFile ?? null,
            },
          ]),
        ),
      },
    })
    return {
      run: wave.run,
      roles,
      baseRepo,
      baseCommit,
      manifestPath,
    }
  } catch (error) {
    for (const target of createdThisCall.reverse()) {
      try {
        runGit(baseRepo, ['worktree', 'remove', '--force', target])
      } catch {
        rmSync(target, { recursive: true, force: true })
      }
    }
    if (createdBaseline) {
      try {
        runGit(
          baseRepo,
          ['update-ref', '-d', `refs/specrails/kimi/${repoKey}/${wave.run}`],
        )
      } catch {
        // Preserve the original setup error. A stale private ref is harmless
        // and can be pruned by a later successful cleanup.
      }
    }
    throw error
  }
}

function parseGitWorktreeList(source) {
  const paths = new Set()
  for (const field of source.split('\0')) {
    if (field.startsWith('worktree ')) {
      const candidate = field.slice('worktree '.length)
      paths.add(
        existsSync(candidate)
          ? realpathSync(candidate)
          : path.resolve(candidate),
      )
    }
  }
  return paths
}

function createSyntheticBaselineCommit({
  baseRepo,
  head,
  repoKey,
  run,
  tempRoot,
  runGit,
}) {
  mkdirSync(tempRoot, { recursive: true })
  const indexDirectory = path.join(
    tempRoot,
    'specrails-kimi-indexes',
    repoKey,
  )
  ensureRealDirectoryTree(tempRoot, indexDirectory)
  const indexPath = path.join(indexDirectory, `${run}.index`)
  if (existsSync(indexPath)) {
    const metadata = lstatSync(indexPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new RunnerUsageError(
        `Invalid synthetic baseline index: ${indexPath}`,
      )
    }
    unlinkSync(indexPath)
  }
  const indexEnv = { GIT_INDEX_FILE: indexPath }
  try {
    runGit(baseRepo, ['read-tree', head], undefined, indexEnv)
    runGit(
      baseRepo,
      [
        'add',
        '-A',
        '--',
        '.',
        ':(exclude).kimi-code',
        ':(exclude).kimi-code/**',
        `:(exclude)${ROLE_WAVE_RELATIVE_PATH.split(path.sep).join('/')}`,
        `:(exclude)${ROLE_REQUEST_RELATIVE_PATH.split(path.sep).join('/')}`,
        `:(exclude)${ROLE_MERGE_RELATIVE_PATH.split(path.sep).join('/')}`,
        `:(exclude)${ROLE_WORKTREE_MANIFEST_DIR.split(path.sep).join('/')}/**`,
      ],
      undefined,
      indexEnv,
    )
    const tree = requireGitOid(
      runGit(baseRepo, ['write-tree'], undefined, indexEnv).trim(),
      'synthetic baseline tree',
    )
    const identityEnv = {
      ...indexEnv,
      GIT_AUTHOR_NAME: 'SpecRails Kimi',
      GIT_AUTHOR_EMAIL: 'kimi-baseline@specrails.local',
      GIT_COMMITTER_NAME: 'SpecRails Kimi',
      GIT_COMMITTER_EMAIL: 'kimi-baseline@specrails.local',
    }
    const commit = requireGitOid(
      runGit(
        baseRepo,
        ['commit-tree', tree, '-p', head],
        `SpecRails Kimi baseline ${run}\n`,
        identityEnv,
      ).trim(),
      'synthetic baseline commit',
    )
    runGit(
      baseRepo,
      ['update-ref', `refs/specrails/kimi/${repoKey}/${run}`, commit],
    )
    return commit
  } finally {
    rmSync(indexPath, { force: true })
  }
}

function writeRoleGitExclude(file) {
  const contents = roleGitExcludeContents()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (existsSync(file)) {
    const metadata = lstatSync(file)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      readFileSync(file, 'utf8') !== contents
    ) {
      throw new RunnerUsageError(`Invalid role git exclude file: ${file}`)
    }
    return file
  }
  writeFileSync(file, contents, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  return file
}

function roleGitExcludeContents() {
  return [
    '/.kimi-code',
    '/.kimi-code/',
    '/.specrails/kimi-role-wave.json',
    '/.specrails/kimi-role-request.json',
    '/.specrails/kimi-role-merge.json',
    '/.specrails/kimi-role-worktrees/',
    '',
  ].join('\n')
}

function safeWorkspacePath(root, relative) {
  if (path.isAbsolute(relative) || relative.includes('\0')) {
    throw new RunnerUsageError(`Unsafe git workspace path: ${relative}`)
  }
  const resolved = path.resolve(root, relative)
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (!resolved.startsWith(prefix)) {
    throw new RunnerUsageError(`Git workspace path escapes its root: ${relative}`)
  }
  return resolved
}

function isManagedRolePath(relative) {
  return (
    relative === '.kimi-code' ||
    relative.startsWith('.kimi-code/') ||
    relative === '.specrails/kimi-role-wave.json' ||
    relative === '.specrails/kimi-role-request.json' ||
    relative === '.specrails/kimi-role-merge.json' ||
    relative.startsWith('.specrails/kimi-role-worktrees/')
  )
}

function assertManagedPathParents(root, file, label) {
  const absoluteRoot = path.resolve(root)
  const parent = path.dirname(path.resolve(file))
  const relative = path.relative(absoluteRoot, parent)
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new RunnerUsageError(`${label} escapes its working directory`)
  }
  let cursor = absoluteRoot
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component)
    let metadata
    try {
      metadata = lstatSync(cursor)
    } catch (error) {
      throw new RunnerUsageError(
        `Cannot inspect ${label} parent ${cursor}: ${errorMessage(error)}`,
      )
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RunnerUsageError(
        `${label} parent must be a real directory: ${cursor}`,
      )
    }
  }
}

function ensureRealDirectoryTree(root, directory) {
  const lexicalRoot = path.resolve(root)
  const absoluteRoot = realpathSync(lexicalRoot)
  const lexicalTarget = path.resolve(directory)
  const relative = path.relative(lexicalRoot, lexicalTarget)
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new RunnerUsageError(
      `Managed directory escapes its root: ${directory}`,
    )
  }
  let cursor = absoluteRoot
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component)
    if (!existsSync(cursor)) {
      mkdirSync(cursor, { mode: 0o700 })
      continue
    }
    const metadata = lstatSync(cursor)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RunnerUsageError(
        `Managed directory component must not be a symlink: ${cursor}`,
      )
    }
  }
}

function ensureManagedTempRoot(candidate) {
  const absolute = path.resolve(candidate)
  if (existsSync(absolute)) {
    const metadata = lstatSync(absolute)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RunnerUsageError(
        `Managed temp root must be a real directory: ${absolute}`,
      )
    }
    return realpathSync(absolute)
  }
  const parent = path.dirname(absolute)
  const realParent = realpathSync(parent)
  ensureRealDirectoryTree(realParent, path.join(realParent, path.basename(absolute)))
  return realpathSync(path.join(realParent, path.basename(absolute)))
}

export function ensureProviderOverlay(
  providerRoot,
  workspace,
  platform,
  dependencies = {},
) {
  const createLink = dependencies.symlink ?? symlinkSync
  const copyTree = dependencies.copyTree ?? cpSync
  const removeTree = dependencies.removeTree ?? rmSync
  const expectedRoot = realpathSync(providerRoot)
  const contentSha256 = hashManagedDirectoryTree(expectedRoot)
  const markerValue = {
    schemaVersion: 2,
    providerRoot: expectedRoot,
    runnerSha256: createHash('sha256')
      .update(readFileSync(path.join(expectedRoot, 'specrails', 'run-skill.mjs')))
      .digest('hex'),
    contentSha256,
  }
  const destination = path.join(workspace, '.kimi-code')
  if (existsSync(destination)) {
    const destinationMetadata = lstatSync(destination)
    if (destinationMetadata.isSymbolicLink()) {
      if (realpathSync(destination) !== expectedRoot) {
        throw new RunnerUsageError(
          `Worktree provider link does not target the managed provider: ${destination}`,
        )
      }
      return
    }
    if (!destinationMetadata.isDirectory()) {
      throw new RunnerUsageError(
        `Worktree provider path is not a directory: ${destination}`,
      )
    }
    const markerPath = path.join(
      destination,
      '.specrails-managed-overlay.json',
    )
    if (!existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink()) {
      throw new RunnerUsageError(
        `Refusing unverified worktree provider directory: ${destination}`,
      )
    }
    let marker
    try {
      marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    } catch (error) {
      throw new RunnerUsageError(
        `Cannot verify worktree provider overlay: ${errorMessage(error)}`,
      )
    }
    const isOwnedMarker =
      isRecord(marker) &&
      (marker.schemaVersion === 1 || marker.schemaVersion === 2) &&
      marker.providerRoot === expectedRoot &&
      typeof marker.runnerSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(marker.runnerSha256) &&
      (
        marker.schemaVersion === 1 ||
        (
          typeof marker.contentSha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(marker.contentSha256)
        )
      )
    if (!isOwnedMarker) {
      throw new RunnerUsageError(
        `Worktree provider overlay does not match the managed provider: ${destination}`,
      )
    }
    const actualContentSha256 = hashManagedDirectoryTree(destination, {
      ignoredRelativePath: '.specrails-managed-overlay.json',
    })
    if (
      JSON.stringify(marker) === JSON.stringify(markerValue) &&
      actualContentSha256 === contentSha256
    ) {
      return
    }
    // A valid ownership marker lets us repair stale/corrupt copied overlays.
    // Unmarked directories remain user-owned and are never removed.
    removeTree(destination, { recursive: true, force: true })
  }
  try {
    createLink(
      expectedRoot,
      destination,
      platform === 'win32' ? 'junction' : 'dir',
    )
  } catch {
    removeTree(destination, { recursive: true, force: true })
    copyTree(providerRoot, destination, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
    })
    const copiedContentSha256 = hashManagedDirectoryTree(destination)
    if (copiedContentSha256 !== contentSha256) {
      removeTree(destination, { recursive: true, force: true })
      throw new RunnerUsageError(
        `Copied worktree provider overlay failed content verification: ${destination}`,
      )
    }
    writeFileSync(
      path.join(destination, '.specrails-managed-overlay.json'),
      `${JSON.stringify(markerValue)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
  }
}

function hashManagedDirectoryTree(
  root,
  options = { ignoredRelativePath: undefined },
) {
  const hash = createHash('sha256')
  const walk = (directory, prefix) => {
    const names = readdirSync(directory).sort()
    for (const name of names) {
      const relative = prefix === '' ? name : `${prefix}/${name}`
      if (relative === options.ignoredRelativePath) continue
      const entry = path.join(directory, name)
      const metadata = lstatSync(entry)
      if (metadata.isSymbolicLink()) {
        throw new RunnerUsageError(
          `Managed provider tree must not contain symlinks: ${entry}`,
        )
      }
      if (metadata.isDirectory()) {
        hash.update(`D\0${relative}\0`)
        walk(entry, relative)
      } else if (metadata.isFile()) {
        hash.update(`F\0${relative}\0${metadata.mode & 0o111}\0`)
        hash.update(readFileSync(entry))
        hash.update('\0')
      } else {
        throw new RunnerUsageError(
          `Managed provider tree has unsupported entry: ${entry}`,
        )
      }
    }
  }
  walk(root, '')
  return hash.digest('hex')
}

function ensureExecutionWorkspace(
  executionCwd,
  providerRoot,
  identity,
  platform,
) {
  mkdirSync(executionCwd, { recursive: true, mode: 0o700 })
  const metadata = lstatSync(executionCwd)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RunnerUsageError(
      `Role execution workspace must be a real directory: ${executionCwd}`,
    )
  }
  const marker = path.join(executionCwd, '.specrails-role-workspace.json')
  if (existsSync(marker)) {
    const markerMetadata = lstatSync(marker)
    if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
      throw new RunnerUsageError(
        `Invalid role execution workspace marker: ${marker}`,
      )
    }
    let existing
    try {
      existing = JSON.parse(readFileSync(marker, 'utf8'))
    } catch (error) {
      throw new RunnerUsageError(
        `Cannot parse role execution workspace marker: ${errorMessage(error)}`,
      )
    }
    if (JSON.stringify(existing) !== JSON.stringify(identity)) {
      throw new RunnerUsageError(
        `Role execution workspace belongs to another run: ${executionCwd}`,
      )
    }
  } else {
    writeFileSync(marker, `${JSON.stringify(identity)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  }
  ensureProviderOverlay(providerRoot, executionCwd, platform)
}

function readRoleWaveManifest(manifestPath) {
  if (!existsSync(manifestPath)) return undefined
  const metadata = lstatSync(manifestPath)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_ROLE_REQUEST_BYTES
  ) {
    throw new RunnerUsageError(
      `Invalid role wave manifest: ${manifestPath}`,
    )
  }
  let value
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new RunnerUsageError(
      `Cannot parse role wave manifest ${manifestPath}: ${errorMessage(error)}`,
    )
  }
  if (!isRecord(value)) {
    throw new RunnerUsageError(`Invalid role wave manifest: ${manifestPath}`)
  }
  const keys = Object.keys(value).sort()
  if (
    keys.join(',') !==
      'baseCommit,baseRepo,roles,run,schemaVersion,sourceHead,worktrees' ||
    value.schemaVersion !== 1 ||
    typeof value.baseRepo !== 'string' ||
    !(
      value.baseCommit === null ||
      (
        typeof value.baseCommit === 'string' &&
        SAFE_GIT_OID.test(value.baseCommit)
      )
    ) ||
    !(
      value.sourceHead === null ||
      (
        typeof value.sourceHead === 'string' &&
        SAFE_GIT_OID.test(value.sourceHead)
      )
    ) ||
    !SAFE_WAVE_ID.test(value.run) ||
    !isRecord(value.worktrees) ||
    !isRecord(value.roles)
  ) {
    throw new RunnerUsageError(`Invalid role wave manifest: ${manifestPath}`)
  }
  const worktrees = {}
  for (const [key, target] of Object.entries(value.worktrees)) {
    requireSafeWaveId(key, 'manifest worktree id')
    if (typeof target !== 'string' || !path.isAbsolute(target)) {
      throw new RunnerUsageError(`Invalid role wave manifest: ${manifestPath}`)
    }
    worktrees[key] = target
  }
  const roles = {}
  for (const [key, role] of Object.entries(value.roles)) {
    requireSafeWaveId(key, 'manifest role key')
    if (
      !isRecord(role) ||
      Object.keys(role).sort().join(',') !==
        'executionCwd,gitExcludeFile,repoDir,workspace' ||
      typeof role.executionCwd !== 'string' ||
      !path.isAbsolute(role.executionCwd) ||
      typeof role.repoDir !== 'string' ||
      !path.isAbsolute(role.repoDir) ||
      !(
        role.gitExcludeFile === null ||
        (
          typeof role.gitExcludeFile === 'string' &&
          path.isAbsolute(role.gitExcludeFile)
        )
      ) ||
      typeof role.workspace !== 'string'
    ) {
      throw new RunnerUsageError(`Invalid role wave manifest: ${manifestPath}`)
    }
    roles[key] = role
  }
  return { ...value, worktrees, roles }
}

function writeRoleWaveManifest(manifestPath, value) {
  const directory = path.dirname(manifestPath)
  ensureRealDirectoryTree(value.baseRepo, directory)
  const metadata = lstatSync(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RunnerUsageError(
      `Role worktree manifest directory must not be a symlink: ${directory}`,
    )
  }
  if (existsSync(manifestPath) && lstatSync(manifestPath).isSymbolicLink()) {
    throw new RunnerUsageError(
      `Role wave manifest must not be a symlink: ${manifestPath}`,
    )
  }
  const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    renameSync(temporary, manifestPath)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function inspectRoleWaveStatus(run, dependencies = {}) {
  const state = resolveRoleWaveState(run, dependencies)
  const worktrees = {}
  for (const [worktree, repoDir] of Object.entries(state.manifest.worktrees)) {
    const changes = new Map()
    const tracked = runRoleGit(
      repoDir,
      [
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        state.manifest.baseCommit,
        '--',
      ],
      dependencies,
    ).split('\0')
    for (let index = 0; index + 1 < tracked.length; index += 2) {
      const rawStatus = tracked[index]
      const relative = tracked[index + 1]
      if (!rawStatus || !relative || isManagedRolePath(relative)) continue
      const status =
        rawStatus.startsWith('A')
          ? 'A'
          : rawStatus.startsWith('D')
            ? 'D'
            : 'M'
      changes.set(relative, { status, path: relative })
    }
    const untracked = runRoleGit(
      repoDir,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      dependencies,
    ).split('\0')
    for (const relative of untracked) {
      if (
        relative === '' ||
        isManagedRolePath(relative) ||
        changes.has(relative)
      ) {
        continue
      }
      changes.set(relative, { status: 'A', path: relative })
    }
    worktrees[worktree] = {
      repoDir,
      changes: Array.from(changes.values()).sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    }
  }
  return {
    run,
    baseRepo: state.baseRepo,
    baseCommit: state.manifest.baseCommit,
    manifestPath: state.manifestPath,
    worktrees,
  }
}

export function applyRoleMerge(merge, dependencies = {}) {
  const state = resolveRoleWaveState(merge.run, dependencies)
  const prepared = merge.actions.map((action) => {
    const workspace = state.manifest.worktrees[action.worktree]
    if (workspace === undefined) {
      throw new RunnerUsageError(
        `Unknown role merge worktree: ${action.worktree}`,
      )
    }
    const source = safeWorkspacePath(workspace, action.path)
    const target = safeWorkspacePath(state.baseRepo, action.path)
    if (action.operation === 'copy') {
      let metadata
      try {
        metadata = lstatSync(source)
      } catch (error) {
        throw new RunnerUsageError(
          `Cannot copy missing role output ${action.path}: ${errorMessage(error)}`,
        )
      }
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        throw new RunnerUsageError(
          `Role merge copy source must be a file or symlink: ${action.path}`,
        )
      }
      assertWorkspaceParentSafety(state.baseRepo, target)
      return { ...action, source, target, metadata }
    }
    if (existsSync(source)) {
      throw new RunnerUsageError(
        `Role merge deletion source still exists: ${action.path}`,
      )
    }
    assertWorkspaceParentSafety(state.baseRepo, target)
    return { ...action, source, target }
  })

  for (const action of prepared) {
    ensureWorkspaceParentDirectories(state.baseRepo, action.target)
    if (action.operation === 'delete') {
      if (existsSync(action.target) || lstatExists(action.target)) {
        const metadata = lstatSync(action.target)
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          throw new RunnerUsageError(
            `Role merge refuses to delete directory path: ${action.path}`,
          )
        }
        unlinkSync(action.target)
      }
      continue
    }
    const existing = lstatExists(action.target)
      ? lstatSync(action.target)
      : undefined
    if (existing?.isDirectory() && !existing.isSymbolicLink()) {
      throw new RunnerUsageError(
        `Role merge refuses to replace directory path: ${action.path}`,
      )
    }
    if (action.metadata.isSymbolicLink()) {
      if (existing) unlinkSync(action.target)
      symlinkSync(readlinkSync(action.source), action.target)
      continue
    }
    const temporary = path.join(
      path.dirname(action.target),
      `.${path.basename(action.target)}.specrails-${process.pid}.tmp`,
    )
    try {
      copyFileSync(action.source, temporary)
      chmodSync(temporary, action.metadata.mode & 0o777)
      if (existing) unlinkSync(action.target)
      renameSync(temporary, action.target)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  return {
    run: merge.run,
    baseRepo: state.baseRepo,
    applied: prepared.length,
  }
}

export function cleanupRoleWave(run, dependencies = {}) {
  const state = resolveRoleWaveState(run, dependencies, {
    requireIsolated: false,
  })
  const repoKey = state.repoKey
  const failures = []
  for (const [worktree, target] of Object.entries(state.manifest.worktrees)) {
    try {
      runRoleGit(
        state.baseRepo,
        ['worktree', 'remove', '--force', target],
        dependencies,
      )
    } catch (error) {
      failures.push(`${worktree}: ${errorMessage(error)}`)
    }
  }
  if (failures.length > 0) {
    throw new RunnerUsageError(
      `Role wave cleanup failed; manifest retained: ${failures.join('; ')}`,
    )
  }
  if (state.manifest.baseCommit !== null) {
    runRoleGit(
      state.baseRepo,
      ['update-ref', '-d', `refs/specrails/kimi/${repoKey}/${run}`],
      dependencies,
    )
  }
  unlinkSync(state.manifestPath)

  const tempRoot = state.tempRoot
  for (const directory of [
    path.join(
      tempRoot,
      'specrails-kimi-worktrees',
      repoKey,
      run,
    ),
    path.join(
      tempRoot,
      'specrails-kimi-execution',
      repoKey,
      run,
    ),
  ]) {
    rmSync(directory, { recursive: true, force: true })
  }
  rmSync(
    path.join(
      tempRoot,
      'specrails-kimi-git-excludes',
      repoKey,
      `${run}.txt`,
    ),
    { force: true },
  )
  runRoleGit(state.baseRepo, ['worktree', 'prune'], dependencies)
  return {
    run,
    baseRepo: state.baseRepo,
    removedWorktrees: Object.keys(state.manifest.worktrees).length,
    manifestPath: state.manifestPath,
  }
}

function resolveRoleWaveState(
  run,
  dependencies,
  options = { requireIsolated: true },
) {
  const sourceEnv = dependencies.env ?? process.env
  const cwd =
    nonEmptyString(sourceEnv.SPECRAILS_REPO_DIR) ??
    dependencies.cwd ??
    process.cwd()
  const baseRepo = realpathSync(
    runRoleGit(cwd, ['rev-parse', '--show-toplevel'], dependencies).trim(),
  )
  const manifestPath = path.join(
    baseRepo,
    ROLE_WORKTREE_MANIFEST_DIR,
    `${requireSafeWaveId(run, 'role wave run')}.json`,
  )
  assertManagedPathParents(baseRepo, manifestPath, 'role wave manifest')
  const manifest = readRoleWaveManifest(manifestPath)
  if (
    manifest === undefined ||
    manifest.run !== run ||
    realpathSync(manifest.baseRepo) !== baseRepo ||
    (options.requireIsolated && manifest.baseCommit === null)
  ) {
    throw new RunnerUsageError(
      `No isolated role wave state exists for ${run}`,
    )
  }
  if (manifest.baseCommit !== null) {
    const baseCommit = requireGitOid(
      manifest.baseCommit,
      'role wave base commit',
    )
    runRoleGit(
      baseRepo,
      ['cat-file', '-e', `${baseCommit}^{commit}`],
      dependencies,
    )
  } else if (Object.keys(manifest.worktrees).length > 0) {
    throw new RunnerUsageError(
      `Role wave ${run} has worktrees without an isolated base commit`,
    )
  }
  const registered = parseGitWorktreeList(
    runRoleGit(
      baseRepo,
      ['worktree', 'list', '--porcelain', '-z'],
      dependencies,
    ),
  )
  const tempRoot = ensureManagedTempRoot(
    dependencies.tempRoot ?? os.tmpdir(),
  )
  const repoKey = createHash('sha256')
    .update(baseRepo)
    .digest('hex')
    .slice(0, 16)
  validateRoleWaveManifestIntegrity(manifest, {
    baseRepo,
    run,
    tempRoot,
    repoKey,
    registered,
    runGit: (args) => runRoleGit(baseRepo, args, dependencies),
  })
  return { baseRepo, manifestPath, manifest, tempRoot, repoKey }
}

function validateRoleWaveManifestIntegrity(manifest, context) {
  if (
    manifest.run !== context.run ||
    path.resolve(manifest.baseRepo) !== context.baseRepo
  ) {
    throw new RunnerUsageError(
      `Role wave manifest identity mismatch for ${context.run}`,
    )
  }
  const worktreeRoot = path.join(
    context.tempRoot,
    'specrails-kimi-worktrees',
    context.repoKey,
    context.run,
  )
  const executionRoot = path.join(
    context.tempRoot,
    'specrails-kimi-execution',
    context.repoKey,
    context.run,
  )
  const expectedGitExclude = path.join(
    context.tempRoot,
    'specrails-kimi-git-excludes',
    context.repoKey,
    `${context.run}.txt`,
  )
  let excludeValidated = false
  const validateExclude = (actual) => {
    if (path.resolve(actual) !== expectedGitExclude) {
      throw new RunnerUsageError(
        `Role wave manifest has an unexpected git exclude path`,
      )
    }
    if (!excludeValidated) {
      let metadata
      try {
        metadata = lstatSync(expectedGitExclude)
      } catch (error) {
        throw new RunnerUsageError(
          `Cannot verify role git exclude file: ${errorMessage(error)}`,
        )
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        readFileSync(expectedGitExclude, 'utf8') !== roleGitExcludeContents()
      ) {
        throw new RunnerUsageError(
          `Invalid role git exclude file: ${expectedGitExclude}`,
        )
      }
      excludeValidated = true
    }
  }

  for (const [worktree, target] of Object.entries(manifest.worktrees)) {
    requireSafeWaveId(worktree, 'manifest worktree id')
    const expected = path.join(worktreeRoot, worktree)
    if (path.resolve(target) !== expected) {
      throw new RunnerUsageError(
        `Role wave manifest worktree path mismatch: ${worktree}`,
      )
    }
    if (
      !existsSync(expected) ||
      realpathSync(expected) !== expected ||
      !context.registered.has(expected)
    ) {
      throw new RunnerUsageError(
        `Role wave worktree is not the expected registered path: ${worktree}`,
      )
    }
  }

  for (const [roleKey, role] of Object.entries(manifest.roles)) {
    requireSafeWaveId(roleKey, 'manifest role key')
    validateExclude(role.gitExcludeFile)
    if (role.workspace === 'current') {
      if (
        path.resolve(role.executionCwd) !==
          path.join(executionRoot, roleKey) ||
        path.resolve(role.repoDir) !== context.baseRepo
      ) {
        throw new RunnerUsageError(
          `Role wave manifest current workspace mismatch: ${roleKey}`,
        )
      }
      continue
    }
    if (!role.workspace.startsWith('worktree:')) {
      throw new RunnerUsageError(
        `Role wave manifest has invalid workspace: ${roleKey}`,
      )
    }
    const worktree = requireSafeWaveId(
      role.workspace.slice('worktree:'.length),
      'manifest role worktree id',
    )
    const expected = manifest.worktrees[worktree]
    if (
      expected === undefined ||
      path.resolve(role.executionCwd) !== expected ||
      path.resolve(role.repoDir) !== expected
    ) {
      throw new RunnerUsageError(
        `Role wave manifest isolated workspace mismatch: ${roleKey}`,
      )
    }
  }

  if (manifest.baseCommit !== null) {
    const baseCommit = requireGitOid(
      manifest.baseCommit,
      'role wave base commit',
    )
    const ref = `refs/specrails/kimi/${context.repoKey}/${context.run}`
    const refCommit = requireGitOid(
      context.runGit(['rev-parse', '--verify', ref]).trim(),
      'role wave private ref',
    )
    if (refCommit !== baseCommit) {
      throw new RunnerUsageError(
        `Role wave private ref does not match its baseline: ${context.run}`,
      )
    }
  }
}

function runRoleGit(cwd, args, dependencies = {}, input) {
  const command = dependencies.gitBinary ?? 'git'
  const execute = dependencies.spawnSync ?? spawnSync
  const result = execute(command, ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(dependencies.env ?? {}) },
    input,
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
  })
  if (result.error || result.status !== 0) {
    const detail =
      errorMessage(result.error ?? '').trim() ||
      String(result.stderr ?? '').trim() ||
      `exit ${String(result.status)}`
    throw new RunnerUsageError(
      `git ${args.join(' ')} failed in ${cwd}: ${detail}`,
    )
  }
  return String(result.stdout ?? '')
}

function lstatExists(file) {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

function assertWorkspaceParentSafety(root, file) {
  let cursor = realpathSync(root)
  const relative = path.relative(path.resolve(root), path.dirname(file))
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component)
    if (!existsSync(cursor) && !lstatExists(cursor)) break
    const metadata = lstatSync(cursor)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RunnerUsageError(
        `Role merge target parent must not be a symlink: ${cursor}`,
      )
    }
  }
}

function ensureWorkspaceParentDirectories(root, file) {
  const parent = path.dirname(file)
  const relative = path.relative(path.resolve(root), parent)
  let cursor = realpathSync(root)
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component)
    if (!existsSync(cursor) && !lstatExists(cursor)) {
      mkdirSync(cursor)
      continue
    }
    const metadata = lstatSync(cursor)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RunnerUsageError(
        `Role merge target parent must not be a symlink: ${cursor}`,
      )
    }
  }
}

export async function runSkillCli(argv, dependencies = {}) {
  const cwd = dependencies.cwd ?? process.cwd()
  const parsedArgs = parseRunnerArgs(argv)
  const scriptPath = dependencies.scriptPath ?? process.argv[1]
  const providerRoot = resolveProviderRoot(scriptPath)
  const writeOutput =
    dependencies.writeOutput ??
    ((line) => {
      process.stdout.write(line)
    })
  if (parsedArgs.roleWaveStatus !== undefined) {
    emitRoleFrame(
      writeOutput,
      {
        type: 'specrails.merge.inventory',
        ...inspectRoleWaveStatus(parsedArgs.roleWaveStatus, {
          ...dependencies,
          cwd,
        }),
      },
    )
    return 0
  }
  if (parsedArgs.roleWaveCleanup !== undefined) {
    emitRoleFrame(
      writeOutput,
      {
        type: 'specrails.role.cleanup',
        ...cleanupRoleWave(parsedArgs.roleWaveCleanup, {
          ...dependencies,
          cwd,
        }),
      },
    )
    return 0
  }
  if (parsedArgs.roleMergeFile !== undefined) {
    const merge = loadRoleMerge(parsedArgs, cwd)
    emitRoleFrame(
      writeOutput,
      {
        type: 'specrails.merge.applied',
        ...applyRoleMerge(merge, {
          ...dependencies,
          cwd,
        }),
      },
    )
    return 0
  }
  if (parsedArgs.roleWaveFile !== undefined) {
    const wave = loadRoleWave(parsedArgs, cwd)
    return runRoleWave(wave, {
      ...dependencies,
      cwd,
      providerRoot,
    })
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
  const parsed = loadRoleRequest(parsedArgs, cwd)
  return runPreparedSkill(parsed, {
    ...dependencies,
    cwd,
    providerRoot,
  })
}

async function runRoleWave(wave, dependencies) {
  const sourceEnv = dependencies.env ?? process.env
  const repositoryCwd =
    nonEmptyString(sourceEnv.SPECRAILS_REPO_DIR) ?? dependencies.cwd
  const inheritedProfile = nonEmptyString(
    sourceEnv.SPECRAILS_PROFILE_PATH,
  )
  const materialized = materializeRoleWaveWorkspaces(wave, {
    cwd: repositoryCwd,
    providerRoot: dependencies.providerRoot,
    platform: dependencies.platform,
    spawnSync: dependencies.spawnSync,
    gitBinary: dependencies.gitBinary,
    tempRoot: dependencies.tempRoot,
  })
  const writeOutput =
    dependencies.writeOutput ??
    ((line) => {
      process.stdout.write(line)
    })
  const children = new Set()
  const aggregateChild = {
    kill(signal) {
      for (const child of children) child.kill?.(signal)
    },
  }
  const removeSignalForwarding = forwardTerminationSignals(
    aggregateChild,
    dependencies.signalSource ?? process,
  )

  try {
    const results = await Promise.all(
      materialized.roles.map(async (role) => {
        emitRoleFrame(writeOutput, {
          type: 'specrails.role.workspace',
          run: materialized.run,
          roleKey: role.key,
          workspace: role.workspace,
          executionCwd: role.cwd,
          repoDir: role.repoDir,
          baseCommit: materialized.baseCommit,
          manifestPath: materialized.manifestPath,
        })
        try {
          const code = await runPreparedSkill(
            {
              skill: role.skill,
              model: role.model,
              rawArgs: role.rawArgs,
              sessionId: undefined,
              additionalDirs: Array.from(
                new Set([
                  ...wave.additionalDirs,
                  materialized.baseRepo,
                ]),
              ),
              attachmentPaths: [],
              extraPrompt: undefined,
            },
            {
              ...dependencies,
              cwd: role.cwd,
              providerRoot: dependencies.providerRoot,
              env: {
                ...sourceEnv,
                SPECRAILS_REPO_DIR: role.repoDir,
                SPECRAILS_MERGE_TARGET: materialized.baseRepo,
                SPECRAILS_KIMI_WORKTREE_MANIFEST:
                  materialized.manifestPath,
                ...(role.profile === 'inherit'
                  ? inheritedProfile === undefined
                    ? {}
                    : {
                        SPECRAILS_PROFILE_PATH: path.isAbsolute(
                          inheritedProfile,
                        )
                          ? inheritedProfile
                          : path.resolve(
                              materialized.baseRepo,
                              inheritedProfile,
                            ),
                      }
                  : {
                      SPECRAILS_PROFILE_PATH: path.join(
                        materialized.baseRepo,
                        '.specrails',
                        'profiles',
                        `${role.profile}.json`,
                      ),
                    }),
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'core.excludesFile',
                GIT_CONFIG_VALUE_0: role.gitExcludeFile,
              },
              captureRoleKey: role.key,
              writeOutput,
              childRegistry: children,
              forwardSignals: false,
            },
          )
          emitRoleFrame(writeOutput, {
            type: 'specrails.role.completed',
            run: materialized.run,
            roleKey: role.key,
            status: code === 0 ? 'succeeded' : 'failed',
            exitCode: code,
          })
          return code
        } catch (error) {
          emitRoleFrame(writeOutput, {
            type: 'specrails.role.completed',
            run: materialized.run,
            roleKey: role.key,
            status: 'failed',
            exitCode: 1,
            error: errorMessage(error),
          })
          return 1
        }
      }),
    )
    return results.find((code) => code !== 0) ?? 0
  } finally {
    removeSignalForwarding()
  }
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
  let child
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
    child = spawnChild(launch.command, launch.args, {
      cwd: dependencies.cwd,
      env,
      shell: false,
      stdio:
        dependencies.captureRoleKey === undefined
          ? launch.stdinText === undefined
            ? 'inherit'
            : ['pipe', 'inherit', 'inherit']
          : launch.stdinText === undefined
            ? ['ignore', 'pipe', 'pipe']
            : ['pipe', 'pipe', 'pipe'],
    })
    dependencies.childRegistry?.add(child)
    const completion = waitForChild(child)
    const outputCompletion =
      dependencies.captureRoleKey === undefined
        ? Promise.resolve()
        : captureRoleOutput(
            child,
            dependencies.captureRoleKey,
            dependencies.writeOutput,
          )
    removeSignalForwarding =
      dependencies.forwardSignals === false
        ? () => {}
        : forwardTerminationSignals(
            child,
            dependencies.signalSource ?? process,
        )
    if (launch.stdinText === undefined) {
      const [code] = await Promise.all([completion, outputCompletion])
      return code
    }
    try {
      const [code] = await Promise.all([
        completion,
        writePromptToChild(child, launch.stdinText),
        outputCompletion,
      ])
      return code
    } catch (error) {
      child.kill?.('SIGTERM')
      throw error
    }
  } finally {
    if (child !== undefined) dependencies.childRegistry?.delete(child)
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

function captureRoleOutput(child, roleKey, writeOutput) {
  const streams = [
    ['stdout', child.stdout],
    ['stderr', child.stderr],
  ].filter(([, stream]) => stream?.on)
  if (streams.length === 0) return Promise.resolve()
  return Promise.all(
    streams.map(([streamName, stream]) =>
      new Promise((resolve) => {
        const decoder = new StringDecoder('utf8')
        let pending = ''
        let finished = false
        const emitLines = (final) => {
          const parts = pending.split('\n')
          pending = final ? '' : (parts.pop() ?? '')
          for (const line of parts) {
            emitCapturedRoleLine(
              writeOutput,
              roleKey,
              streamName,
              line.replace(/\r$/, ''),
            )
          }
          if (final && pending !== '') {
            emitCapturedRoleLine(
              writeOutput,
              roleKey,
              streamName,
              pending.replace(/\r$/, ''),
            )
            pending = ''
          }
        }
        const finish = () => {
          if (finished) return
          finished = true
          pending += decoder.end()
          emitLines(true)
          resolve()
        }
        stream.on('data', (chunk) => {
          pending += decoder.write(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
          )
          emitLines(false)
        })
        stream.once('end', finish)
        stream.once('close', finish)
        stream.once('error', (error) => {
          emitRoleFrame(writeOutput, {
            type: 'specrails.role.output-error',
            roleKey,
            stream: streamName,
            error: errorMessage(error),
          })
          finish()
        })
      }),
    ),
  ).then(() => undefined)
}

function emitCapturedRoleLine(writeOutput, roleKey, stream, line) {
  if (line === '') return
  if (stream === 'stdout') {
    try {
      emitRoleFrame(writeOutput, {
        type: 'specrails.role.event',
        roleKey,
        event: JSON.parse(line),
      })
      return
    } catch {
      // Preserve non-JSON output as an attributed frame.
    }
  }
  emitRoleFrame(writeOutput, {
    type: 'specrails.role.output',
    roleKey,
    stream,
    data: line,
  })
}

function emitRoleFrame(writeOutput, value) {
  writeOutput(`${JSON.stringify({ role: 'meta', ...value })}\n`)
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

function requireSafeWaveId(value, label) {
  if (typeof value !== 'string' || !SAFE_WAVE_ID.test(value)) {
    throw new RunnerUsageError(
      `Invalid ${label}: expected 1-64 lowercase letters, digits, or hyphens`,
    )
  }
  return value
}

function requireGitOid(value, label) {
  if (typeof value !== 'string' || !SAFE_GIT_OID.test(value)) {
    throw new RunnerUsageError(
      `Invalid ${label}: expected a 40- or 64-character lowercase hex commit id`,
    )
  }
  return value
}

function requireSafeRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 4_096 ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    isManagedRolePath(value)
  ) {
    throw new RunnerUsageError(`Invalid ${label}`)
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
