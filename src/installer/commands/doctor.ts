import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { info, ok, fail as logFail, rawOut } from '../util/logger.js'
import { commandExists, runCommand } from '../util/exec.js'
import {
  isDir,
  isFile,
  listDir,
  mkdirp,
  readTextFile,
} from '../util/fs.js'
import { isGitRepo } from '../util/git.js'

import { buildManifest } from '../phases/manifest.js'
import {
  assertClaudeAuthenticated,
  assertKimiAuthenticated,
  isSupportedKimiVersion,
  kimiVersion,
  MIN_KIMI_VERSION,
} from '../phases/provider-detect.js'
import { derivedPaths, type Provider } from '../phases/provider-detect.js'
import { ProviderError } from '../util/errors.js'
import { resolveArtifacts } from '../util/registry.js'
import { KIMI_REQUIRED_OPENSPEC_SKILLS } from './init.js'

const CORE_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
)

/**
 * Every canonical SpecRails command is materialized as a direct-child Kimi
 * skill. Discover the list from the packaged source of truth so doctor cannot
 * silently fall behind when the command catalog grows.
 */
export const KIMI_MANAGED_WORKFLOW_SKILLS = listDir(
  path.join(CORE_PACKAGE_ROOT, 'templates', 'commands', 'specrails'),
)
  .filter(
    (entry) =>
      isFile(entry) &&
      path.extname(entry) === '.md' &&
      path.basename(entry) !== 'setup.md',
  )
  .map((entry) => `specrails-${path.basename(entry, '.md')}`)
  .sort()

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/

/**
 * `npx specrails-core doctor` — health check for a specrails install.
 * Ports bin/doctor.sh to Node with identical exit semantics:
 *   - exit 0 when every check passes
 *   - exit 1 when any check fails
 * Appends a single line to ~/.specrails/doctor.log after every run.
 */

export interface DoctorFlags {
  'root-dir'?: string | boolean
  provider?: string | boolean
}

export interface DoctorResult {
  passed: number
  failed: number
  results: Array<{ kind: 'pass' | 'fail'; message: string; fix?: string }>
}

