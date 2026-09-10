import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordAcceptance, type AcceptanceReport, applyPreview, checkArchive, fingerprintCandidate, initializePipeline, inspectPipeline, pipelineStateDirectory, preparePreview, runPipelineCli, transitionPipeline, validatePipelineContext, verificationEnvironment, verificationInvocation, verifyPipeline, type PipelineContext, type VerificationRequest } from './pipeline-state.js'

let root: string
let context: PipelineContext
const change = 'shared-filter'
function write(file: string, text: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
function artifacts(): string {
  const dir = path.join(context.artifactRoot, 'openspec', 'changes', change)
  write(path.join(dir, 'proposal.md'), '# Requested feature')
  write(path.join(dir, 'design.md'), '# Shared contract')
  write(path.join(dir, 'tasks.md'), '- [ ] 1. Implement shared feature\n')
  write(path.join(dir, 'design-confidence.json'), JSON.stringify({ confidence: 'high' }))
  write(path.join(dir, 'specs', 'filter', 'spec.md'), '# Filter behavior')
  return dir
}
function accepted(): AcceptanceReport {
  return { criteria: context.specs.flatMap(spec => (spec.acceptanceCriteria?.length ? spec.acceptanceCriteria : [spec.description || spec.title]).map((requirement, criterionIndex) => ({ specId: String(spec.id), criterionIndex, requirement, status: 'met' as const, evidence: ['code.js: inspected behavior and executed regression'] }))), checks: [], findings: [] }
}
function score(overall = 95): void {
  recordAcceptance(context, accepted())
  write(path.join(context.artifactRoot, 'openspec', 'changes', change, 'confidence-score.json'), JSON.stringify({
    change, overall, aspects: { type_correctness: 95, pattern_adherence: 95, test_coverage: 95, security: 95, architectural_alignment: 95 },
  }))
}
function request(script = 'process.stdout.write("checked")'): VerificationRequest {
  return { kind: 'full', commands: context.repositories.map((repo) => ({ repositoryId: repo.id, command: process.execPath, args: ['-e', script] })) }
}
async function developed(): Promise<void> {
  initializePipeline(context, change)
  const dir = artifacts()
  transitionPipeline(context, 'architect', 'done')
  write(path.join(dir, 'tasks.md'), '- [x] 1. Implement shared feature\n')
  await verifyPipeline(context, request())
  transitionPipeline(context, 'developer', 'done')
}
// This fixture performs six real Git processes before each test. Windows CI
// can exceed Vitest's default 10s hook timeout under load, independently of
// the 60s testTimeout. Keep the same bounded budget for fixture setup only.
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'core-pipeline-'))
  const repos = ['front', 'back'].map((name) => {
    const dir = path.join(root, name)
    mkdirSync(dir)
    const git = (args: string[]): void => {
      const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
    git(['init', '-q'])
    write(path.join(dir, 'code.js'), 'module.exports = 1\n')
    write(path.join(dir, '.gitignore'), 'build/\n')
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'])
    return { id: name, name, path: dir }
  })
  const workspace = path.join(root, 'workspace')
  mkdirSync(workspace)
  context = { schemaVersion: 1, runId: 'fixture-run', backlogRoot: workspace, artifactRoot: repos[0]!.path, artifactRepositoryId: 'front', repositories: repos, ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Shared filter', description: 'Changes Front and Back', repositoryIds: ['front', 'back'] }] }
}, 60_000)
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('pipeline runtime journal and verification receipts', () => {
  it('freezes context and resumes the same journal without resetting completed work', () => {
    initializePipeline(context, change)
    artifacts()
    transitionPipeline(context, 'architect', 'done')
    expect(initializePipeline(context, change).phases.architect.status).toBe('done')
    expect(inspectPipeline(context).resumePhase).toBe('developer')
    expect(() => initializePipeline({ ...context, specs: [{ ...context.specs[0]!, description: 'Changed after launch' }] }, change)).toThrow('frozen')
    expect(() => initializePipeline(context, 'different-change')).toThrow('another change')
    expect(() => validatePipelineContext({ ...context, runId: '../escape' })).toThrow()
    expect(() => validatePipelineContext({ ...context, artifactRepositoryId: 'back' })).toThrow('artifactRoot')
  })

  it('hashes untracked additions and tracked deletions while excluding only owned lifecycle artifacts', () => {
    const state = initializePipeline(context, change)
    const original = fingerprintCandidate(state)
    artifacts()
    expect(fingerprintCandidate(state)).toBe(original)
    write(path.join(context.repositories[1]!.path, 'new.js'), 'new feature')
    expect(fingerprintCandidate(state)).not.toBe(original)
    rmSync(path.join(context.repositories[1]!.path, 'new.js'))
    rmSync(path.join(context.repositories[1]!.path, 'code.js'))
    expect(fingerprintCandidate(state)).not.toBe(original)
    write(path.join(context.repositories[1]!.path, 'code.js'), 'module.exports = 1\n')
    write(path.join(context.artifactRoot, 'openspec', 'changes', 'unrelated-change', 'spec.md'), 'not owned')
    expect(fingerprintCandidate(state)).not.toBe(original)
  })

  it('executes real commands in every selected repository and retains their exits', async () => {
    initializePipeline(context, change)
    const receipt = await verifyPipeline(context, request('const fs=require("fs"); if(!fs.readFileSync("code.js","utf8").includes("1")) process.exit(7); process.stdout.write("actual check")'))
    expect(receipt.valid).toBe(true)
    expect(receipt.commands.map((command) => command.cwd)).toEqual(context.repositories.map((repo) => realpathSync(repo.path)))
    expect(receipt.commands.every((command) => command.output === 'actual check' && command.exitCode === 0)).toBe(true)
    expect(inspectPipeline(context).verification.valid).toBe(true)
    await expect(verifyPipeline(context, { kind: 'full', commands: request().commands.slice(0, 1) })).rejects.toThrow('every selected')
    const failed = await verifyPipeline(context, request('process.stderr.write("real failure"); process.exit(7)'))
    expect(failed.valid).toBe(false)
    expect(failed.commands[0]).toMatchObject({ exitCode: 7, output: 'real failure' })
    expect(inspectPipeline(context).verification.valid).toBe(false)
  })

  it('keeps receipts valid after automatic memory writes but tracks skills, settings and committed memory', async () => {
    initializePipeline(context, change)
    await verifyPipeline(context, request())
    for (const repo of context.repositories) {
      for (const provider of ['.claude', '.codex', '.gemini', '.kimi-code', '.specrails']) {
        write(path.join(repo.path, provider, 'agent-memory', 'sr-reviewer', 'MEMORY.md'), 'Review notes after verification')
      }
    }
    expect(inspectPipeline(context).verification.valid).toBe(true)
    for (const file of ['.claude/settings.json', '.claude/skills/check/SKILL.md', '.claude/agent-memory-extra/note.md']) {
      const target = path.join(context.artifactRoot, file)
      write(target, 'candidate input')
      expect(inspectPipeline(context).verification.reasons).toContain('Candidate files changed')
      rmSync(target)
    }
    const memory = '.claude/agent-memory/sr-reviewer/MEMORY.md'
    const result = spawnSync('git', ['-C', context.artifactRoot, 'add', memory], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(inspectPipeline(context).verification.reasons).toContain('Candidate files changed')
    await verifyPipeline(context, request())
    write(path.join(context.artifactRoot, memory), 'Changed tracked memory')
    expect(inspectPipeline(context).verification.reasons).toContain('Candidate files changed')
  })

  it('does not overwrite a valid full receipt with narrower scoped checks', async () => {
    initializePipeline(context, change)
    const full = await verifyPipeline(context, request())
    await verifyPipeline(context, { kind: 'scoped', commands: request().commands.slice(0, 1) })
    expect(inspectPipeline(context).verification.receipt?.id).toBe(full.id)
    write(path.join(context.artifactRoot, 'code.js'), 'module.exports = 2\n')
    expect(inspectPipeline(context).verification).toMatchObject({ valid: false, reasons: ['Candidate files changed'] })
  })

  it('binds explicit environment overrides without persisting their secret values', async () => {
    initializePipeline(context, change)
    const checks = request()
    for (const command of checks.commands) command.env = { CI: 'receipt-specific', PIPELINE_TEST_SECRET: 'do-not-persist-this' }
    const receipt = await verifyPipeline(context, checks)
    expect(receipt.valid).toBe(true)
    expect(inspectPipeline(context).verification.valid).toBe(true)
    const persisted = readFileSync(path.join(pipelineStateDirectory(context), 'receipts', receipt.id + '.json'), 'utf8')
    expect(persisted).not.toContain('do-not-persist-this')
    expect(receipt.commands[0]!.environmentOverridesHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects a green command which changed the verified candidate', async () => {
    initializePipeline(context, change)
    const receipt = await verifyPipeline(context, request('require("fs").writeFileSync("code.js","changed during checks")'))
    expect(receipt.commands.every((command) => command.exitCode === 0)).toBe(true)
    expect(receipt).toMatchObject({ valid: false, reason: 'Candidate changed during verification' })
  })

  it('keeps completed development reusable when a blocked reviewer resumes', async () => {
    await developed()
    transitionPipeline(context, 'reviewer', 'blocked', 'Need missing regression')
    expect(inspectPipeline(context).resumePhase).toBe('reviewer')
    transitionPipeline(context, 'reviewer', 'running')
    score()
    transitionPipeline(context, 'reviewer', 'done')
    expect(inspectPipeline(context).phases.reviewer.reason).toBeUndefined()
    expect(inspectPipeline(context).resumePhase).toBe('archive')
  })

  it('reopens blocked design rather than permanently skipping implementation', () => {
    initializePipeline(context, change)
    artifacts()
    transitionPipeline(context, 'architect', 'blocked', 'Clarify API')
    expect(inspectPipeline(context).resumePhase).toBe('architect')
    transitionPipeline(context, 'architect', 'running')
    transitionPipeline(context, 'architect', 'done')
    expect(inspectPipeline(context).resumePhase).toBe('developer')
    expect(() => transitionPipeline(context, 'developer', 'skipped')).toThrow('Only host-owned')
  })

  it('requires confidence before approving archive, then preserves verification through owned archive moves', async () => {
    await developed()
    expect(() => transitionPipeline(context, 'reviewer', 'done')).toThrow('confidence-score')
    score(40)
    expect(() => transitionPipeline(context, 'reviewer', 'done')).toThrow('does not pass')
    score()
    transitionPipeline(context, 'reviewer', 'done')
    checkArchive(context)
    const destination = path.join(context.artifactRoot, 'openspec', 'changes', 'archive', '2026-09-06-' + change)
    mkdirSync(path.dirname(destination), { recursive: true })
    renameSync(path.join(context.artifactRoot, 'openspec', 'changes', change), destination)
    write(path.join(context.artifactRoot, 'openspec', 'specs', 'filter', 'spec.md'), '# Filter behavior')
    transitionPipeline(context, 'archive', 'done')
    expect(inspectPipeline(context).verification.valid).toBe(true)
    expect(() => transitionPipeline(context, 'ship', 'done')).toThrow('Host owns')
    transitionPipeline(context, 'ship', 'skipped')
    transitionPipeline(context, 'ci', 'skipped')
    expect(inspectPipeline(context).resumePhase).toBeNull()
  })

  it('cannot certify an archive that bypassed its final approval', async () => {
    await developed()
    score()
    transitionPipeline(context, 'reviewer', 'done')
    const destination = path.join(context.artifactRoot, 'openspec', 'changes', 'archive', '2026-09-06-' + change)
    mkdirSync(path.dirname(destination), { recursive: true })
    renameSync(path.join(context.artifactRoot, 'openspec', 'changes', change), destination)
    expect(() => transitionPipeline(context, 'archive', 'done')).toThrow('not authorized')
  })

  it('validates the actual applied preview and refuses stale-base overwrites', async () => {
    initializePipeline(context, change)
    const source = path.join(context.backlogRoot, 'preview-code')
    write(source, 'module.exports = 2\n')
    preparePreview(context, { files: [{ repositoryId: 'front', path: 'code.js', operation: 'write', sourcePath: source }] })
    write(path.join(context.repositories[1]!.path, 'new.js'), 'external edit')
    await expect(applyPreview(context, request())).rejects.toThrow('Preview base changed')
    expect(readFileSync(path.join(context.artifactRoot, 'code.js'), 'utf8')).toContain('1')
    rmSync(path.join(context.repositories[1]!.path, 'new.js'))
    const checks = request()
    checks.commands[0]!.args = ['-e', 'if(require("./code.js")!==2) process.exit(9)']
    const receipt = await applyPreview(context, checks)
    expect(receipt.valid).toBe(true)
    expect(readFileSync(path.join(context.artifactRoot, 'code.js'), 'utf8')).toContain('2')
  })

  it('rejects preview targets outside a repository and reports failed applied checks honestly', async () => {
    initializePipeline(context, change)
    const source = path.join(context.backlogRoot, 'preview-code')
    write(source, 'module.exports = 3\n')
    expect(() => preparePreview(context, { files: [{ repositoryId: 'front', path: '../escape', operation: 'write', sourcePath: source }] })).toThrow('escapes')
    preparePreview(context, { files: [{ repositoryId: 'front', path: 'code.js', operation: 'write', sourcePath: source }] })
    const receipt = await applyPreview(context, request('process.exit(8)'))
    expect(receipt.valid).toBe(false)
    expect(inspectPipeline(context).verification.valid).toBe(false)
    expect(readFileSync(path.join(context.artifactRoot, 'code.js'), 'utf8')).toContain('3')
  })
})

describe('pipeline boundary regressions', () => {
  it('invalidates a full pass after a failing scoped check on unchanged code', async () => {
    await developed()
    score()
    transitionPipeline(context, 'reviewer', 'done')
    const full = inspectPipeline(context).verification.receipt!.id
    const failure = await verifyPipeline(context, { kind: 'scoped', commands: [{ ...request().commands[0]!, args: ['-e', 'process.exit(7)'] }] })
    expect(failure.valid).toBe(false)
    expect(inspectPipeline(context).verification.valid).toBe(false)
    expect(inspectPipeline(context).verification.receipt!.id).not.toBe(full)
    expect(() => checkArchive(context)).toThrow('Archive blocked')
    await verifyPipeline(context, request())
    expect(checkArchive(context).archiveApproval).toBeDefined()
  })

  it('keeps fingerprints independent of provider Git exclusions while tracking real additions', async () => {
    initializePipeline(context, change)
    const ignoredByProvider = path.join(context.artifactRoot, 'provider-hidden.js')
    write(ignoredByProvider, 'module.exports = 3')
    const exclude = path.join(root, 'provider-git-excludes')
    write(exclude, 'provider-hidden.js\n')
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.excludesFile')
    vi.stubEnv('GIT_CONFIG_VALUE_0', exclude)
    const before = fingerprintCandidate(initializePipeline(context, change))
    await verifyPipeline(context, request())
    vi.unstubAllEnvs()
    expect(fingerprintCandidate(initializePipeline(context, change))).toBe(before)
    // Fingerprints do not hide source through incidental Git config; command
    // environment differences still require fresh verification conservatively.
    expect(inspectPipeline(context).verification.reasons.join(';')).toContain('environment changed')
    write(ignoredByProvider, 'module.exports = 4')
    expect(fingerprintCandidate(initializePipeline(context, change))).not.toBe(before)
  })

  it('blocks changed architecture confidence before developer/reviewer admission', async () => {
    await developed()
    write(path.join(context.artifactRoot, 'openspec', 'changes', change, 'design-confidence.json'), JSON.stringify({ confidence: 'low' }))
    score()
    await verifyPipeline(context, request())
    expect(inspectPipeline(context).resumePhase).toBe('architect')
    expect(() => transitionPipeline(context, 'reviewer', 'done')).toThrow('Design confidence')
  })

  it('rejects dangling symlink preview and journal write paths', () => {
    initializePipeline(context, change)
    const source = path.join(context.backlogRoot, 'preview-source')
    write(source, 'proposal')
    const outside = path.join(root, 'outside-not-created')
    symlinkSync(outside, path.join(context.artifactRoot, 'dangling'))
    expect(() => preparePreview(context, { files: [{ repositoryId: 'front', path: 'dangling', operation: 'write', sourcePath: source }] })).toThrow('symlink')
    const other = { ...context, runId: 'other-run' }
    symlinkSync(path.join(root, 'missing-journal'), pipelineStateDirectory(other))
    expect(() => initializePipeline(other, change)).toThrow('symlink')
    expect(existsSync(outside)).toBe(false)
  })

  it('validates an apply request before changing candidate files', async () => {
    initializePipeline(context, change)
    const source = path.join(context.backlogRoot, 'preview-source')
    write(source, 'replacement')
    preparePreview(context, { files: [{ repositoryId: 'front', path: 'code.js', operation: 'write', sourcePath: source }] })
    await expect(applyPreview(context, { kind: 'full', commands: [] })).rejects.toThrow('structured commands')
    expect(readFileSync(path.join(context.artifactRoot, 'code.js'), 'utf8')).toContain('module.exports = 1')
  })

  it('freezes standalone tickets and resumes same-change identity without rereading backlog', async () => {
    const originalCwd = process.cwd()
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('SPECRAILS_EXECUTION_CONTEXT', '')
    vi.stubEnv('SPECRAILS_REPO_DIR', context.artifactRoot)
    process.chdir(context.backlogRoot)
    try {
      const backlog = path.join(context.backlogRoot, '.specrails', 'local-tickets.json')
      write(backlog, JSON.stringify({ tickets: { '17': { id: 17, title: 'Original', description: 'Frozen acceptance' } } }))
      expect(await runPipelineCli(['init', '--change', change, '--tickets', '17'])).toBe(0)
      const pointer = path.join(context.backlogRoot, '.specrails', 'pipeline-context.json')
      const first = JSON.parse(readFileSync(pointer, 'utf8')) as PipelineContext
      expect(first.specs).toEqual([{ id: 17, title: 'Original', description: 'Frozen acceptance' }])
      write(backlog, JSON.stringify({ tickets: {} }))
      expect(await runPipelineCli(['init', '--change', change, '--tickets', '17'])).toBe(0)
      expect(JSON.parse(readFileSync(pointer, 'utf8')).runId).toBe(first.runId)
      expect(inspectPipeline(first).context.specs[0]!.title).toBe('Original')
      expect(await runPipelineCli(['init', '--change', 'another', '--tickets', '99'])).toBe(1)
      expect(errors).toHaveBeenCalled()
    } finally {
      process.chdir(originalCwd)
      output.mockRestore()
      errors.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('resumes review rather than development after a reviewer repair is verified', async () => {
    await developed()
    transitionPipeline(context, 'reviewer', 'running')
    write(path.join(context.artifactRoot, 'code.js'), 'module.exports = 2\n')
    await verifyPipeline(context, request())
    score()
    transitionPipeline(context, 'reviewer', 'done')
    expect(inspectPipeline(context).resumePhase).toBe('archive')
    expect(checkArchive(context).archiveApproval).toBeDefined()
  })
})


describe('pipeline final admission regressions', () => {
  it('returns to review when its receipt environment becomes stale before archive', async () => {
    await developed()
    score()
    transitionPipeline(context, 'reviewer', 'done')
    expect(inspectPipeline(context).resumePhase).toBe('archive')
    vi.stubEnv('NODE_ENV', 'receipt-environment-changed')
    try {
      expect(inspectPipeline(context).verification.valid).toBe(false)
      expect(inspectPipeline(context).resumePhase).toBe('reviewer')
      expect(() => checkArchive(context)).toThrow('environment changed')
    } finally { vi.unstubAllEnvs() }
  })

  it('cannot approve architecture without a delta spec', () => {
    initializePipeline(context, change)
    const dir = artifacts()
    rmSync(path.join(dir, 'specs'), { recursive: true })
    expect(() => transitionPipeline(context, 'architect', 'done')).toThrow('delta specs')
  })

  it('uses explicit Windows shim quoting and does not reinterpret structured args', () => {
    expect(verificationInvocation('npm.cmd', ['test', '--', 'test file.ts'], 'C:/repo', 'win32', {})).toEqual({
      command: 'cmd.exe', args: ['/d', '/s', '/c', '\"\"npm.cmd\" \"test\" \"--\" \"test file.ts\"\"'], windowsVerbatimArguments: true,
    })
    expect(() => verificationInvocation('npm.cmd', ['test & echo changed'], 'C:/repo', 'win32', {})).toThrow('underlying executable')
    expect(verificationInvocation('node.exe', ['-e', 'process.exit(0)'], 'C:/repo', 'win32', {})).toEqual({ command: 'node.exe', args: ['-e', 'process.exit(0)'] })
    expect(verificationInvocation('npm', ['test'], '/repo', 'linux', {})).toEqual({ command: 'npm', args: ['test'] })
  })
})


describe('linked verification inputs', () => {
  it('invalidates receipt when an external symlinked input changes', async () => {
    initializePipeline(context, change)
    const external = path.join(root, 'external-config')
    write(external, 'good')
    symlinkSync(external, path.join(context.artifactRoot, 'config.txt'))
    const checks = request()
    checks.commands[0]!.args = ['-e', 'if(require("fs").readFileSync("config.txt","utf8")!=="good")process.exit(8)']
    await verifyPipeline(context, checks)
    expect(inspectPipeline(context).verification.valid).toBe(true)
    write(external, 'bad')
    expect(inspectPipeline(context).verification.valid).toBe(false)
  })

  it('hashes ordinary linked framework directories and fails closed on cycles', async () => {
    initializePipeline(context, change)
    const external = path.join(root, 'framework')
    write(path.join(external, 'skills', 'role.md'), 'first role')
    symlinkSync(external, path.join(context.artifactRoot, '.kimi-code'))
    await verifyPipeline(context, request())
    expect(inspectPipeline(context).verification.valid).toBe(true)
    write(path.join(external, 'skills', 'role.md'), 'changed role')
    expect(inspectPipeline(context).verification.valid).toBe(false)
    symlinkSync(external, path.join(external, 'cycle'))
    expect(() => inspectPipeline(context)).toThrow('cyclic')
    rmSync(path.join(external, 'cycle'))
    symlinkSync(path.join(root, 'missing'), path.join(external, 'dangling'))
    expect(() => inspectPipeline(context)).toThrow('dangling')
  })
})


describe('owned journal artifact paths', () => {
  it('refuses redirected preview and receipt subdirectories', async () => {
    initializePipeline(context, change)
    const outside = path.join(root, 'outside-artifacts')
    mkdirSync(outside)
    const source = path.join(context.backlogRoot, 'preview-source')
    write(source, 'proposal')
    symlinkSync(outside, path.join(pipelineStateDirectory(context), 'preview'))
    expect(() => preparePreview(context, { files: [{ repositoryId: 'front', path: 'code.js', operation: 'write', sourcePath: source }] })).toThrow('symlink')
    expect(existsSync(path.join(outside, '0'))).toBe(false)
    symlinkSync(outside, path.join(pipelineStateDirectory(context), 'receipts'))
    await expect(verifyPipeline(context, request())).rejects.toThrow('symlink')
    expect(inspectPipeline(context).verification.valid).toBe(false)
  })
})

describe('concurrent journal recovery', () => {
  it('allows one initializer after a dead lease without deleting a successor lease', async () => {
    const dir = pipelineStateDirectory(context)
    mkdirSync(dir, { recursive: true })
    const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
    expect(dead.status).toBe(0)
    write(path.join(dir, 'journal.lock'), JSON.stringify({ pid: dead.pid, token: 'dead-owner' }))
    const source = readFileSync(new URL('./pipeline-state.ts', import.meta.url), 'utf8')
    const module = path.join(root, 'runtime.mjs')
    write(module, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText)
    const contextFile = path.join(root, 'context.json')
    write(contextFile, JSON.stringify(context))
    const barrier = path.join(root, 'start-workers')
    const script = [
      'import { initializePipeline } from ' + JSON.stringify(pathToFileURL(module).href) + ';',
      'import { existsSync, readFileSync } from "node:fs";',
      'while(!existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);',
      'try { initializePipeline(JSON.parse(readFileSync(process.argv[1],"utf8")),process.argv[3]); process.stdout.write("won"); }',
      'catch(error) { process.stdout.write("blocked"); }',
    ].join('\n')
    const workers = Array.from({ length: 8 }, (_, index) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, contextFile, barrier, 'candidate-' + index], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let errors = ''
      child.stdout.on('data', (chunk) => { output += String(chunk) })
      child.stderr.on('data', (chunk) => { errors += String(chunk) })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(errors)))
    }))
    write(barrier, 'start')
    const outcomes = await Promise.all(workers)
    expect(outcomes.filter((output) => output === 'won')).toHaveLength(1)
    expect(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).change).toMatch(/^candidate-[0-7]$/)
    expect(existsSync(path.join(dir, 'journal.lock'))).toBe(false)
    expect(existsSync(path.join(dir, 'journal-reclaim.lock'))).toBe(false)
  })
})


