import { readdirSync } from 'node:fs'
import path from 'node:path'
import { AgentExecutionError } from './executor-types.js'

/** Admin rules outrank Gemini's persisted user approvals. No mode filter: the
 * policy still applies when user settings disable plan and Gemini falls back
 * to default mode. All tools outside this read-only set remain denied. */
export const GEMINI_READONLY_POLICY = `[[rule]]
toolName = ["read_file", "read_many_files", "list_directory", "glob", "grep_search"]
decision = "allow"
priority = 999

[[rule]]
toolName = "*"
decision = "deny"
priority = 998
`

export function assertGeminiAdminPolicyAvailable(options: { platform?: NodeJS.Platform; readDirectory?: (directory: string) => string[] } = {}): void {
  const platform = options.platform ?? process.platform
  const directory = platform === 'win32'
    ? path.win32.join('C:\\ProgramData\\gemini-cli', 'policies')
    : platform === 'darwin' ? '/Library/Application Support/GeminiCli/policies' : '/etc/gemini-cli/policies'
  let entries: string[]
  try { entries = (options.readDirectory ?? (directory => readdirSync(directory)))(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new AgentExecutionError('Cannot verify Gemini system policies for a read-only role. Check access to ' + directory, 'provider_capability_unsupported')
  }
  // Gemini deliberately ignores --admin-policy in the presence of system
  // policy files. Refuse that environment instead of bypassing its policies.
  if (entries.some(file => file.endsWith('.toml'))) throw new AgentExecutionError('Gemini system policies disable per-run admin policy enforcement. Select another provider for architect/reviewer, or ask the system administrator to configure a compatible environment: ' + directory, 'provider_capability_unsupported')
}
