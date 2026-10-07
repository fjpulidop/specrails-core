import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { McpServerSpec, SessionPolicy } from '../../domain/types.js'

/** TOML string literal (basic string) for a `-c key=value` override. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** TOML key segment: bare when possible, quoted otherwise. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)
}

/**
 * Names of MCP servers declared in the user's Codex config. `-c mcp_servers={}`
 * does not remove them (overrides merge), so isolation disables each one.
 */
export function declaredCodexMcpServers(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), '.codex')
  const file = path.join(home, 'config.toml')
  if (!existsSync(file)) return []
  const names = new Set<string>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*\[\s*mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(line)
    if (match) names.add(match[1] ? JSON.parse(`"${match[1]}"`) as string : match[2]!)
  }
  return [...names]
}

function serverOverrides(server: McpServerSpec): string[] {
  const key = `mcp_servers.${tomlKey(server.name)}`
  const values: string[] = [`${key}.enabled=true`]
  if (server.url) {
    values.push(`${key}.url=${tomlString(server.url)}`)
    for (const [header, value] of Object.entries(server.headers ?? {})) values.push(`${key}.http_headers.${tomlKey(header)}=${tomlString(value)}`)
  } else if (server.command) {
    values.push(`${key}.command=${tomlString(server.command)}`)
    values.push(`${key}.args=[${(server.args ?? []).map(tomlString).join(',')}]`)
    for (const [name, value] of Object.entries(server.env ?? {})) values.push(`${key}.env.${tomlKey(name)}=${tomlString(value)}`)
  }
  // Codex gates MCP tools it cannot classify; under approvalPolicy=never it refuses them.
  if (server.autoApprove) values.push(`${key}.default_tools_approval_mode="approve"`)
  return values
}

/**
 * `codex app-server` argv for a policy. Sandbox and approvals travel in the
 * JSON-RPC thread request; config-level switches go through `-c`.
 */
export function codexArgs(policy: SessionPolicy, declaredServers: readonly string[]): string[] {
  const overrides: string[] = []
  if (policy.subagents === 'disabled') overrides.push('features.multi_agent=false')
  const wanted = new Set(policy.mcp.servers.map((server) => server.name))
  if (!policy.mcp.inheritUserScope) {
    for (const name of declaredServers) if (!wanted.has(name)) overrides.push(`mcp_servers.${tomlKey(name)}.enabled=false`)
  }
  for (const server of policy.mcp.servers) overrides.push(...serverOverrides(server))
  return [...overrides.flatMap((value) => ['-c', value]), 'app-server', '--listen', 'stdio://']
}

export function codexSandbox(permissions: SessionPolicy['permissions']): 'danger-full-access' | 'workspace-write' | 'read-only' {
  return permissions === 'bypass' ? 'danger-full-access' : permissions === 'read-only' ? 'read-only' : 'workspace-write'
}
