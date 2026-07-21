import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'

import { InstallerError } from '../util/errors.js'

export type KimiThinkingEffort = 'low' | 'high' | 'max'

export interface KimiInvocationInput {
  /** Raw profile model id. Official short aliases are normalized at launch. */
  model: string
  /** Plain prompt. Required when `skill` is omitted. */
  prompt?: string
  /** Safe direct-child skill directory id. Uses the managed runner when set. */
  skill?: string
  /** Raw skill argument string expanded with Kimi's native placeholder rules. */
  skillArguments?: string
  /** A session id emitted by a prior `session.resume_hint` event. */
  sessionId?: string
  thinkingEffort?: KimiThinkingEffort
  /** Additional source/worktree roots exposed to this independent process. */
  additionalDirs?: string[]
  /** Absolute paths only. Kimi prompt mode has no attachment argv flag. */
  attachmentPaths?: string[]
  /** Override for callers whose workspace exposes the managed runner elsewhere. */
  skillRunnerPath?: string
}

export interface KimiInvocation {
  bin: 'kimi' | 'node'
  args: string[]
  /** Process-environment overlay; no credentials are added or persisted. */
  env: Record<string, string | undefined>
  prompt: string
  /** Text piped to the managed runner; never placed in subprocess argv. */
  stdinText?: string
}

// This is both a Node argv path and a published wire-contract value. Forward
// slashes are accepted by Node on Windows and keep the contract byte-identical
// across hosts instead of leaking the build machine's path separator.
export const KIMI_SKILL_RUNNER_PATH =
  '.kimi-code/specrails/run-skill.mjs'

const OFFICIAL_SHORT_MODEL_IDS = new Set([
  'k3',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
])
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/
const MAX_MODEL_ID_LENGTH = 128
const MAX_SESSION_ID_LENGTH = 128

/**
 * Profiles retain raw provider ids. At the CLI boundary only the three managed
 * Kimi aliases gain their documented `kimi-code/` namespace; custom model ids
 * and already-qualified aliases remain byte-identical.
 */
export function normalizeKimiCliModel(model: string): string {
  const value = validateKimiModelId(model)
  return OFFICIAL_SHORT_MODEL_IDS.has(value) ? `kimi-code/${value}` : value
}

/**
 * Canonical daemon-free Kimi invocation consumed by Desktop and scripts.
 * Plain prompts cross stdin into Core's managed Node helper so they never
 * appear in the host-to-helper argv. The helper must pass the exact user turn
 * through Kimi 0.27's only non-interactive API, `-p <prompt>`: native Kimi
 * binaries therefore expose it in their own process argv, while supported npm
 * Windows shims receive it through the exact stdin bootstrap. Skills also
 * pre-render direct-child SKILL.md because prompt mode treats `/skill:...` as
 * literal user text.
 */
export function buildKimiInvocation(input: KimiInvocationInput): KimiInvocation {
  if (input.skill) return buildKimiSkillInvocation(input)

  const attachments = validateKimiAttachments(input.attachmentPaths ?? [])
  const prompt = buildPlainKimiPrompt(input, attachments)
  const model = normalizeKimiCliModel(input.model)
  const additionalDirs = Array.from(
    new Set([
      ...(input.additionalDirs ?? []).map((dir) =>
        canonicalizeAdditionalDirectory(
          requireNonEmpty(dir, 'additional directory'),
        ),
      ),
      ...attachments.map((attachment) => path.dirname(attachment)),
    ]),
  )
  const additionalDirArgs = additionalDirs.flatMap((dir) => [
    '--add-dir',
    dir,
  ])
  const args = [
    input.skillRunnerPath?.trim() || KIMI_SKILL_RUNNER_PATH,
    '--plain-prompt-stdin',
    '--model',
    model,
    ...(input.sessionId !== undefined
      ? [`--session=${validateKimiSessionId(input.sessionId)}`]
      : []),
    ...additionalDirArgs,
  ]
  const env: Record<string, string | undefined> = {
    KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
    KIMI_DISABLE_CRON: '1',
    KIMI_CODE_NO_AUTO_UPDATE: '1',
    KIMI_MODEL_THINKING_EFFORT: undefined,
  }
  // KIMI_MODEL_THINKING_EFFORT is documented for K3 only. Custom aliases and
  // other official models must not inherit an unsupported environment knob.
  if (input.thinkingEffort && model === 'kimi-code/k3') {
    env.KIMI_MODEL_THINKING_EFFORT = input.thinkingEffort
  }
  return { bin: 'node', args, env, prompt, stdinText: prompt }
}

function buildPlainKimiPrompt(
  input: KimiInvocationInput,
  attachments: string[],
): string {
  let prompt = requireNonEmpty(input.prompt, 'prompt')
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
  return prompt
}