describe('application environment evidence', () => {
  it('isolates mixed-case Windows transport and replaces inherited Path with an explicit PATH', () => {
    const base = { Path: 'inherited', claudecode: '1', Claude_Code_Session_Id: 'session', App_Mode: 'test' }
    expect(verificationEnvironment(base, { PATH: 'requested' }, 'win32')).toEqual({ PATH: 'requested', APP_MODE: 'test' })
    expect(verificationEnvironment({ PATH: 'inherited', APP_MODE: 'test' }, { Path: 'requested' }, 'win32'))
      .toEqual(verificationEnvironment(base, { PATH: 'requested' }, 'win32'))
    expect(verificationEnvironment(base, { CLAUDECODE: 'explicit' }, 'win32').CLAUDECODE).toBe('explicit')
    expect(verificationEnvironment(base, { PATH: 'requested' }, 'linux')).toMatchObject({ Path: 'inherited', PATH: 'requested', claudecode: '1' })
    expect(() => verificationEnvironment({ Path: 'one', PATH: 'two' }, {}, 'win32')).toThrow('Ambiguous verification environment key: PATH')
  })

  it('reuses verification across agent sessions and a host process without session identity', () => {
    initializePipeline(context, change)
    const source = readFileSync(new URL('./pipeline-state.ts', import.meta.url), 'utf8')
    const module = path.join(root, 'runtime.mjs')
    write(module, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText)
    const contextFile = path.join(root, 'context.json')
    write(contextFile, JSON.stringify(context))
    const sessionKeys = ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION']
    const baseEnv = { ...process.env }
    for (const key of Object.keys(baseEnv)) if (sessionKeys.includes(process.platform === 'win32' ? key.toUpperCase() : key)) delete baseEnv[key]
    const invoke = (operation: string, env: NodeJS.ProcessEnv) => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', [
        `import { verifyPipeline, inspectPipeline } from ${JSON.stringify(pathToFileURL(module).href)};`,
        'import { readFileSync } from "node:fs";',
        'const context = JSON.parse(readFileSync(process.argv[1], "utf8"));',
        operation,
      ].join('\n'), contextFile], { env, encoding: 'utf8', timeout: 20_000 })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    const session = (suffix: string) => ({ ...baseEnv, ...Object.fromEntries(sessionKeys.map(key => [process.platform === 'win32' && suffix === 'first' ? key.toLowerCase() : key, `fixture-${suffix}-${key}`])) })
    const checks = request(`if (${JSON.stringify(sessionKeys)}.some(key => process.env[key] !== undefined)) process.exit(23)`)
    const receipt = invoke(`process.stdout.write(JSON.stringify(await verifyPipeline(context, ${JSON.stringify(checks)})));`, session('first'))
    expect(receipt.valid).toBe(true)
    for (const key of sessionKeys) expect(receipt.commands[0].environmentKeys).not.toContain(key)
    const inspect = 'process.stdout.write(JSON.stringify(inspectPipeline(context)));'
    for (const env of [session('second'), baseEnv]) {
      expect(invoke(inspect, env).verification.valid).toBe(true)
    }
    for (const key of ['NODE_OPTIONS', 'npm_config_registry', 'SPECRAILS_EXECUTION_CONTEXT', 'SPECRAILS_PROFILE_PATH', 'CLAUDE_CODE_CUSTOM_CONFIG']) {
      expect(invoke(inspect, { ...baseEnv, [key]: key === 'NODE_OPTIONS' ? '--no-warnings' : 'changed-fixture-value' }).verification.valid).toBe(false)
    }
    write(path.join(context.artifactRoot, 'code.js'), 'module.exports = 2\n')
    expect(invoke(inspect, baseEnv).verification.reasons).toContain('Candidate files changed')
  })

  it('requires one fresh verification for receipts from the previous environment policy', async () => {
    initializePipeline(context, change)
    await verifyPipeline(context, request())
    const file = path.join(pipelineStateDirectory(context), 'state.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    for (const command of state.verification.commands) delete command.environmentPolicy
    write(file, JSON.stringify(state))
    expect(inspectPipeline(context).verification).toMatchObject({ valid: false })
    expect(inspectPipeline(context).verification.reasons.join(';')).toContain('policy changed; run full verification again')
    await verifyPipeline(context, request())
    expect(inspectPipeline(context).verification.valid).toBe(true)
  })

  it('executes explicit transport overrides as bound inputs without persisting their values', async () => {
    initializePipeline(context, change)
    const checks = request('if (!process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID !== process.env.EXPECTED_SESSION) process.exit(17)')
    for (const command of checks.commands) command.env = { CLAUDE_CODE_SESSION_ID: 'explicit-fixture-input', EXPECTED_SESSION: 'explicit-fixture-input' }
    const receipt = await verifyPipeline(context, checks)
    expect(receipt.valid).toBe(true)
    expect(receipt.commands[0]!.environmentOverrideKeys).toContain('CLAUDE_CODE_SESSION_ID')
    expect(JSON.stringify(receipt)).not.toContain('explicit-fixture-input')
    expect(receipt.commands[0]!.environmentOverridesHash).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.commands[0]).not.toHaveProperty('env')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'another-session')
    try { expect(inspectPipeline(context).verification.valid).toBe(true) }
    finally { vi.unstubAllEnvs() }
  })

  it('keeps reviewed and archived work valid after an agent hands back to the host', async () => {
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'developer-session')
    try {
      await developed()
      const receiptId = inspectPipeline(context).verification.receipt!.id
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'reviewer-session')
      score()
      transitionPipeline(context, 'reviewer', 'done')
      checkArchive(context)
      const destination = path.join(context.artifactRoot, 'openspec', 'changes', 'archive', '2026-09-10-' + change)
      mkdirSync(path.dirname(destination), { recursive: true })
      renameSync(path.join(context.artifactRoot, 'openspec', 'changes', change), destination)
      transitionPipeline(context, 'archive', 'done')
      transitionPipeline(context, 'ship', 'skipped')
      transitionPipeline(context, 'ci', 'skipped')
      vi.stubEnv('CLAUDECODE', undefined)
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined)
      expect(inspectPipeline(context)).toMatchObject({ resumePhase: null, verification: { valid: true, receipt: { id: receiptId } } })
      vi.stubEnv('NODE_ENV', 'changed-application-environment')
      expect(inspectPipeline(context).verification.valid).toBe(false)
      expect(inspectPipeline(context).resumePhase).toBe('reviewer')
    } finally { vi.unstubAllEnvs() }
  })

  it('invalidates changed, added or removed application environment inputs', async () => {
    initializePipeline(context, change)
    vi.stubEnv('PIPELINE_APP_MODE', 'test-a')
    vi.stubEnv('PIPELINE_VITE_API_URL', undefined)
    try {
      await verifyPipeline(context, request())
      expect(inspectPipeline(context).verification.valid).toBe(true)
      vi.stubEnv('PIPELINE_APP_MODE', 'test-b')
      expect(inspectPipeline(context).verification.valid).toBe(false)
      vi.stubEnv('PIPELINE_APP_MODE', 'test-a')
      expect(inspectPipeline(context).verification.valid).toBe(true)
      vi.stubEnv('PIPELINE_VITE_API_URL', 'https://fixture.invalid')
      expect(inspectPipeline(context).verification.valid).toBe(false)
      vi.stubEnv('PIPELINE_VITE_API_URL', undefined)
      vi.stubEnv('PIPELINE_APP_MODE', undefined)
      expect(inspectPipeline(context).verification.valid).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })

  it('keeps explicit application overrides fixed without persisting secret values', async () => {
    initializePipeline(context, change)
    const checks = request()
    for (const command of checks.commands) command.env = { DATABASE_URL: 'private-fixture-override' }
    await verifyPipeline(context, checks)
    vi.stubEnv('DATABASE_URL', 'different-ambient-value')
    try {
      const status = inspectPipeline(context)
      expect(status.verification.valid).toBe(true)
      expect(JSON.stringify(status.verification.receipt)).not.toContain('private-fixture-override')
      expect(status.verification.receipt!.commands[0]!.environmentOverrideKeys).toContain('DATABASE_URL')
    } finally { vi.unstubAllEnvs() }
  })
})


