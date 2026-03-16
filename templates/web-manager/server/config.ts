import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import type { PhaseDefinition } from './types'

export interface CommandInfo {
  id: string
  name: string
  description: string
  slug: string
  phases: PhaseDefinition[]
}

export interface IssueTrackerInfo {
  available: boolean
  authenticated: boolean
  repo?: string
}

export interface ProjectConfig {
  project: {
    name: string
    repo: string | null
  }
  issueTracker: {
    github: IssueTrackerInfo
    jira: IssueTrackerInfo
    active: 'github' | 'jira' | null
    labelFilter: string
  }
  commands: CommandInfo[]
}

function runCommand(cmd: string, cwd?: string): string | null {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, cwd }).toString().trim()
  } catch {
    return null
  }
}

function detectGithub(): IssueTrackerInfo {
  const ghPath = runCommand('which gh')
  if (!ghPath) return { available: false, authenticated: false }

  const authOutput = runCommand('gh auth status')
  const authenticated = authOutput !== null

  return { available: true, authenticated }
}

function detectJira(): IssueTrackerInfo {
  const jiraPath = runCommand('which jira')
  if (!jiraPath) return { available: false, authenticated: false }

  // jira CLI availability means it is configured (auth is implicit via jira config)
  return { available: true, authenticated: true }
}

function getGitRepoName(projectRoot?: string): string | null {
  const output = runCommand('git remote get-url origin', projectRoot)
  if (!output) return null

  // Parse both HTTPS and SSH remote URLs
  // https://github.com/owner/repo.git → owner/repo
  // git@github.com:owner/repo.git → owner/repo
  const httpsMatch = output.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/)
  if (httpsMatch) return httpsMatch[1]

  const sshMatch = output.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (sshMatch) return sshMatch[1]

  return null
}

interface ParsedFrontmatter {
  scalars: Record<string, string>
  phases: PhaseDefinition[]
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = { scalars: {}, phases: [] }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return result