function buildKimiSkillInvocation(input: KimiInvocationInput): KimiInvocation {
  const skill = input.skill!
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skill)) {
    throw new InstallerError(`invalid Kimi skill name: ${skill}`, 40)
  }
  const model = validateKimiModelId(input.model)
  const attachments = validateKimiAttachments(input.attachmentPaths ?? [])
  const additionalDirs = Array.from(
    new Set([
      ...(input.additionalDirs ?? []).map((dir) =>
        canonicalizeAdditionalDirectory(
          requireNonEmpty(dir, 'additional directory'),
        ),
      ),
      ...attachments.map((attachment) => path.dirname(attachment)),
    ]),
  )
  const args = [
    input.skillRunnerPath?.trim() || KIMI_SKILL_RUNNER_PATH,
    '--skill',
    skill,
    '--model',
    model,
    ...(input.skillArguments !== undefined
      ? ['--args', input.skillArguments]
      : []),
    ...(input.sessionId !== undefined
      ? [`--session=${validateKimiSessionId(input.sessionId)}`]
      : []),
    ...additionalDirs.flatMap((dir) => [
      '--add-dir',
      dir,
    ]),
    ...(input.prompt?.trim() ? ['--prompt', input.prompt.trim()] : []),
  ]

  for (const attachment of attachments) {
    args.push('--attachment', attachment)
  }

  const env: Record<string, string | undefined> = {
    KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
    KIMI_DISABLE_CRON: '1',
    KIMI_CODE_NO_AUTO_UPDATE: '1',
    KIMI_MODEL_THINKING_EFFORT: undefined,
  }
  if (
    input.thinkingEffort &&
    normalizeKimiCliModel(model) === 'kimi-code/k3'
  ) {
    env.KIMI_MODEL_THINKING_EFFORT = input.thinkingEffort
  }
  return {
    bin: 'node',
    args,
    env,
    prompt: input.prompt?.trim() ?? '',
  }
}

function validateKimiAttachments(attachments: string[]): string[] {
  return attachments.map((attachment) => {
    if (!path.isAbsolute(attachment)) {
      throw new InstallerError(
        `Kimi attachment paths must be absolute: ${attachment}`,
        40,
      )
    }
    try {
      const metadata = lstatSync(attachment)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('not a regular non-symlink file')
      }
      const canonical = realpathSync(attachment)
      accessSync(canonical, fsConstants.R_OK)
      return canonical
    } catch (error) {
      throw new InstallerError(
        `Kimi attachment must be a readable regular non-symlink file: ` +
          `${attachment} (${(error as Error).message})`,
        40,
      )
    }
  })
}

function canonicalizeAdditionalDirectory(directory: string): string {
  const absolute = path.resolve(directory)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function requireNonEmpty(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new InstallerError(`Kimi ${label} must not be empty`, 40)
  return normalized
}

function validateKimiModelId(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MODEL_ID_LENGTH ||
    !SAFE_MODEL_ID.test(value)
  ) {
    throw new InstallerError(
      'Kimi model id must be 1-128 characters and match ' +
        '[A-Za-z0-9][A-Za-z0-9._/:-]*',
      40,
    )
  }
  return value
}

function validateKimiSessionId(value: string | undefined): string {
  if (!isValidKimiSessionId(value)) {
    throw new InstallerError(
      'Kimi session id must be 1-128 characters matching ' +
        '[A-Za-z0-9._-]+, excluding "." and ".."',
      40,
    )
  }
  return value
}

function isValidKimiSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    SAFE_SESSION_ID.test(value) &&
    value !== '.' &&
    value !== '..'
  )
}

export type KimiStreamEvent =
  | { kind: 'empty' }
  | { kind: 'invalid'; raw: string }
  | { kind: 'assistant'; content: string; raw: Record<string, unknown> }
  | { kind: 'tool'; raw: Record<string, unknown> }
  | { kind: 'resume_hint'; sessionId: string; raw: Record<string, unknown> }
  | { kind: 'meta'; raw: Record<string, unknown> }
  | { kind: 'unknown'; raw: Record<string, unknown> }

/**
 * Tolerant JSONL parser for Kimi 0.27. Unknown and malformed lines are surfaced
 * to the caller rather than terminating the run. Kimi emits no structured USD
 * cost, so this parser intentionally exposes no fabricated cost field.
 */
export function parseKimiStreamLine(line: string): KimiStreamEvent {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'empty' }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return { kind: 'invalid', raw: line }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', raw: line }
  }
  const raw = value as Record<string, unknown>
  if (
    raw.role === 'meta' &&
    raw.type === 'session.resume_hint' &&
    isValidKimiSessionId(raw.session_id)
  ) {
    return { kind: 'resume_hint', sessionId: raw.session_id, raw }
  }
  if (raw.role === 'assistant') {
    return {
      kind: 'assistant',
      content: typeof raw.content === 'string' ? raw.content : '',
      raw,
    }
  }
  if (raw.role === 'tool') return { kind: 'tool', raw }
  if (raw.role === 'meta') return { kind: 'meta', raw }
  return { kind: 'unknown', raw }
}

/**
 * Returns a resumable id only when Kimi exited successfully and its final
 * non-empty JSONL record is a canonical `session.resume_hint`. Kimi may emit a
 * hint before assigning a non-zero process exit status (for example an
 * incomplete headless goal), so callers must supply the observed child exit
 * code rather than treating the record alone as proof of success.
 */
export function extractKimiSessionHint(
  lines: Iterable<string>,
  exitCode: number | null,
): string | null {
  if (exitCode !== 0) return null
  let terminalEvent: KimiStreamEvent = { kind: 'empty' }
  for (const line of lines) {
    const event = parseKimiStreamLine(line)
    if (event.kind !== 'empty') terminalEvent = event
  }
  return terminalEvent.kind === 'resume_hint'
    ? terminalEvent.sessionId
    : null
}