export async function runDoctor(flags: DoctorFlags = {}): Promise<DoctorResult> {
  const projectRoot = path.resolve(
    typeof flags['root-dir'] === 'string' ? flags['root-dir'] : process.cwd(),
  )

  // Relocate-always: Specrails artifacts (provider dir, agent files, instructions
  // file) live under `artifactRoot`. Git stays in the repo (codeRoot). Readers
  // pass allocate:false → falls back to the in-repo legacy layout when there is
  // no registry entry (so a never-installed / legacy repo still reports cleanly).
  const { artifactRoot, codeRoot } = resolveArtifacts(projectRoot, {
    allocate: false,
    home: process.env.SPECRAILS_REGISTRY_HOME,
  })

  rawOut('\nspecrails doctor\n\n')

  const results: DoctorResult['results'] = []
  const addPass = (message: string): void => {
    results.push({ kind: 'pass', message })
  }
  const addFail = (message: string, fix: string): void => {
    results.push({ kind: 'fail', message, fix })
  }
  const provider = resolveDoctorProvider(artifactRoot, flags.provider)
  const { providerDir, instructionsFile } = derivedPaths(provider)

  // Check 1: selected provider CLI.
  const cli = provider === 'claude' ? 'claude' : provider
  const cliLabel =
    provider === 'claude'
      ? 'Claude Code'
      : provider === 'kimi'
        ? 'Kimi Code'
        : provider === 'gemini'
          ? 'Gemini'
          : 'Codex'
  const cliFound = await commandExists(cli)
  if (cliFound) {
    const path_ = await resolveCommandPath(cli)
    addPass(`${cliLabel} CLI: found${path_ ? ` (${path_})` : ''}`)
  } else {
    const installFix =
      provider === 'kimi'
        ? 'Install Kimi Code: https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html'
        : provider === 'claude'
          ? 'Install Claude Code: https://claude.ai/download'
          : `Install the ${cliLabel} CLI and retry`
    addFail(`${cliLabel} CLI: not found`, installFix)
  }

  // Check 2: provider version/authentication when a bounded probe exists.
  if (cliFound && provider === 'claude') {
    try {
      await assertClaudeAuthenticated({ skipPrereqs: false })
      addPass('Claude: authenticated')
    } catch {
      addFail(
        'Claude: not authenticated',
        'Option 1: claude config set api_key <your-key>  |  Option 2: claude auth login',
      )
    }
  } else if (cliFound && provider === 'kimi') {
    const version = await kimiVersion()
    if (isSupportedKimiVersion(version)) {
      addPass(`Kimi Code version: ${version}`)
    } else {
      addFail(
        `Kimi Code version: unsupported (${version})`,
        `Upgrade Kimi Code to ${MIN_KIMI_VERSION} or newer`,
      )
    }
    try {
      const auth = await assertKimiAuthenticated({ skipPrereqs: false })
      if (auth === 'authenticated') {
        addPass('Kimi: authentication evidence found')
      } else {
        // There is no non-billable readiness probe in 0.27. Unknown is healthy:
        // doctor must not spend quota merely to prove login.
        addPass('Kimi: authentication readiness unknown (non-billing check)')
      }
    } catch {
      addFail('Kimi: not authenticated', 'Run: kimi login')
    }
  }

  // Check 3: provider-native role artifacts.
  const agentsDir =
    provider === 'kimi'
      ? path.join(artifactRoot, providerDir, 'skills')
      : provider === 'codex'
        ? path.join(artifactRoot, providerDir, 'skills', 'rails')
      : path.join(artifactRoot, providerDir, 'agents')
  if (isDir(agentsDir)) {
    const agentFiles = findInstalledAgentFiles(agentsDir, provider)
    if (agentFiles.length >= 1) {
      const names = agentFiles
        .map((f) =>
          provider === 'kimi' || provider === 'codex'
            ? path.basename(path.dirname(f))
            : path.basename(f, path.extname(f)),
        )
        .join(', ')
      const relativeRoleDir =
        provider === 'kimi'
          ? `${providerDir}/skills`
          : provider === 'codex'
            ? `${providerDir}/skills/rails`
          : `${providerDir}/agents`
      const label = provider === 'kimi' ? 'Role skills' : 'Agent files'
      addPass(`${label}: ${agentFiles.length} agent(s) found in ${relativeRoleDir} (${names})`)
    } else {
      addFail(
        `${provider === 'kimi' ? 'Role skills' : 'Agent files'}: ` +
          `${path.relative(artifactRoot, agentsDir)} exists but no generated role artifacts were found`,
        'Run specrails-core init to set up agents',
      )
    }
  } else {
    addFail(
      `${provider === 'kimi' ? 'Role skills' : 'Agent files'}: ` +
        `${path.relative(artifactRoot, agentsDir)} directory not found`,
      'Run specrails-core init to set up agents',
    )
  }

  // Check 4: provider instructions file present
  if (isFile(path.join(artifactRoot, instructionsFile))) {
    addPass(`${instructionsFile}: present`)
  } else {
    addFail(
      `${instructionsFile}: missing`,
      provider !== 'claude'
        ? 'Run specrails-core init to regenerate the provider instructions.'
        : 'Run /specrails:enrich inside Claude Code to regenerate.',
    )
  }

  if (provider === 'kimi') {
    checkKimiArtifacts({ artifactRoot, codeRoot, addPass, addFail })
  }

  // Check 5: Git initialized (in the repo — codeRoot, not the artifact root).
  // `git rev-parse` supports normal repositories, linked worktrees (`.git` is a
  // file there), subdirectories and repository layouts that do not expose a
  // literal `.git/` directory.
  if (await isGitRepo(codeRoot)) {
    addPass('Git: initialized')
  } else {
    addFail('Git: not a git repository', 'Initialize with: git init')
  }

  // Check 6: npm present
  if (await commandExists('npm')) {
    try {
      const { stdout } = await runCommand('npm', ['--version'], { inherit: false })
      addPass(`npm: found (v${stdout.trim()})`)
    } catch {
      addPass('npm: found')
    }
  } else {
    addFail(
      'npm: not found',
      'Install npm: https://docs.npmjs.com/downloading-and-installing-node-js-and-npm',
    )
  }

  // Render results in order.
  for (const r of results) {
    if (r.kind === 'pass') ok(r.message)
    else logFail(`${r.message}\n   Fix: ${r.fix ?? ''}`)
  }

  const passed = results.filter((r) => r.kind === 'pass').length
  const failed = results.length - passed

  rawOut('\n')
  if (failed === 0) {
    info(
      `All ${passed + failed} checks passed. Run ${
        provider === 'kimi'
          ? '/skill:specrails-get-backlog-specs'
          : '/specrails:get-backlog-specs'
      } to get started.`,
    )
  } else {
    rawOut(`${failed} check(s) failed.\n`)
  }
  rawOut('\n')

  appendDoctorLog(passed, failed)

  return { passed, failed, results }
}

