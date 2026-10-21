// Contract versioning gate for integration-contract.json (see docs/release-policy.md).
//
// Compares the Desktop <-> Core contract between a PR base and head:
// - any content change must increase `schemaVersion`;
// - a breaking change (removed key, removed array member such as a
//   capability, node kind or event type, or a changed value type) must bump
//   the major version AND be declared with `!` or a `BREAKING CHANGE:` footer
//   in a commit message of the range (or the PR title, used for squash merges).
// Changed scalar values are reported for review: they need at least a minor
// bump, and the author decides whether they narrow semantics (then: major).
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { isMain } from './release-utils.mjs'

export const CONTRACT_FILE = 'integration-contract.json'

export function parseSchemaVersion(value) {
  const match = typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(value)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)
const isScalar = (value) => value === null || typeof value !== 'object'
// Objects inside arrays are matched by a stable identity key when they have one.
const identityKey = (items) => ['id', 'name', 'type', 'kind'].find((key) => items.every((item) => kindOf(item) === 'object' && typeof item[key] === 'string'))

/** Structural diff: { removed, typeChanged, valueChanged, added } as path lists. */
export function diffContract(base, head) {
  const result = { removed: [], typeChanged: [], valueChanged: [], added: [] }
  const walk = (a, b, path) => {
    const ka = kindOf(a)
    const kb = kindOf(b)
    if (ka !== kb) {
      // A value that was explicitly null may be refined; anything else is a type change.
      if (ka === 'null') result.valueChanged.push(path)
      else result.typeChanged.push(`${path} (${ka} -> ${kb})`)
      return
    }
    if (ka === 'object') {
      for (const key of Object.keys(a)) {
        if (!Object.hasOwn(b, key)) result.removed.push(`${path}.${key}`)
        else walk(a[key], b[key], `${path}.${key}`)
      }
      for (const key of Object.keys(b)) if (!Object.hasOwn(a, key)) result.added.push(`${path}.${key}`)
      return
    }
    if (ka === 'array') {
      if (a.every(isScalar) && b.every(isScalar)) {
        for (const item of a) if (!b.some((other) => isDeepStrictEqual(item, other))) result.removed.push(`${path}[${JSON.stringify(item)}]`)
        for (const item of b) if (!a.some((other) => isDeepStrictEqual(item, other))) result.added.push(`${path}[${JSON.stringify(item)}]`)
        return
      }
      const key = identityKey([...a, ...b])
      if (key) {
        for (const item of a) {
          const match = b.find((other) => other[key] === item[key])
          if (match) walk(item, match, `${path}[${key}=${item[key]}]`)
          else result.removed.push(`${path}[${key}=${item[key]}]`)
        }
        for (const item of b) if (!a.some((other) => other[key] === item[key])) result.added.push(`${path}[${key}=${item[key]}]`)
        return
      }
      a.forEach((item, index) => (index < b.length ? walk(item, b[index], `${path}[${index}]`) : result.removed.push(`${path}[${index}]`)))
      for (let index = a.length; index < b.length; index++) result.added.push(`${path}[${index}]`)
      return
    }
    if (!isDeepStrictEqual(a, b)) result.valueChanged.push(path)
  }
  walk(base, head, '$')
  return result
}

const BREAKING_HEADER = /^[a-z]+(?:\([^)\n]*\))?!:/im
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m
export function declaresBreakingChange(messages) {
  return messages.some((message) => typeof message === 'string' && (BREAKING_HEADER.test(message) || BREAKING_FOOTER.test(message)))
}

/**
 * Pure policy decision. `base`/`head` are parsed contracts (or null when the
 * file does not exist at that revision); `messages` are commit messages of the
 * PR range plus, optionally, the PR title.
 */
