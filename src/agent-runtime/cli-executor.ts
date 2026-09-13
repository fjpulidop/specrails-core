import { codexOutputSchema, restoreOptionalFields } from './codex-schema.js'
import { assertEffortSupported, cliCapabilities } from './capabilities.js'
import { providerDiagnostic } from './provider-diagnostic.js'
import { toolEvent } from './tool-event.js'
import { openSpecPrompt, writeOpenSpecBridge } from './openspec.js'
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sumCacheUsage, type CacheTokenUsage } from './efficiency-types.js'
import { normalizeKimiCliModel } from '../installer/runtime/kimi.js'
import { AgentExecutionError, unknownUsage, validateAgentRequest, type AgentEvent, type AgentExecutor, type AgentLimits, type AgentRequest, type AgentResult, type AgentUsage, type CliProvider } from './executor-types.js'
import { runCliProcess, type CliInvocation, type CliProcessRunner } from './cli-process.js'
import { canonicalWorkspace } from './workspace-tools.js'
import { parseStructuredText } from './openai-executor.js'
import { executeKimiReadonlyAcp } from './kimi-acp.js'
import { assertGeminiAdminPolicyAvailable, GEMINI_READONLY_POLICY } from './gemini-policy.js'

export interface CliExecutorOptions { runProcess?: CliProcessRunner; env?: NodeJS.ProcessEnv }
export interface CliInvocationOptions { kimiAgentFile?: string; geminiPolicyFile?: string; codexSchemaFile?: string; openspecBridge?: { command: string; args: string[] }; mcpConfigFile?: string }
/** Tools a Claude developer may not use: nested agents and platform skills would start a second, unobserved workflow. */
const CLAUDE_DEVELOPER_DISALLOWED = 'Agent,Task,Skill'

/**
 * Build the exact argv for one role. Read-only roles use each CLI's native
 * read-only boundary. The developer role gets the same autonomy the legacy
 * Implement step had (edits and shell inside the CLI's own sandbox), because a
 * developer that cannot run tests iterates blind and fails verification.
 */