async function resolveCommandPath(cmd: string): Promise<string | null> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await runCommand(probe, [cmd], { inherit: false })
    const first = stdout.trim().split(/\r?\n/)[0]
    return first && first.length > 0 ? first : null
  } catch {
    return null
  }
}

function resolveDoctorProvider(
  projectRoot: string,
  explicit: string | boolean | undefined,
): Provider {
  if (
    explicit === 'claude' ||
    explicit === 'codex' ||
    explicit === 'gemini' ||
    explicit === 'kimi'
  ) {
    return explicit
  }
  if (explicit !== undefined) {
    throw new ProviderError(
      `--provider value must be 'claude', 'codex', 'gemini', or 'kimi', got: ${String(explicit)}`,
    )
  }

  const manifestPath = path.join(
    projectRoot,
    '.specrails',
    'specrails-manifest.json',
  )
  if (isFile(manifestPath)) {
    try {
      const manifest = JSON.parse(readTextFile(manifestPath)) as {
        primary_provider?: unknown
        providers?: unknown
      }
      if (isProvider(manifest.primary_provider)) return manifest.primary_provider
      if (Array.isArray(manifest.providers)) {
        const recorded = manifest.providers.filter(isProvider)
        if (recorded.length === 1) return recorded[0]
      }
    } catch {
      // The manifest itself is diagnosed later. Preserve legacy directory
      // fallback here so doctor still reports every actionable problem.
    }
  }

  // Preserve the established multi-tree fallback: Gemini and Codex predate
  // Claude-first resolution. Kimi slots ahead of Claude without changing
  // existing Gemini/Codex behavior.
  if (isDir(path.join(projectRoot, '.gemini'))) return 'gemini'
  if (isDir(path.join(projectRoot, '.codex'))) return 'codex'
  if (isDir(path.join(projectRoot, '.kimi-code'))) return 'kimi'
  if (isDir(path.join(projectRoot, '.claude'))) return 'claude'
  return 'claude'
}

function isProvider(value: unknown): value is Provider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'gemini' ||
    value === 'kimi'
  )
}

function findInstalledAgentFiles(root: string, provider: Provider): string[] {
  if (!isDir(root)) return []
  if (provider === 'kimi') {
    return listDir(root)
      .filter((entry) => {
        const id = path.basename(entry)
        return (
          isDir(entry) &&
          /^(?:sr|custom)-[a-z0-9-]+$/.test(id) &&
          isFile(path.join(entry, 'SKILL.md'))
        )
      })
      .map((entry) => path.join(entry, 'SKILL.md'))
      .sort()
  }
  if (provider === 'codex') {
    return listDir(root)
      .filter((entry) => isDir(entry) && isFile(path.join(entry, 'SKILL.md')))
      .map((entry) => path.join(entry, 'SKILL.md'))
      .sort()
  }
  const matcher = /^(custom-|sr-).+\.md$/
  return listDir(root)
    .filter((entry) => isFile(entry) && matcher.test(path.basename(entry)))
    .sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateStringRecord(value: unknown, field: string): string[] {
  if (!isRecord(value)) return [`${field} must be an object of string values`]
  return Object.entries(value)
    .filter(([, item]) => typeof item !== 'string')
    .map(([key]) => `${field}.${key} must be a string`)
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return [`${field} must be an array of strings`]
  }
  return []
}

