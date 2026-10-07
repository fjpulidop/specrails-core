import type { McpServerSpec } from '../../domain/types.js'
import type { DriverOpenSpec } from '../../ports.js'

/** Tools that launch sub-agents in Claude Code; removed when policy disables sub-agents. */
export const CLAUDE_SUBAGENT_TOOLS = ['Agent', 'Task'] as const
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const

function mcpConfig(servers: readonly McpServerSpec[]): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, server.url
      ? { type: 'http', url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
      : { command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) }])),
  })
}

/**
 * Map an open spec + policy to Claude Code argv. Lists are passed as one
 * comma-separated argument (variadic flags would otherwise swallow later args).
 * `systemPromptFile` is used instead of an inline prompt when provided
 * (long prompts / Windows command-line limits).
 */
export function claudeArgs(spec: DriverOpenSpec, options: { systemPromptFile?: string } = {}): string[] {
  const policy = spec.policy
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--setting-sources', 'project,local',
    '--model', spec.model,
  ]
  if (spec.effort) args.push('--effort', spec.effort)
  if (options.systemPromptFile) args.push('--system-prompt-file', options.systemPromptFile)
  else if (spec.systemPrompt) args.push('--system-prompt', spec.systemPrompt)

  if (policy.permissions === 'bypass') args.push('--dangerously-skip-permissions')
  else args.push('--permission-mode', policy.permissions === 'read-only' ? 'plan' : 'acceptEdits')

  if (policy.tools.mode === 'none') args.push('--tools', '')
  else if (policy.tools.mode === 'read-only') args.push('--tools', CLAUDE_READ_ONLY_TOOLS.join(','))
  if (policy.tools.allow?.length) args.push('--allowedTools', policy.tools.allow.join(','))
  const denied = [...new Set([...(policy.tools.deny ?? []), ...(policy.subagents === 'disabled' ? CLAUDE_SUBAGENT_TOOLS : [])])]
  if (denied.length) args.push('--disallowedTools', denied.join(','))

  if (policy.mcp.servers.length) args.push('--mcp-config', mcpConfig(policy.mcp.servers))
  if (!policy.mcp.inheritUserScope) args.push('--strict-mcp-config')

  if (spec.providerSessionRef) args.push('--resume', spec.providerSessionRef)
  return args
}