export function evaluateContractChange({ base, head, messages = [] }) {
  const errors = []
  const notes = []
  if (base == null && head == null) return { ok: true, changed: false, errors, notes: ['No integration contract at either revision.'], diff: null }
  if (head == null) return { ok: false, changed: true, errors: [`${CONTRACT_FILE} was deleted; Desktop cannot negotiate without it.`], notes, diff: null }
  const headVersion = parseSchemaVersion(head.schemaVersion)
  if (!headVersion) errors.push(`schemaVersion must be "MAJOR.MINOR" (got ${JSON.stringify(head.schemaVersion)}).`)
  if (base == null) {
    notes.push(`${CONTRACT_FILE} is new at ${head.schemaVersion}.`)
    return { ok: errors.length === 0, changed: true, errors, notes, diff: null }
  }
  if (isDeepStrictEqual(base, head)) return { ok: errors.length === 0, changed: false, errors, notes: ['Contract unchanged.'], diff: null }

  const baseVersion = parseSchemaVersion(base.schemaVersion)
  const diff = diffContract(base, head)
  for (const list of Object.values(diff)) {
    const index = list.indexOf('$.schemaVersion')
    if (index !== -1) list.splice(index, 1)
  }
  const breaking = [...diff.removed.map((p) => `removed ${p}`), ...diff.typeChanged.map((p) => `type changed ${p}`)]
  const bump = baseVersion && headVersion ? compareVersions(headVersion, baseVersion) : null
  const majorBumped = Boolean(baseVersion && headVersion && headVersion[0] > baseVersion[0])

  if (headVersion && baseVersion && bump <= 0) {
    errors.push(`${CONTRACT_FILE} changed but schemaVersion did not increase (${base.schemaVersion} -> ${head.schemaVersion}). Bump the minor for additive changes, the major for removals or semantic changes.`)
  }
  if (breaking.length) {
    if (!majorBumped) errors.push(`Breaking contract change requires a major schemaVersion bump (${base.schemaVersion} -> ${head.schemaVersion}):\n  - ${breaking.join('\n  - ')}`)
    if (!declaresBreakingChange(messages)) errors.push('Breaking contract change must be declared with `!` in a conventional commit header or a `BREAKING CHANGE:` footer (commit message or PR title).')
  }
  if (diff.valueChanged.length) notes.push(`Changed values (review whether they narrow semantics; if so, bump the major and declare BREAKING CHANGE):\n  - ${diff.valueChanged.join('\n  - ')}`)
  if (diff.added.length) notes.push(`Added: ${diff.added.length} path(s).`)
  return { ok: errors.length === 0, changed: true, breaking, errors, notes, diff }
}

const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
export function readContractAt(ref, file = CONTRACT_FILE) {
  const result = git(['show', `${ref}:${file}`])
  if (result.status !== 0) {
    if (/does not exist|exists on disk, but not in/.test(result.stderr)) return null
    throw new Error(`git show ${ref}:${file} failed: ${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout)
}
export function commitMessages(base, head) {
  const result = git(['log', '--format=%B%x00', `${base}..${head}`])
  if (result.status !== 0) throw new Error(`git log ${base}..${head} failed: ${result.stderr.trim()}`)
  return result.stdout.split('\0').map((message) => message.trim()).filter(Boolean)
}

function argValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

if (isMain(import.meta.url)) {
  try {
    const argv = process.argv.slice(2)
    const base = argValue(argv, '--base') ?? process.env.CONTRACT_BASE_REF
    const head = argValue(argv, '--head') ?? process.env.CONTRACT_HEAD_REF ?? 'HEAD'
    if (!base) throw new Error('Usage: node scripts/check-contract-bump.mjs --base <ref> [--head <ref>]')
    const messages = commitMessages(base, head)
    if (process.env.PR_TITLE) messages.push(process.env.PR_TITLE)
    const verdict = evaluateContractChange({ base: readContractAt(base), head: readContractAt(head), messages })
    for (const note of verdict.notes) console.log(note)
    if (verdict.ok) console.log(verdict.changed ? `Contract change follows the versioning policy (${base}..${head}).` : `No contract change in ${base}..${head}.`)
    else {
      for (const error of verdict.errors) console.error(process.env.GITHUB_ACTIONS ? `::error file=${CONTRACT_FILE}::${error.replace(/\n/g, '%0A')}` : `error: ${error}`)
      console.error('See docs/release-policy.md#contract-versioning.')
      process.exitCode = 1
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