function validateKimiMcpServer(name: string, value: unknown): string[] {
  const field = `mcpServers.${name}`
  if (!isRecord(value)) return [`${field} must be an object`]

  const errors: string[] = []
  let transport = value.transport
  if (transport === undefined) {
    if (typeof value.command === 'string') transport = 'stdio'
    else if (typeof value.url === 'string') transport = 'http'
  }

  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    return [`${field} must declare a command, a URL, or a supported transport`]
  }

  if (transport === 'stdio') {
    if (typeof value.command !== 'string' || value.command.length === 0) {
      errors.push(`${field}.command must be a non-empty string`)
    }
    if (value.args !== undefined) {
      errors.push(...validateStringArray(value.args, `${field}.args`))
    }
    if (value.env !== undefined) {
      errors.push(...validateStringRecord(value.env, `${field}.env`))
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') {
      errors.push(`${field}.cwd must be a string`)
    }
    if (
      value.executor !== undefined &&
      value.executor !== 'local' &&
      value.executor !== 'kaos'
    ) {
      errors.push(`${field}.executor must be "local" or "kaos"`)
    }
  } else {
    if (typeof value.url !== 'string') {
      errors.push(`${field}.url must be a valid URL`)
    } else {
      try {
        new URL(value.url)
      } catch {
        errors.push(`${field}.url must be a valid URL`)
      }
    }
    if (value.headers !== undefined) {
      errors.push(...validateStringRecord(value.headers, `${field}.headers`))
    }
    if (value.auth !== undefined && value.auth !== 'oauth') {
      errors.push(`${field}.auth must be "oauth"`)
    }
    if (
      value.bearerTokenEnvVar !== undefined &&
      (typeof value.bearerTokenEnvVar !== 'string' ||
        value.bearerTokenEnvVar.length === 0)
    ) {
      errors.push(`${field}.bearerTokenEnvVar must be a non-empty string`)
    }
  }

  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    errors.push(`${field}.enabled must be a boolean`)
  }
  for (const timeoutField of ['startupTimeoutMs', 'toolTimeoutMs'] as const) {
    const timeout = value[timeoutField]
    if (
      timeout !== undefined &&
      (typeof timeout !== 'number' ||
        !Number.isInteger(timeout) ||
        timeout < 1)
    ) {
      errors.push(`${field}.${timeoutField} must be a positive integer`)
    }
  }
  for (const toolsField of ['enabledTools', 'disabledTools'] as const) {
    if (value[toolsField] !== undefined) {
      errors.push(
        ...validateStringArray(value[toolsField], `${field}.${toolsField}`),
      )
    }
  }
  return errors
}

function inspectKimiMcpConfig(filePath: string): {
  errors: string[]
  serverCount: number
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(readTextFile(filePath))
  } catch {
    return { errors: ['file is not valid JSON'], serverCount: 0 }
  }
  if (!isRecord(parsed)) {
    return { errors: ['root must be a JSON object'], serverCount: 0 }
  }

  // Kimi defaults a missing mcpServers field to an empty object, so `{}` is a
  // valid upstream config. When present, every entry must match Kimi 0.27's
  // stdio/HTTP/SSE schema.
  const serversValue = parsed.mcpServers ?? {}
  if (!isRecord(serversValue)) {
    return {
      errors: ['mcpServers must be an object keyed by server name'],
      serverCount: 0,
    }
  }

  const errors = Object.entries(serversValue).flatMap(([name, value]) =>
    validateKimiMcpServer(name, value),
  )
  return { errors, serverCount: Object.keys(serversValue).length }
}

function summarizePaths(paths: string[]): string {
  const shown = paths.slice(0, 3).join(', ')
  return paths.length <= 3 ? shown : `${shown} (+${paths.length - 3} more)`
}

function readCorePackageVersion(): string | null {
  try {
    const parsed = JSON.parse(
      readTextFile(path.join(CORE_PACKAGE_ROOT, 'package.json')),
    ) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : null
  } catch {
    return null
  }
}

