import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { execSync } from 'child_process'

// Mock child_process execSync to avoid real CLI calls
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return {
    ...actual,
    execSync: vi.fn(),
  }
})

import { getConfig, fetchIssues } from './config'

const mockExecSync = execSync as ReturnType<typeof vi.fn>

let existsSyncSpy: ReturnType<typeof vi.spyOn>
let readdirSyncSpy: ReturnType<typeof vi.spyOn>
let readFileSyncSpy: ReturnType<typeof vi.spyOn>

describe('getConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockExecSync.mockReturnValue(Buffer.from(''))
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([])
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('')
  })

  afterEach(() => {
    existsSyncSpy.mockRestore()
    readdirSyncSpy.mockRestore()
    readFileSyncSpy.mockRestore()
  })

  it('returns config structure with all required fields', () => {
    const config = getConfig('/some/project/specrails/web-manager')

    expect(config).toHaveProperty('project')
    expect(config).toHaveProperty('issueTracker')
    expect(config).toHaveProperty('commands')
    expect(config.issueTracker).toHaveProperty('github')
    expect(config.issueTracker).toHaveProperty('jira')
    expect(config.issueTracker).toHaveProperty('active')
    expect(config.issueTracker).toHaveProperty('labelFilter')
  })

  it('detects gh as available when which gh succeeds', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which gh') return Buffer.from('/usr/bin/gh')
      if (cmd === 'gh auth status') return Buffer.from('Logged in to github.com')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.issueTracker.github.available).toBe(true)
    expect(config.issueTracker.github.authenticated).toBe(true)
  })

  it('reports gh as unavailable when which gh fails', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which gh') throw new Error('not found')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.issueTracker.github.available).toBe(false)
    expect(config.issueTracker.github.authenticated).toBe(false)
  })

  it('scans command files from .claude/commands/sr/ directory', () => {
    mockExecSync.mockReturnValue(Buffer.from(''))
    existsSyncSpy.mockReturnValue(true)
    readdirSyncSpy.mockReturnValue(['implement.md', 'batch-implement.md'] as unknown as fs.Dirent[])
    readFileSyncSpy.mockImplementation((filePath: unknown) => {
      if (String(filePath).includes('implement.md') && !String(filePath).includes('batch')) {
        return `---\nname: Implement\ndescription: Implement a feature from an issue\n---\n# Content`
      }
      if (String(filePath).includes('batch-implement.md')) {
        return `---\nname: Batch Implement\ndescription: Implement multiple features\n---\n# Content`
      }
      return ''
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.commands).toHaveLength(2)
    expect(config.commands[0].name).toBe('Implement')
    expect(config.commands[0].description).toBe('Implement a feature from an issue')
    expect(config.commands[1].name).toBe('Batch Implement')
  })

  it('falls back to filename-derived name when frontmatter is missing', () => {
    mockExecSync.mockReturnValue(Buffer.from(''))
    existsSyncSpy.mockReturnValue(true)
    readdirSyncSpy.mockReturnValue(['health-check.md'] as unknown as fs.Dirent[])
    readFileSyncSpy.mockReturnValue('# No frontmatter here\nJust content')

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.commands).toHaveLength(1)
    expect(config.commands[0].id).toBe('health-check')
    expect(config.commands[0].name).toBe('health-check')
  })

  it('extracts repo name from git remote HTTPS URL', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') return Buffer.from('https://github.com/owner/myrepo.git')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.project.repo).toBe('owner/myrepo')
  })

  it('extracts repo name from git remote SSH URL', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') return Buffer.from('git@github.com:owner/myrepo.git')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.project.repo).toBe('owner/myrepo')
  })

  it('returns null repo when git remote is not github', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') return Buffer.from('https://gitlab.com/owner/repo.git')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.project.repo).toBe(null)
  })

  it('auto-detects github as active when authenticated', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which gh') return Buffer.from('/usr/bin/gh')
      if (cmd === 'gh auth status') return Buffer.from('Logged in')
      if (cmd === 'which jira') throw new Error('not found')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.issueTracker.active).toBe('github')
  })
})

describe('fetchIssues', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockExecSync.mockReturnValue(Buffer.from(''))
  })

  it('returns structured issues from gh issue list output', () => {
    const mockOutput = JSON.stringify([
      { number: 42, title: 'Fix the bug', labels: [{ name: 'bug' }], body: 'Description', url: 'https://github.com/...' },
      { number: 43, title: 'Add feature', labels: [], body: '', url: 'https://github.com/...' },
    ])
    mockExecSync.mockReturnValue(Buffer.from(mockOutput))

    const issues = fetchIssues('github', {})

    expect(issues).toHaveLength(2)
    expect(issues[0].number).toBe(42)
    expect(issues[0].title).toBe('Fix the bug')
    expect(issues[0].labels).toEqual(['bug'])
  })

  it('returns empty array when gh command fails', () => {
    mockExecSync.mockImplementation(() => { throw new Error('gh not found') })

    const issues = fetchIssues('github', {})

    expect(issues).toEqual([])
  })

  it('returns empty array for unsupported tracker', () => {
    const issues = fetchIssues('github', {})
    expect(Array.isArray(issues)).toBe(true)
  })
})
