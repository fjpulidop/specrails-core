import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { info, ok, fail as logFail, rawOut } from '../util/logger.js'
import { commandExists, runCommand } from '../util/exec.js'
import { isDir, isFile, listDir, mkdirp } from '../util/fs.js'

import { assertClaudeAuthenticated } from '../phases/provider-detect.js'

/**
 * `npx specrails-core doctor` — health check for a specrails install.
 * Ports bin/doctor.sh to Node with identical exit semantics:
 *   - exit 0 when every check passes
 *   - exit 1 when any check fails
 * Appends a single line to ~/.specrails/doctor.log after every run.
 */

export interface DoctorFlags {
  'root-dir'?: string | boolean
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

  rawOut('\nspecrails doctor\n\n')

  const results: DoctorResult['results'] = []
  const addPass = (message: string): void => {
    results.push({ kind: 'pass', message })
  }
  const addFail = (message: string, fix: string): void => {
    results.push({ kind: 'fail', message, fix })
  }

  // Check 1: Claude Code CLI
  if (await commandExists('claude')) {
    const path_ = await resolveCommandPath('claude')
    addPass(`Claude Code CLI: found${path_ ? ` (${path_})` : ''}`)
  } else {
    addFail('Claude Code CLI: not found', 'Install Claude Code: https://claude.ai/download')
  }

  // Check 2: Claude authentication (only meaningful if the CLI is installed)
  if (await commandExists('claude')) {
    try {
      await assertClaudeAuthenticated({ skipPrereqs: false })
      addPass('Claude: authenticated')
    } catch {
      addFail(
        'Claude: not authenticated',
        'Option 1: claude config set api_key <your-key>  |  Option 2: claude auth login',
      )
    }
  }

  // Check 3: Agent files present (legacy `agents/` directory layout)
  const agentsDir = path.join(projectRoot, 'agents')
  if (isDir(agentsDir)) {
    const agentMdFiles = findAgentMdFiles(agentsDir)
    if (agentMdFiles.length >= 1) {
      const names = agentMdFiles
        .map((f) => path.basename(path.dirname(f)))
        .join(', ')
      addPass(`Agent files: ${agentMdFiles.length} agent(s) found (${names})`)
    } else {
      addFail(
        'Agent files: agents/ exists but no AGENTS.md found',
        'Run specrails-core init to set up agents',
      )
    }
  } else {
    addFail(
      'Agent files: agents/ directory not found',
      'Run specrails-core init to set up agents',
    )
  }

  // Check 4: CLAUDE.md present
  if (isFile(path.join(projectRoot, 'CLAUDE.md'))) {
    addPass('CLAUDE.md: present')
  } else {
    addFail('CLAUDE.md: missing', 'Run /specrails:setup inside Claude Code to regenerate')
  }

  // Check 5: Git initialized
  if (isDir(path.join(projectRoot, '.git'))) {
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
      `All ${passed + failed} checks passed. Run /specrails:get-backlog-specs to get started.`,
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

function findAgentMdFiles(root: string): string[] {
  const out: string[] = []
  if (!isDir(root)) return out
  const walk = (dir: string): void => {
    for (const entry of listDir(dir)) {
      if (isDir(entry)) walk(entry)
      else if (path.basename(entry) === 'AGENTS.md') out.push(entry)
    }
  }
  walk(root)
  return out
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