function inspectKimiManifest(
  artifactRoot: string,
  manifestPath: string,
): {
  errors: string[]
  version: string | null
  artifactCount: number
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(readTextFile(manifestPath))
  } catch {
    return { errors: ['file is not valid JSON'], version: null, artifactCount: 0 }
  }
  if (!isRecord(parsed)) {
    return {
      errors: ['root must be a JSON object'],
      version: null,
      artifactCount: 0,
    }
  }

  const errors: string[] = []
  const version =
    typeof parsed.version === 'string' && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : null
  if (!version) errors.push('version must be a non-empty string')

  const currentVersion = readCorePackageVersion()
  if (!currentVersion) {
    errors.push('running Core package version could not be read')
  } else if (version && version !== currentVersion) {
    errors.push(
      `version ${version} does not match running Core ${currentVersion}`,
    )
  }

  const markerPath = path.join(artifactRoot, '.specrails', 'specrails-version')
  if (!isFile(markerPath)) {
    errors.push('specrails-version marker is missing')
  } else if (version && readTextFile(markerPath).trim() !== version) {
    errors.push('specrails-version marker does not match manifest version')
  }

  if (
    typeof parsed.installed_at !== 'string' ||
    !Number.isFinite(Date.parse(parsed.installed_at))
  ) {
    errors.push('installed_at must be a valid timestamp')
  }

  const providers = Array.isArray(parsed.providers)
    ? parsed.providers.filter(isProvider)
    : []
  if (
    !Array.isArray(parsed.providers) ||
    providers.length !== parsed.providers.length ||
    providers.length === 0
  ) {
    errors.push('providers must be a non-empty array of supported providers')
  } else {
    if (new Set(providers).size !== providers.length) {
      errors.push('providers must not contain duplicates')
    }
    if (!providers.includes('kimi')) {
      errors.push('providers does not record kimi')
    }
  }

  if (!isProvider(parsed.primary_provider)) {
    errors.push('primary_provider must be a supported provider')
  } else if (!providers.includes(parsed.primary_provider)) {
    errors.push('primary_provider must also appear in providers')
  }

  if (!isRecord(parsed.artifacts) || Object.keys(parsed.artifacts).length === 0) {
    errors.push('artifacts must be a non-empty checksum object')
    return { errors, version, artifactCount: 0 }
  }

  const actualArtifacts = parsed.artifacts
  const malformedDigests = Object.entries(actualArtifacts)
    .filter(([, digest]) => typeof digest !== 'string' || !SHA256_DIGEST.test(digest))
    .map(([artifact]) => artifact)
  if (malformedDigests.length > 0) {
    errors.push(
      `artifacts contains invalid sha256 digests: ${summarizePaths(malformedDigests)}`,
    )
  }

  try {
    const expectedArtifacts = buildManifest({
      scriptDir: CORE_PACKAGE_ROOT,
      repoRoot: artifactRoot,
      version: currentVersion ?? version ?? 'unknown',
      installedAt: '1970-01-01T00:00:00Z',
    }).artifacts
    const actualKeys = Object.keys(actualArtifacts)
    const expectedKeys = Object.keys(expectedArtifacts)
    const missing = expectedKeys.filter((key) => !(key in actualArtifacts))
    const unexpected = actualKeys.filter((key) => !(key in expectedArtifacts))
    const changed = expectedKeys.filter(
      (key) =>
        key in actualArtifacts && actualArtifacts[key] !== expectedArtifacts[key],
    )
    if (missing.length > 0) {
      errors.push(`artifacts is missing: ${summarizePaths(missing)}`)
    }
    if (unexpected.length > 0) {
      errors.push(`artifacts has unknown entries: ${summarizePaths(unexpected)}`)
    }
    if (changed.length > 0) {
      errors.push(`artifacts checksum mismatch: ${summarizePaths(changed)}`)
    }
  } catch {
    errors.push('packaged Core artifact checksums could not be computed')
  }

  return {
    errors,
    version,
    artifactCount: Object.keys(actualArtifacts).length,
  }
}