describe('semantic acceptance and honest completion', () => {
  it('requires evidence even with all tasks, tests and numeric confidence passing', async () => {
    await developed()
    score()
    const file = path.join(pipelineStateDirectory(validatePipelineContext(context)), 'state.json')
    const state = JSON.parse(readFileSync(file, 'utf8')); delete state.acceptance; write(file, JSON.stringify(state))
    expect(() => transitionPipeline(context, 'reviewer', 'done')).toThrow('No acceptance evidence')
    expect(inspectPipeline(context).completion).toMatchObject({ implementation: 'complete', validation: 'pending', delivery: 'pending-host' })
  })
  it('rejects missing, duplicated and rewritten criteria across batch tickets', async () => {
    context.specs.push({ id: 2, title: 'Second', description: 'Second requirement', acceptanceCriteria: ['Browser performance', 'Readable HUD'] })
    await developed()
    const report = accepted()
    expect(() => recordAcceptance(context, { ...report, criteria: report.criteria.slice(0, 1) })).toThrow('every frozen')
    expect(() => recordAcceptance(context, { ...report, criteria: report.criteria.map(() => report.criteria[0]) })).toThrow('duplicated')
    report.criteria[0]!.requirement = 'Weaker interpretation'
    expect(() => recordAcceptance(context, report)).toThrow('frozen scope')
  })
  it('requires explicit authority for material exceptions and exposes supplementary failures', async () => {
    await developed(); score()
    const report = accepted()
    report.criteria[0]!.status = 'exception'
    report.criteria[0]!.exception = { reason: 'Hold panel does not exist', impact: 'Next preview used instead', material: true, acceptedBy: 'reviewer', approvalEvidence: 'review notes' }
    expect(() => recordAcceptance(context, report)).toThrow('user or host')
    report.criteria[0]!.exception!.acceptedBy = 'user'
    report.criteria[0]!.exception!.approvalEvidence = 'User approved alternative HUD in ticket #1'
    report.checks.push({ name: 'Browser timing', required: false, status: 'unavailable', evidence: ['browser.log'], scope: 'Browser frames', limitations: 'Node test excludes rendering and GPU' })
    recordAcceptance(context, report)
    transitionPipeline(context, 'reviewer', 'done')
    expect(inspectPipeline(context).completion.validation).toBe('with-exceptions')
    expect(checkArchive(context).archiveApproval?.acceptanceHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it.each(['blocked', 'pending'] as const)('blocks review on unresolved %s requirements', async status => {
    await developed(); score(); const report = accepted(); report.criteria[0]!.status = status
    recordAcceptance(context, report)
    expect(() => transitionPipeline(context, 'reviewer', 'done')).toThrow('Unresolved requirement')
  })
  it('does not allow a required browser check to hide behind passing Node commands', async () => {
    await developed(); score(); const report = accepted()
    report.checks.push({ name: 'Frame timing', required: true, status: 'failed', evidence: ['capture.log'], scope: 'Real browser rendering', limitations: 'Capture deadlocked' })
    recordAcceptance(context, report)
    expect(() => transitionPipeline(context, 'reviewer', 'done')).toThrow('Required check')
  })
  it('invalidates evidence on source edits and review approval on report replacement', async () => {
    await developed(); score(); transitionPipeline(context, 'reviewer', 'done'); checkArchive(context)
    recordAcceptance(context, accepted())
    expect(() => checkArchive(context)).toThrow('Review must complete')
    transitionPipeline(context, 'reviewer', 'done')
    write(path.join(context.artifactRoot, 'code.js'), 'module.exports = 2')
    expect(inspectPipeline(context).acceptance).toMatchObject({ valid: false, status: 'blocked' })
    await verifyPipeline(context, request())
    expect(() => transitionPipeline(context, 'reviewer', 'done')).toThrow('stale')
  })
  it('keeps notes in stateDir from invalidating a reusable receipt', async () => {
    await developed(); const receipt = inspectPipeline(context).verification.receipt!.id
    write(path.join(pipelineStateDirectory(validatePipelineContext(context)), 'developer-completion-notes.md'), 'Operational notes')
    score(); transitionPipeline(context, 'reviewer', 'done')
    expect(inspectPipeline(context).verification).toMatchObject({ valid: true, receipt: { id: receipt } })
  })
  it('accumulates phase time and attempts without counting repeated running as a retry', async () => {
    initializePipeline(context, change); artifacts()
    transitionPipeline(context, 'architect', 'running')
    transitionPipeline(context, 'architect', 'running')
    transitionPipeline(context, 'architect', 'blocked', 'Need clarification')
    transitionPipeline(context, 'architect', 'running')
    const phase = transitionPipeline(context, 'architect', 'done').phases.architect
    expect(phase.attempts).toBe(2)
    expect(phase.durationMs).toBeGreaterThanOrEqual(0)
  })
})


it('preserves elapsed reviewer time when the active reviewer records acceptance', async () => {
  await developed()
  transitionPipeline(context, 'reviewer', 'running')
  const file = path.join(pipelineStateDirectory(validatePipelineContext(context)), 'state.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.phases.reviewer.startedAt = new Date(Date.now() - 2000).toISOString()
  write(file, JSON.stringify(state))
  score()
  expect(transitionPipeline(context, 'reviewer', 'done').phases.reviewer.durationMs).toBeGreaterThanOrEqual(2000)
})