export function buildCliInvocation(provider: CliProvider, request: AgentRequest, options: CliInvocationOptions = {}): CliInvocation {
  const readOnly = request.role !== 'developer'
  const model = request.model ? ['--model', request.model] : []
  const extraRoots = request.allowedRoots.filter(root => root !== request.cwd)
  const resume = request.resumeSessionId
  switch (provider) {
    case 'claude': return { command: 'claude', stdin: request.prompt, args: [
      '-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(request.maxTurns ?? 100), ...model,
      ...(request.effort === undefined ? [] : ['--effort', request.effort]),
      // Project instructions and rules stay visible; the user's global config,
      // memory and plugins never leak into an autonomous role.
      '--setting-sources', 'project,local',
      ...(readOnly
        ? ['--tools', options.mcpConfigFile ? 'Read,Grep,Glob,ToolSearch' : 'Read,Grep,Glob', '--permission-mode', options.mcpConfigFile ? 'dontAsk' : 'plan', '--strict-mcp-config', ...(options.mcpConfigFile ? ['--allowedTools', 'Read,Grep,Glob,ToolSearch,mcp__specrails_openspec__workflow,mcp__specrails_openspec__read_verification_evidence'] : [])]
        : ['--tools', 'default', '--disallowedTools', CLAUDE_DEVELOPER_DISALLOWED, '--dangerously-skip-permissions']),
      ...(options.mcpConfigFile ? ['--mcp-config', options.mcpConfigFile] : []),
      ...(request.outputSchema ? ['--json-schema', JSON.stringify(request.outputSchema)] : []),
      ...(request.maxCostUsd === undefined ? [] : ['--max-budget-usd', String(request.maxCostUsd)]),
      ...extraRoots.flatMap(root => ['--add-dir', root]),
      ...(resume ? ['--resume', resume] : []),
    ] }
    case 'codex': {
      const sandbox = readOnly ? 'read-only' : 'workspace-write'
      const common = ['--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', ...model,
        ...(request.effort === undefined ? [] : ['-c', 'model_reasoning_effort=' + JSON.stringify(request.effort)]),
        ...(options.openspecBridge ? ['-c', 'mcp_servers.specrails_openspec.command=' + JSON.stringify(options.openspecBridge.command), '-c', 'mcp_servers.specrails_openspec.args=' + JSON.stringify(options.openspecBridge.args), '-c', 'mcp_servers.specrails_openspec.default_tools_approval_mode="approve"', '-c', 'mcp_servers.specrails_openspec.required=true'] : []),
      ]
      // `codex exec resume` has no --sandbox flag; the same policy travels as a config override.
      if (resume) return { command: 'codex', stdin: request.prompt, args: ['exec', 'resume', ...common, '-c', `sandbox_mode="${sandbox}"`, '-c', 'sandbox_workspace_write.writable_roots=' + JSON.stringify(readOnly ? [] : request.allowedRoots), resume, '-'] }
      return { command: 'codex', stdin: request.prompt, args: [
        'exec', ...common, '--sandbox', sandbox,
        ...(options.codexSchemaFile ? ['--output-schema', options.codexSchemaFile] : []),
        ...extraRoots.flatMap(root => ['--add-dir', root]), '-',
      ] }
    }
    case 'gemini': {
      if (readOnly && !options.geminiPolicyFile) throw new AgentExecutionError('Gemini architect/reviewer roles require --admin-policy support for an enforced read-only tool allowlist. Upgrade Gemini CLI or select another provider for this role.', 'provider_capability_unsupported')
      return { command: 'gemini', stdin: request.prompt, args: [
        '-p', 'Execute the task supplied on stdin.', '--output-format', 'stream-json', ...model,
        // Headless Gemini cannot answer shell approvals; the developer runs with
        // auto-approval exactly as the legacy Implement step did.
        ...(readOnly ? ['--approval-mode', 'plan'] : ['--yolo']),
        ...(options.geminiPolicyFile ? ['--admin-policy', options.geminiPolicyFile] : []),
        ...extraRoots.flatMap(root => ['--include-directories', root]),
        ...(resume ? ['--resume', resume] : []),
      ] }
    }
    case 'kimi': {
      if (readOnly && !options.kimiAgentFile) throw new AgentExecutionError('Kimi read-only print mode requires --agent-file and enforced tool allowlists. Use CliExecutor to select the ACP read-only transport on older CLIs.', 'provider_capability_unsupported')
      return { command: 'kimi', args: [
        ...(request.model ? ['-m', normalizeKimiCliModel(request.model)] : []),
        ...(resume ? [`--session=${resume}`] : []),
        '-p', request.prompt, '--output-format', 'stream-json',
        ...(options.kimiAgentFile ? ['--agent-file', options.kimiAgentFile] : []),
        ...extraRoots.flatMap(root => ['--add-dir', root]),
      ] }
    }
  }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null }
