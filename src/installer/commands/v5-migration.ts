import path from 'node:path'

import { info, ok } from '../util/logger.js'
import { pathExists, removePath } from '../util/fs.js'
import { isReservedPath, repoRelative } from '../util/paths.js'

/**
 * Agent ids removed in v5. On update of a pre-v5 install their live `.md`
 * files (installer-owned by the manifest contract) are deleted. `custom-*`
 * agents are NEVER in this set and are protected by the reserved-paths gate.
 */
const REMOVED_AGENTS = [
  'sr-product-manager',
  'sr-product-analyst',
  'sr-test-writer',
  'sr-doc-sync',
  'sr-merge-resolver',
  'sr-frontend-developer',
  'sr-backend-developer',
  'sr-frontend-reviewer',
  'sr-backend-reviewer',
  'sr-security-reviewer',
  'sr-performance-reviewer',
] as const

/** Command ids removed in v5 (deleted across every provider surface). */
const REMOVED_COMMANDS = [
  'enrich',
  'reconfig',
  'vpc-drift',
  'auto-propose-backlog-specs',
  'get-backlog-specs',
  'merge-resolve',
] as const

export interface V5MigrationInput {
  /** Absolute artifact root (in-repo repoRoot, or the relocated $HOME workspace). */
  artifactRoot: string
  /** Provider directory name (`.claude` / `.codex` / `.gemini`). */
  providerDir: string
}

/**
 * Removes artefacts a pre-v5 install left behind so the fresh v5 template set
 * places into a clean tree. Strictly subtractive and reserved-path-safe:
 *
 *   - Removed agent files (`.claude/agents/sr-*.md`, `.gemini/agents/sr-*.md`)
 *   - Removed command files (`<providerDir>/commands/specrails/*.md`) and their
 *     codex skill dirs (`.codex/skills/<cmd>/`)
 *   - The generated top-level skills for removed commands (`.claude/skills/<id>/`)
 *   - Obsolete staging subtrees under `.specrails/setup-templates/`
 *     (`personas/`, `skills/enrich/`, and the removed command/agent templates)
 *   - VPC persona output dirs (`<providerDir>/agents/personas/`)
 *
 * `custom-*.md` agents and `.specrails/profiles/**` are protected by
 * {@link isReservedPath}; files the installer never owned are not enumerated
 * here, so they are untouched. When at least one path is removed a migration
 * summary is printed so the user sees exactly what changed.
 */
export function migratePreV5Install(input: V5MigrationInput): void {
  const { artifactRoot, providerDir } = input
  const removed: string[] = []

  const remove = (abs: string): void => {
    if (!pathExists(abs)) return
    const rel = repoRelative(artifactRoot, abs)
    if (isReservedPath(rel)) return
    removePath(abs)
    removed.push(rel)
  }

  // Agents (claude + gemini both store `<providerDir>/agents/<id>.md`).
  const agentsDir = path.join(artifactRoot, providerDir, 'agents')
  for (const id of REMOVED_AGENTS) {
    remove(path.join(agentsDir, `${id}.md`))
  }
  // VPC persona output directory (created by the retired enrich flow).
  remove(path.join(agentsDir, 'personas'))

  // Commands (claude/gemini command files) + codex skill dirs.
  const commandsDir = path.join(artifactRoot, providerDir, 'commands', 'specrails')
  const skillsDir = path.join(artifactRoot, providerDir, 'skills')
  for (const id of REMOVED_COMMANDS) {
    remove(path.join(commandsDir, `${id}.md`))
    remove(path.join(commandsDir, `${id}.toml`))
    remove(path.join(skillsDir, id))
  }
  // Top-level generated skills for removed backlog commands (claude).
  for (const id of ['sr-get-backlog-specs', 'sr-auto-propose-backlog-specs']) {
    remove(path.join(skillsDir, id))
  }
  // Codex rail skills for removed agents.
  const railsDir = path.join(skillsDir, 'rails')
  for (const id of REMOVED_AGENTS) {
    remove(path.join(railsDir, id))
  }

  // Obsolete staging subtrees under setup-templates/ (the dir itself stays).
  const staging = path.join(artifactRoot, '.specrails', 'setup-templates')
  remove(path.join(staging, 'personas'))
  remove(path.join(staging, 'skills', 'enrich'))
  const stagingRails = path.join(staging, 'skills', 'rails')
  for (const id of REMOVED_AGENTS) {
    remove(path.join(stagingRails, id))
  }
  const stagingAgents = path.join(staging, 'agents')
  for (const id of REMOVED_AGENTS) {
    remove(path.join(stagingAgents, `${id}.md`))
  }
  const stagingCommands = path.join(staging, 'commands', 'specrails')
  for (const id of REMOVED_COMMANDS) {
    remove(path.join(stagingCommands, `${id}.md`))
  }
  // Removed settings template (perf thresholds).
  remove(path.join(staging, 'settings', 'perf-thresholds.yml'))

  if (removed.length === 0) return

  info(`v5 migration: removed ${removed.length} obsolete artefact(s) from a pre-v5 install:`)
  for (const rel of removed.sort()) info(`  - ${rel}`)
  ok('Removed v4 artefacts — agents beyond the core trio now come from profiles (custom-*.md).')
}

/**
 * Test helper: enumerate removed agent/command ids so specs can assert the
 * migration set stays in lock-step with the deleted templates.
 */
export const V5_REMOVED = {
  agents: REMOVED_AGENTS,
  commands: REMOVED_COMMANDS,
} as const