  const lines = match[1].split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) { i++; continue }

    const key = line.slice(0, colonIdx).trim()
    const rawValue = line.slice(colonIdx + 1).trim()

    if (!key) { i++; continue }

    // Array field: value is empty, subsequent lines start with "  - "
    if (rawValue === '' && i + 1 < lines.length && lines[i + 1].startsWith('  - ')) {
      i++
      if (key === 'phases') {
        const items: PhaseDefinition[] = []
        let current: Partial<PhaseDefinition> | null = null

        while (i < lines.length) {
          const aLine = lines[i]
          if (aLine.startsWith('  - ')) {
            // New array item — flush current
            if (current) items.push(current as PhaseDefinition)
            current = {}
            // Parse the inline key: value after "  - "
            const rest = aLine.slice(4)
            const aColon = rest.indexOf(':')
            if (aColon !== -1) {
              const aKey = rest.slice(0, aColon).trim()
              const aVal = rest.slice(aColon + 1).trim().replace(/^["']|["']$/g, '')
              ;(current as Record<string, string>)[aKey] = aVal
            }
            i++
          } else if (aLine.startsWith('    ') && !aLine.startsWith('    - ')) {
            // Continuation key: value for current item
            if (current) {
              const aColon = aLine.indexOf(':')
              if (aColon !== -1) {
                const aKey = aLine.slice(0, aColon).trim()
                const aVal = aLine.slice(aColon + 1).trim().replace(/^["']|["']$/g, '')
                ;(current as Record<string, string>)[aKey] = aVal
              }
            }
            i++
          } else {
            break
          }
        }

        if (current) items.push(current as PhaseDefinition)

        result.phases = items.filter(
          (item): item is PhaseDefinition =>
            typeof item.key === 'string' &&
            typeof item.label === 'string' &&
            typeof item.description === 'string'
        )
      } else {
        // Skip unknown array fields
        while (i < lines.length && (lines[i].startsWith('  - ') || lines[i].startsWith('    '))) {
          i++
        }
      }
    } else {
      result.scalars[key] = rawValue.replace(/^["']|["']$/g, '')
      i++
    }
  }

  return result
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function scanCommands(commandsDir: string): CommandInfo[] {
  if (!fs.existsSync(commandsDir)) return []

  let files: string[]
  try {
    files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }

  return files.map((file) => {
    const slug = file.replace(/\.md$/, '')
    let name = slug
    let description = ''
    let phases: PhaseDefinition[] = []

    try {
      const content = fs.readFileSync(path.join(commandsDir, file), 'utf-8')
      const fm = parseFrontmatter(content)
      if (fm.scalars.name) name = fm.scalars.name
      if (fm.scalars.description) description = fm.scalars.description
      phases = fm.phases
    } catch {
      // Use filename-derived name if frontmatter parsing fails
    }

    return {
      id: slug,
      name,
      description,
      slug,
      phases,
    }
  })
}

function loadPersistedConfig(db: any): { active: string | null; labelFilter: string } {
  try {
    const activeRow = db.prepare(`SELECT value FROM queue_state WHERE key = 'config.active_tracker'`).get() as { value: string } | undefined
    const labelRow = db.prepare(`SELECT value FROM queue_state WHERE key = 'config.label_filter'`).get() as { value: string } | undefined
    return {
      active: (activeRow?.value as 'github' | 'jira' | null) ?? null,
      labelFilter: labelRow?.value ?? '',
    }
  } catch {
    return { active: null, labelFilter: '' }
  }
}

export function getConfig(cwd: string, db?: any, projectName?: string): ProjectConfig {
  // Resolve project root.
  // In single-project mode: web-manager lives at <project>/specrails/web-manager/,
  // so we walk up two levels to find the project root.
  // In hub mode: cwd is the project root directly — we detect this by checking
  // if the .claude directory already lives at cwd.
  let projectRoot: string
  if (fs.existsSync(path.join(cwd, '.claude'))) {
    // cwd is already the project root (hub mode passes project.path directly)
    projectRoot = cwd
  } else {
    // Single-project mode: walk up two levels
    projectRoot = path.resolve(cwd, '../..')
  }
  const commandsDir = path.join(projectRoot, '.claude', 'commands', 'sr')
  const commands = scanCommands(commandsDir)

  const github = detectGithub()
  const jira = detectJira()
  const repo = getGitRepoName(projectRoot)

  const persisted = db ? loadPersistedConfig(db) : { active: null, labelFilter: '' }

  // Auto-detect active tracker if not persisted
  let active = persisted.active as 'github' | 'jira' | null
  if (!active) {
    if (github.authenticated) active = 'github'
    else if (jira.authenticated) active = 'jira'
  }

  return {
    project: {
      name: projectName ?? path.basename(projectRoot),
      repo: repo,
    },
    issueTracker: {
      github,
      jira,
      active,
      labelFilter: persisted.labelFilter,
    },
    commands,
  }
}

export interface IssueItem {
  number: number
  title: string
  labels: string[]
  body: string
  url?: string
}

export function fetchIssues(
  tracker: 'github' | 'jira',
  opts: { search?: string; label?: string; repo?: string | null }
): IssueItem[] {
  if (tracker === 'github') {
    const args = ['gh', 'issue', 'list', '--json', 'number,title,labels,body,url', '--limit', '50']
    if (opts.label) args.push('--label', opts.label)
    if (opts.search) args.push('--search', opts.search)

    const output = runCommand(args.join(' '))
    if (!output) return []

    try {
      const raw = JSON.parse(output) as Array<{
        number: number
        title: string
        labels: Array<{ name: string }>
        body: string
        url: string
      }>
      return raw.map((item) => ({
        number: item.number,
        title: item.title,
        labels: item.labels.map((l) => l.name),
        body: item.body ?? '',
        url: item.url,
      }))
    } catch {
      return []
    }
  }

  if (tracker === 'jira') {
    const jql = opts.search ? `summary ~ "${opts.search}"` : ''
    const args = ['jira', 'issue', 'list', '--plain', '--columns', 'KEY,SUMMARY,LABELS,STATUS']
    if (jql) args.push('--jql', jql)

    const output = runCommand(args.join(' '))
    if (!output) return []

    // Parse plain text output: KEY  SUMMARY  LABELS  STATUS
    const lines = output.split('\n').filter(Boolean)
    return lines.slice(1).map((line, idx) => {
      const parts = line.split('\t')
      return {
        number: idx + 1,
        title: parts[1]?.trim() ?? line,
        labels: parts[2] ? parts[2].split(',').map((l) => l.trim()) : [],
        body: '',
      }
    })
  }

  return []
}