function checkKimiArtifacts(args: {
  artifactRoot: string
  codeRoot: string
  addPass: (message: string) => void
  addFail: (message: string, fix: string) => void
}): void {
  const skillRoot = path.join(args.artifactRoot, '.kimi-code', 'skills')
  const legacyRoleRoot = path.join(skillRoot, 'rails')
  const staleNestedRoles = listDir(legacyRoleRoot).filter((entry) => isDir(entry))
  if (staleNestedRoles.length > 0) {
    args.addFail(
      `Kimi role skills: stale nested skills/rails layout contains ` +
        staleNestedRoles.map((entry) => path.basename(entry)).join(', '),
      'Run: npx specrails-core update --provider kimi; resolve any reported custom-role conflict manually',
    )
  } else {
    args.addPass('Kimi role layout: all roles are direct children of .kimi-code/skills')
  }
  const runnerRoot = path.join(args.artifactRoot, '.kimi-code', 'specrails')
  const requiredRunnerFiles = [
    'run-skill.mjs',
    path.join('vendor', 'js-yaml', 'js-yaml.mjs'),
    path.join('vendor', 'js-yaml', 'LICENSE'),
    path.join('vendor', 'js-yaml', 'NOTICE.md'),
  ]
  const missingRunnerFiles = requiredRunnerFiles.filter(
    (relative) => !isFile(path.join(runnerRoot, relative)),
  )
  const mismatchedRunnerFiles =
    missingRunnerFiles.length === 0
      ? requiredRunnerFiles.filter((relative) => {
          const installed = path.join(runnerRoot, relative)
          const packaged = path.join(
            CORE_PACKAGE_ROOT,
            'templates',
            'kimi',
            'specrails',
            relative,
          )
          try {
            return !readFileSync(installed).equals(readFileSync(packaged))
          } catch {
            return true
          }
        })
      : []
  if (
    missingRunnerFiles.length === 0 &&
    mismatchedRunnerFiles.length === 0
  ) {
    args.addPass(
      'Kimi headless skill runner: complete managed bundle integrity verified outside the skill scanner',
    )
  } else if (missingRunnerFiles.length > 0) {
    args.addFail(
      `Kimi headless skill runner: missing ${missingRunnerFiles.join(', ')} ` +
        'under .kimi-code/specrails',
      'Run: npx specrails-core update --provider kimi',
    )
  } else {
    args.addFail(
      `Kimi headless skill runner: managed content mismatch in ` +
        mismatchedRunnerFiles.join(', '),
      'Run: npx specrails-core update --provider kimi',
    )
  }
  const missingSpecrails = KIMI_MANAGED_WORKFLOW_SKILLS.filter(
    (name) => !isFile(path.join(skillRoot, name, 'SKILL.md')),
  )
  if (KIMI_MANAGED_WORKFLOW_SKILLS.length === 0) {
    args.addFail(
      'Kimi workflow skills: packaged managed catalog is unavailable',
      'Reinstall specrails-core, then run: npx specrails-core update --provider kimi',
    )
  } else if (missingSpecrails.length === 0) {
    args.addPass(
      `Kimi workflow skills: all ${KIMI_MANAGED_WORKFLOW_SKILLS.length} managed workflows present`,
    )
  } else {
    args.addFail(
      `Kimi workflow skills: missing ${missingSpecrails.join(', ')}`,
      'Run: npx specrails-core update --provider kimi',
    )
  }

  const missingOpenSpec = KIMI_REQUIRED_OPENSPEC_SKILLS.filter(
    (name) => !isFile(path.join(skillRoot, name, 'SKILL.md')),
  )
  if (missingOpenSpec.length === 0) {
    args.addPass(`Kimi OpenSpec skills: all ${KIMI_REQUIRED_OPENSPEC_SKILLS.length} present`)
  } else {
    args.addFail(
      `Kimi OpenSpec skills: missing ${missingOpenSpec.join(', ')}`,
      'Run: npx specrails-core update --provider kimi',
    )
  }

  const legacyRoot = path.join(args.codeRoot, '.kimi', 'skills')
  const staleLegacy = listDir(legacyRoot).filter(
    (entry) => isDir(entry) && path.basename(entry).startsWith('openspec-'),
  )
  if (staleLegacy.length > 0) {
    args.addFail(
      `Kimi OpenSpec skills: stale generated .kimi/skills output found`,
      'Run: npx specrails-core update --provider kimi',
    )
  } else {
    args.addPass('Kimi OpenSpec layout: no stale .kimi/skills output')
  }

  const mcpPath = path.join(args.artifactRoot, '.kimi-code', 'mcp.json')
  if (isFile(mcpPath)) {
    const mcp = inspectKimiMcpConfig(mcpPath)
    if (mcp.errors.length === 0) {
      args.addPass(
        `.kimi-code/mcp.json: valid (${mcp.serverCount} server(s))`,
      )
    } else {
      args.addFail(
        `.kimi-code/mcp.json: invalid (${mcp.errors.join('; ')})`,
        'Fix the JSON using `kimi` → `/mcp-config`, or restore a valid config and retry',
      )
    }
  } else {
    args.addFail(
      '.kimi-code/mcp.json: missing',
      'Run: npx specrails-core update --provider kimi',
    )
  }
  const manifestPath = path.join(args.artifactRoot, '.specrails', 'specrails-manifest.json')
  if (isFile(manifestPath)) {
    const manifest = inspectKimiManifest(args.artifactRoot, manifestPath)
    if (manifest.errors.length === 0) {
      args.addPass(
        `SpecRails manifest: valid for Core ${manifest.version} ` +
          `(${manifest.artifactCount} packaged source checksums verified; records kimi)`,
      )
    } else {
      args.addFail(
        `SpecRails manifest: invalid (${manifest.errors.join('; ')})`,
        'Run: npx specrails-core update --provider kimi',
      )
    }
  } else {
    args.addFail(
      'SpecRails manifest: missing',
      'Run: npx specrails-core update --provider kimi',
    )
  }
}

function appendDoctorLog(passed: number, failed: number): void {
  try {
    const logDir = path.join(homedir(), '.specrails')
    mkdirp(logDir)
    const logFile = path.join(logDir, 'doctor.log')
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const total = passed + failed
    appendFileSync(logFile, `${stamp}  checks=${total} passed=${passed} failed=${failed}\n`)
  } catch {
    // Best-effort logging — never fail doctor because we can't write the log.
  }
}