function textBlocks(value: unknown): string {
  return Array.isArray(value) ? value.map(raw => object(raw)).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : ''
}
function claudeCacheUsage(reported: Record<string, unknown>): CacheTokenUsage {
  if (reported.cache_read_input_tokens === undefined && reported.cache_creation_input_tokens === undefined) return {}
  return { uncachedInputTokens: number(reported.input_tokens), cacheReadInputTokens: number(reported.cache_read_input_tokens), cacheWriteInputTokens: number(reported.cache_creation_input_tokens) }
}
function inclusiveCacheUsage(reported: Record<string, unknown>): CacheTokenUsage {
  const cached = number(reported.cached_input_tokens), input = number(reported.input_tokens)
  if (reported.cached_input_tokens === undefined) return {}
  return { cacheReadInputTokens: cached !== null && input !== null && cached <= input ? cached : null, uncachedInputTokens: cached !== null && input !== null && cached <= input ? input - cached : null, cacheWriteInputTokens: null }
}
interface ParsedCliResult extends AgentResult { terminal: boolean; failed: boolean; turns: number; failureKind?: 'max_turns' | 'cost_budget' | 'structured_output_retries' }
export function parseCliOutput(provider: CliProvider, stdout: string): ParsedCliResult {
  let text = '', terminal = false, failed = false, sessionId: string | undefined, turns = 0
  let usage = unknownUsage()
  let failureKind: ParsedCliResult['failureKind']
  let structured: Record<string, unknown> | undefined
  const claudeMessages = new Map<string, AgentUsage>()
  for (const line of stdout.split(/\r?\n/)) {
    let event: Record<string, unknown>
    try { event = object(JSON.parse(line)) } catch { continue }
    if (typeof event.session_id === 'string') sessionId = event.session_id
    if (typeof event.thread_id === 'string') sessionId = event.thread_id
    if (['error', 'turn.failed', 'system.error'].includes(String(event.type))) failed = true
    if (provider === 'claude') {
      if (event.type === 'assistant') {
        const message = object(event.message), reported = object(message.usage)
        const messageText = textBlocks(message.content)
        if (messageText) text = messageText
        const id = typeof message.id === 'string' ? message.id : `anonymous-${claudeMessages.size}`
        const input = number(reported.input_tokens)
        claudeMessages.set(id, { inputTokens: input === null ? null : input + (number(reported.cache_read_input_tokens) ?? 0) + (number(reported.cache_creation_input_tokens) ?? 0), outputTokens: number(reported.output_tokens), costUsd: null, ...claudeCacheUsage(reported) })
        turns = claudeMessages.size
      }
      if (event.type === 'result' && object(event.origin).kind !== 'task-notification') {
        terminal = true
        failed ||= event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')
        if (event.subtype === 'error_max_turns') failureKind = 'max_turns'
        if (event.subtype === 'error_max_budget_usd') failureKind = 'cost_budget'
        if (event.subtype === 'error_max_structured_output_retries') failureKind = 'structured_output_retries'
        if (typeof event.result === 'string') text = event.result
        // --json-schema returns the validated object separately from the text.
        if (event.structured_output && typeof event.structured_output === 'object' && !Array.isArray(event.structured_output)) structured = event.structured_output as Record<string, unknown>
        const reported = object(event.usage), input = number(reported.input_tokens)
        usage = { inputTokens: input === null ? null : input + (number(reported.cache_read_input_tokens) ?? 0) + (number(reported.cache_creation_input_tokens) ?? 0), outputTokens: number(reported.output_tokens), costUsd: number(event.total_cost_usd), ...claudeCacheUsage(reported) }
      }
    } else if (provider === 'codex') {
      if (event.type === 'turn.failed' || event.type === 'error') failed = true
      if (event.type === 'item.completed') {
        const item = object(event.item)
        if (item.type === 'agent_message' && typeof item.text === 'string') text = item.text
        if (item.type === 'agent_message' || ['command_execution', 'mcp_tool_call', 'function_call', 'local_shell_call'].includes(String(item.type))) turns++
      }
      if (event.type === 'turn.completed') { terminal = true; failed = false; const reported = object(event.usage); usage = { inputTokens: number(reported.input_tokens), outputTokens: number(reported.output_tokens), costUsd: null, ...inclusiveCacheUsage(reported) } }
    } else if (provider === 'gemini') {
      if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') { text += event.content; if (!event.delta) turns++ }
      // Assistant deltas before a tool belong to an intermediate turn. Keep
      // streaming them to observers, but return only the final response.
      if (event.type === 'tool_use') { turns++; text = '' }
      if (event.type === 'result') {
        terminal = true; failed ||= event.status !== 'success'
        const reported = object(event.stats); usage = { inputTokens: number(reported.input_tokens), outputTokens: number(reported.output_tokens), costUsd: null }
      }
    } else {
      if (event.role === 'assistant') { turns++; const content = typeof event.content === 'string' ? event.content : textBlocks(event.content); if (content) text = content }
      if (event.type === 'session.resume_hint') terminal = true
    }
  }
  if (provider === 'claude' && !terminal && claudeMessages.size) {
    const messages = [...claudeMessages.values()]
    usage = { inputTokens: messages.some(message => message.inputTokens === null) ? null : messages.reduce((sum, message) => sum + (message.inputTokens ?? 0), 0), outputTokens: messages.some(message => message.outputTokens === null) ? null : messages.reduce((sum, message) => sum + (message.outputTokens ?? 0), 0), costUsd: null, ...sumCacheUsage(messages) }
  }
  if (structured && !text.trim()) text = JSON.stringify(structured)
  return { text, terminal, failed, turns, usage, sessionId, structured: structured ?? parseStructuredText(text), ...(failureKind ? { failureKind } : {}) }
}
/** Live tool activity for one streamed JSON line, or undefined when the line carries none. */
export function cliToolEvents(provider: CliProvider, event: Record<string, unknown>): AgentEvent[] {
  if (provider === 'claude' && event.type === 'assistant') {
    const content = object(event.message).content
    return Array.isArray(content) ? content.map(object).filter(block => block.type === 'tool_use' && typeof block.name === 'string').map(block => toolEvent(String(block.name), block.input)) : []
  }
  if (provider === 'codex' && event.type === 'item.started') {
    const item = object(event.item)
    if (['command_execution', 'local_shell_call'].includes(String(item.type))) return [toolEvent('shell', { command: item.command, cwd: item.cwd })]
    if (['mcp_tool_call', 'function_call'].includes(String(item.type))) return [toolEvent(typeof item.name === 'string' ? item.name : 'tool', item.arguments)]
    if (item.type === 'file_change') return [toolEvent('edit', { paths: Array.isArray(item.changes) ? item.changes.map(change => object(change).path) : [] })]
    return []
  }
  if (provider === 'gemini' && event.type === 'tool_use') return [toolEvent(typeof event.tool_name === 'string' ? event.tool_name : 'tool', event.parameters)]
  if (provider === 'kimi' && event.role === 'assistant' && Array.isArray(event.tool_calls)) {
    return event.tool_calls.map(object).map(call => { const fn = object(call.function); let input: unknown; try { input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments } catch { input = undefined } return toolEvent(typeof fn.name === 'string' ? fn.name : 'tool', input) })
  }
  return []
}
export class CliExecutor implements AgentExecutor {
  constructor(private readonly provider: CliProvider, private readonly options: CliExecutorOptions = {}) {}
  capabilities(model?: string) { return cliCapabilities(this.provider, model, this.options) }
  private readonly capabilityChecks = new Map<string, Promise<void>>()
  async validateOpenSpec(context: import('./openspec.js').OpenSpecRoleContext): Promise<void> {
    const key = context.role === 'developer' ? 'write' : 'read'
    let checked = this.capabilityChecks.get(key)
    if (!checked) {
      checked = (async () => {
        if (this.provider === 'gemini' && key === 'read') assertGeminiAdminPolicyAvailable()
        const help = await (this.options.runProcess ?? runCliProcess)({ command: this.provider, args: this.provider === 'kimi' ? ['acp', '--help'] : ['--help'] }, { cwd: context.root, timeoutMs: 10000, env: this.options.env })
        const flags = this.provider === 'claude' ? ['--mcp-config', '--allowedTools'] : this.provider === 'codex' ? ['--config'] : this.provider === 'gemini' && key === 'read' ? ['--admin-policy'] : []
        if (help.exitCode !== 0 || flags.some(flag => !help.stdout.includes(flag))) throw new AgentExecutionError(`The installed ${this.provider} CLI lacks the required OpenSpec transport. Upgrade this CLI or select another provider.`, 'provider_capability_unsupported')
      })()
      this.capabilityChecks.set(key, checked)
    }
    await checked
  }
  validateLimits(limits: AgentLimits): void {
    if (limits.maxCostUsd !== undefined && this.provider !== 'claude') throw new AgentExecutionError(`A strict USD cap is unsupported by the ${this.provider} CLI. Use Claude's native cap or remove the dollar cap.`, 'cost_limit_unsupported')
    if (limits.maxTokens !== undefined && this.provider === 'kimi') throw new AgentExecutionError('Kimi does not report authoritative token usage. Remove the token cap or select another provider for this role.', 'usage_unavailable')
  }
  async execute(request: AgentRequest): Promise<AgentResult> {
    validateAgentRequest(request)
    if (request.effort !== undefined) assertEffortSupported(request, await this.capabilities(request.model))
    this.validateLimits(request)
    const scope = canonicalWorkspace(request.cwd, request.allowedRoots)
    const normalized = { ...request, prompt: (request.openspec ? openSpecPrompt(request.openspec) : '') + request.prompt, cwd: scope.cwd, allowedRoots: scope.roots }
    const runner = this.options.runProcess ?? runCliProcess
    let temporary: string | undefined, kimiAgentFile: string | undefined, geminiPolicyFile: string | undefined, codexSchemaFile: string | undefined, stream = '', turns = 0
    const assistantIds = new Set<string>()
    const scratch = (): string => temporary ??= mkdtempSync(path.join(tmpdir(), 'specrails-' + this.provider + '-role-'))
    try {
      const openspecBridge = request.openspec ? writeOpenSpecBridge(request.openspec, scratch()) : undefined
      let mcpConfigFile: string | undefined
      let executionEnv = this.options.env
      if (openspecBridge) {
        mcpConfigFile = path.join(scratch(), 'mcp.json')
        writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { specrails_openspec: openspecBridge } }), { mode: 0o600 })
        if (this.provider === 'gemini') {
          const env = this.options.env ?? process.env
          const systemPath = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? (process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json' : process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json')
          const settings = existsSync(systemPath) ? JSON.parse(readFileSync(systemPath, 'utf8')) : {}
          if (settings.mcp?.allowed || settings.mcp?.excluded || settings.admin?.mcp?.enabled === false) throw new AgentExecutionError('Gemini administrator MCP restrictions require explicit OpenSpec server admission', 'provider_capability_unsupported')
          writeFileSync(mcpConfigFile, JSON.stringify({ ...settings, mcpServers: { ...settings.mcpServers, specrails_openspec: { ...openspecBridge, trust: true, includeTools: ['workflow', 'read_verification_evidence'] } } }), { mode: 0o600 })
          executionEnv = { ...env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: mcpConfigFile }
        }
        if (this.provider === 'kimi') return await executeKimiReadonlyAcp(normalized, { ...this.options, openspecBridge })
      }
      if (this.provider === 'gemini' && request.role !== 'developer') {
        assertGeminiAdminPolicyAvailable()
        const help = await runner({ command: 'gemini', args: ['--help'] }, { cwd: scope.cwd, signal: request.signal, timeoutMs: 10_000, env: this.options.env })
        if (help.exitCode !== 0 || !help.stdout.includes('--admin-policy')) throw new AgentExecutionError('Gemini architect/reviewer roles require --admin-policy support for an enforced read-only tool allowlist. Upgrade Gemini CLI or select another provider for this role.', 'provider_capability_unsupported')
        geminiPolicyFile = path.join(scratch(), 'readonly.toml')
        writeFileSync(geminiPolicyFile, (openspecBridge ? '[[rule]]\nmcpName = "specrails_openspec"\ntoolName = "workflow"\ndecision = "allow"\npriority = 1000\n\n[[rule]]\nmcpName = "specrails_openspec"\ntoolName = "read_verification_evidence"\ndecision = "allow"\npriority = 1000\n\n' : '') + GEMINI_READONLY_POLICY, { mode: 0o600 })
      }
      if (this.provider === 'kimi' && request.role !== 'developer') {
        const help = await runner({ command: 'kimi', args: ['--help'] }, { cwd: scope.cwd, signal: request.signal, timeoutMs: 10_000, env: this.options.env })
        if (help.exitCode !== 0) throw new AgentExecutionError('Cannot detect Kimi CLI capabilities', 'provider_capability_unsupported')
        if (!help.stdout.includes('--agent-file')) return await executeKimiReadonlyAcp(request, this.options)
        kimiAgentFile = path.join(scratch(), 'readonly.md')
        writeFileSync(kimiAgentFile, '---\nname: specrails-readonly\ndescription: Execute one read-only Specrails role\ntools:\n  - Read\n  - Grep\n  - Glob\nsubagents: []\n---\nExecute the supplied task and return its complete result. All instructions are supplied in the task.\n', { mode: 0o600 })
      }
      if (this.provider === 'codex' && request.outputSchema && !request.resumeSessionId) {
        codexSchemaFile = path.join(scratch(), 'output-schema.json')
        writeFileSync(codexSchemaFile, JSON.stringify(codexOutputSchema(request.outputSchema)), { mode: 0o600 })
      }
      const result = await runner(buildCliInvocation(this.provider, normalized, { kimiAgentFile, geminiPolicyFile, codexSchemaFile, openspecBridge, mcpConfigFile }), {
        cwd: scope.cwd, signal: request.signal, timeoutMs: request.timeoutMs ?? 15 * 60_000, env: executionEnv,
        onLine: line => {
          stream += line + '\n'
          let event: Record<string, unknown>
          try { event = object(JSON.parse(line)) } catch { return }
          let delta = ''
          if (this.provider === 'claude' && event.type === 'assistant') {
            const message = object(event.message)
            const id = typeof message.id === 'string' ? message.id : `anonymous-${turns}`
            if (!assistantIds.has(id)) { assistantIds.add(id); turns++ }
            delta = textBlocks(message.content)
          } else if (this.provider === 'codex' && event.type === 'item.completed') {
            const item = object(event.item)
            if (item.type === 'agent_message' || ['command_execution', 'mcp_tool_call', 'function_call', 'local_shell_call'].includes(String(item.type))) turns++
            if (item.type === 'agent_message' && typeof item.text === 'string') delta = item.text
          } else if (this.provider === 'gemini') {
            if (event.type === 'tool_use') turns++
            if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') delta = event.content
          } else if (this.provider === 'kimi' && event.role === 'assistant') { turns++; delta = typeof event.content === 'string' ? event.content : textBlocks(event.content) }
          if (turns > (request.maxTurns ?? 100)) throw new AgentExecutionError('CLI exceeded its configured turn/tool limit', 'max_turns', parseCliOutput(this.provider, stream).usage)
          for (const tool of cliToolEvents(this.provider, event)) request.onEvent?.(tool)
          if (delta) request.onEvent?.({ kind: 'text', text: delta })
        },
      })
      const parsed = parseCliOutput(this.provider, result.stdout)
      request.onEvent?.({ kind: 'usage', usage: parsed.usage })
      if (parsed.failureKind) {
        const message = parsed.failureKind === 'max_turns'
          ? `${this.provider} reached the configured limit of ${request.maxTurns ?? 100} turns for ${request.role}. Inspect partial changes before recovery; a higher limit requires a new run configuration.`
          : parsed.failureKind === 'cost_budget' ? `${this.provider} reached its configured cost budget.` : `${this.provider} exhausted structured output retries.`
        throw new AgentExecutionError(message, parsed.failureKind, parsed.usage)
      }
      if (result.exitCode !== 0 || parsed.failed) {
        const diagnostic = providerDiagnostic(result.stdout, result.stderr, { ...process.env, ...this.options.env })
        throw new AgentExecutionError(`${this.provider} execution failed${result.exitCode !== 0 ? ` (exit ${result.exitCode})` : ''}.${diagnostic ? ' ' + diagnostic : ' The provider did not report a diagnostic.'}`, 'provider_execution_error', parsed.usage)
      }
      if (!parsed.terminal || !parsed.text.trim()) throw new AgentExecutionError(`${this.provider} exited without a successful final result`, 'incomplete_response', parsed.usage)
      if (request.maxTokens !== undefined) {
        if (parsed.usage.inputTokens === null || parsed.usage.outputTokens === null) throw new AgentExecutionError(`${this.provider} did not report usage needed for the token limit`, 'usage_unavailable', parsed.usage)
        if (parsed.usage.inputTokens + parsed.usage.outputTokens > request.maxTokens) throw new AgentExecutionError('Agent token budget exceeded', 'token_budget', parsed.usage)
      }
      // The final text was already streamed as it arrived; re-emitting it would
      // print every summary twice in host logs.
      if (this.provider === 'codex' && request.outputSchema && parsed.structured) {
        parsed.structured = restoreOptionalFields(parsed.structured, request.outputSchema) as Record<string, unknown>
        parsed.text = JSON.stringify(parsed.structured)
      }
      return { text: parsed.text, usage: parsed.usage, sessionId: parsed.sessionId, structured: parsed.structured }
    } catch (error) {
      if (error instanceof AgentExecutionError) {
        const usage = parseCliOutput(this.provider, stream).usage
        if (error.usage.inputTokens === null && usage.inputTokens !== null) throw new AgentExecutionError(error.message, error.code, usage)
      }
      throw error
    } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }) }
  }
}
