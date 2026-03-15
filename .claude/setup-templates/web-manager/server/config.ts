import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

export interface CommandInfo {
  id: string
  name: string
  description: string
  slug: string
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

function runCommand(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim()
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

function getGitRepoName(): string | null {
  const output = runCommand('git remote get-url origin')
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

function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return result

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (key) result[key] = value
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

    try {
      const content = fs.readFileSync(path.join(commandsDir, file), 'utf-8')
      const fm = parseFrontmatter(content)
      if (fm.name) name = fm.name
      if (fm.description) description = fm.description
    } catch {
      // Use filename-derived name if frontmatter parsing fails
    }

    return {
      id: slug,
      name,
      description,
      slug,
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
  // Commands are in the project's .claude/commands/sr/ directory
  // The web-manager lives at <project>/specrails/web-manager/, so project root is two levels up
  const projectRoot = path.resolve(cwd, '../..')
  const commandsDir = path.join(projectRoot, '.claude', 'commands', 'sr')
  const commands = scanCommands(commandsDir)

  const github = detectGithub()
  const jira = detectJira()
  const repo = getGitRepoName()

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
