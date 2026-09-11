import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeKimiCliModel } from '../installer/runtime/kimi.js'
import { AgentExecutionError, unknownUsage, validateAgentRequest, type AgentEvent, type AgentExecutor, type AgentLimits, type AgentRequest, type AgentResult, type AgentUsage, type CliProvider } from './executor-types.js'
import { runCliProcess, type CliInvocation, type CliProcessRunner } from './cli-process.js'
import { canonicalWorkspace } from './workspace-tools.js'
import { parseStructuredText } from './openai-executor.js'
import { executeKimiReadonlyAcp } from './kimi-acp.js'
import { assertGeminiAdminPolicyAvailable, GEMINI_READONLY_POLICY } from './gemini-policy.js'

export interface CliExecutorOptions { runProcess?: CliProcessRunner; env?: NodeJS.ProcessEnv }
export interface CliInvocationOptions { kimiAgentFile?: string; geminiPolicyFile?: string; codexSchemaFile?: string }
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
      '-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(request.maxTurns ?? 24), ...model,
      // Project instructions and rules stay visible; the user's global config,
      // memory and plugins never leak into an autonomous role.
      '--setting-sources', 'project,local',
      ...(readOnly
        ? ['--tools', 'Read,Grep,Glob', '--permission-mode', 'plan', '--strict-mcp-config']
        : ['--tools', 'default', '--disallowedTools', CLAUDE_DEVELOPER_DISALLOWED, '--dangerously-skip-permissions']),
      ...(request.outputSchema ? ['--json-schema', JSON.stringify(request.outputSchema)] : []),
      ...(request.maxCostUsd === undefined ? [] : ['--max-budget-usd', String(request.maxCostUsd)]),
      ...extraRoots.flatMap(root => ['--add-dir', root]),
      ...(resume ? ['--resume', resume] : []),
    ] }
    case 'codex': {
      const sandbox = readOnly ? 'read-only' : 'workspace-write'
      const common = ['--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', ...model]
      // `codex exec resume` has no --sandbox flag; the same policy travels as a config override.
      if (resume) return { command: 'codex', stdin: request.prompt, args: ['exec', 'resume', ...common, '-c', `sandbox_mode="${sandbox}"`, resume, '-'] }
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
function shorten(value: unknown, limit = 160): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > limit ? single.slice(0, limit - 1) + '…' : single
}
/** Short, human-readable tool activity for host logs; never a transcript. */
function toolEvent(tool: string, input: unknown): AgentEvent {
  const args = object(input)
  const detail = shorten(args.file_path ?? args.path ?? args.command ?? args.pattern ?? args.query ?? args.notebook_path ?? args.url)
  return { kind: 'tool-start', tool, ...(detail ? { detail } : {}) }
}
interface ParsedCliResult extends AgentResult { terminal: boolean; failed: boolean; turns: number }
export function parseCliOutput(provider: CliProvider, stdout: string): ParsedCliResult {
  let text = '', terminal = false, failed = false, sessionId: string | undefined, turns = 0
  let usage = unknownUsage()
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
        claudeMessages.set(id, { inputTokens: input === null ? null : input + (number(reported.cache_read_input_tokens) ?? 0) + (number(reported.cache_creation_input_tokens) ?? 0), outputTokens: number(reported.output_tokens), costUsd: null })
        turns = claudeMessages.size
      }
      if (event.type === 'result' && object(event.origin).kind !== 'task-notification') {
        terminal = true
        failed ||= event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')
        if (typeof event.result === 'string') text = event.result
        // --json-schema returns the validated object separately from the text.
        if (event.structured_output && typeof event.structured_output === 'object' && !Array.isArray(event.structured_output)) structured = event.structured_output as Record<string, unknown>
        const reported = object(event.usage), input = number(reported.input_tokens)
        usage = { inputTokens: input === null ? null : input + (number(reported.cache_read_input_tokens) ?? 0) + (number(reported.cache_creation_input_tokens) ?? 0), outputTokens: number(reported.output_tokens), costUsd: number(event.total_cost_usd) }
      }
    } else if (provider === 'codex') {
      if (event.type === 'item.completed') {
        const item = object(event.item)
        if (item.type === 'agent_message' && typeof item.text === 'string') text = item.text
        if (item.type === 'agent_message' || ['command_execution', 'mcp_tool_call', 'function_call', 'local_shell_call'].includes(String(item.type))) turns++
      }
      if (event.type === 'turn.completed') { terminal = true; const reported = object(event.usage); usage = { inputTokens: number(reported.input_tokens), outputTokens: number(reported.output_tokens), costUsd: null } }
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
    usage = { inputTokens: messages.some(message => message.inputTokens === null) ? null : messages.reduce((sum, message) => sum + (message.inputTokens ?? 0), 0), outputTokens: messages.some(message => message.outputTokens === null) ? null : messages.reduce((sum, message) => sum + (message.outputTokens ?? 0), 0), costUsd: null }
  }
  if (structured && !text.trim()) text = JSON.stringify(structured)
  return { text, terminal, failed, turns, usage, sessionId, structured: structured ?? parseStructuredText(text) }
}
/** Live tool activity for one streamed JSON line, or undefined when the line carries none. */
export function cliToolEvents(provider: CliProvider, event: Record<string, unknown>): AgentEvent[] {
  if (provider === 'claude' && event.type === 'assistant') {
    const content = object(event.message).content
    return Array.isArray(content) ? content.map(object).filter(block => block.type === 'tool_use' && typeof block.name === 'string').map(block => toolEvent(String(block.name), block.input)) : []
  }
  if (provider === 'codex' && event.type === 'item.started') {
    const item = object(event.item)
    if (['command_execution', 'local_shell_call'].includes(String(item.type))) return [toolEvent('shell', { command: item.command })]
    if (['mcp_tool_call', 'function_call'].includes(String(item.type))) return [toolEvent(typeof item.name === 'string' ? item.name : 'tool', item.arguments)]
    if (item.type === 'file_change') return [toolEvent('edit', { path: Array.isArray(item.changes) ? object(item.changes[0]).path : undefined })]
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
  validateLimits(limits: AgentLimits): void {
    if (limits.maxCostUsd !== undefined && this.provider !== 'claude') throw new AgentExecutionError(`A strict USD cap is unsupported by the ${this.provider} CLI. Use Claude's native cap or remove the dollar cap.`, 'cost_limit_unsupported')
    if (limits.maxTokens !== undefined && this.provider === 'kimi') throw new AgentExecutionError('Kimi does not report authoritative token usage. Remove the token cap or select another provider for this role.', 'usage_unavailable')
  }
  async execute(request: AgentRequest): Promise<AgentResult> {
    validateAgentRequest(request)
    this.validateLimits(request)
    const scope = canonicalWorkspace(request.cwd, request.allowedRoots)
    const normalized = { ...request, cwd: scope.cwd, allowedRoots: scope.roots }
    const runner = this.options.runProcess ?? runCliProcess
    let temporary: string | undefined, kimiAgentFile: string | undefined, geminiPolicyFile: string | undefined, codexSchemaFile: string | undefined, stream = '', turns = 0
    const assistantIds = new Set<string>()
    const scratch = (): string => temporary ??= mkdtempSync(path.join(tmpdir(), 'specrails-' + this.provider + '-role-'))
    try {
      if (this.provider === 'gemini' && request.role !== 'developer') {
        assertGeminiAdminPolicyAvailable()
        const help = await runner({ command: 'gemini', args: ['--help'] }, { cwd: scope.cwd, signal: request.signal, timeoutMs: 10_000, env: this.options.env })
        if (help.exitCode !== 0 || !help.stdout.includes('--admin-policy')) throw new AgentExecutionError('Gemini architect/reviewer roles require --admin-policy support for an enforced read-only tool allowlist. Upgrade Gemini CLI or select another provider for this role.', 'provider_capability_unsupported')
        geminiPolicyFile = path.join(scratch(), 'readonly.toml')
        writeFileSync(geminiPolicyFile, GEMINI_READONLY_POLICY, { mode: 0o600 })
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
        writeFileSync(codexSchemaFile, JSON.stringify(request.outputSchema), { mode: 0o600 })
      }
      const result = await runner(buildCliInvocation(this.provider, normalized, { kimiAgentFile, geminiPolicyFile, codexSchemaFile }), {
        cwd: scope.cwd, signal: request.signal, timeoutMs: request.timeoutMs ?? 15 * 60_000, env: this.options.env,
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
          if (turns > (request.maxTurns ?? 24)) throw new AgentExecutionError('CLI exceeded its configured turn/tool limit', 'max_turns', parseCliOutput(this.provider, stream).usage)
          for (const tool of cliToolEvents(this.provider, event)) request.onEvent?.(tool)
          if (delta) request.onEvent?.({ kind: 'text', text: delta })
        },
      })
      const parsed = parseCliOutput(this.provider, result.stdout)
      request.onEvent?.({ kind: 'usage', usage: parsed.usage })
      if (result.exitCode !== 0 || parsed.failed) throw new AgentExecutionError(`${this.provider} execution failed${result.exitCode !== 0 ? ` (exit ${result.exitCode})` : ''}. Check provider authentication, model access and limits.`, 'provider_execution_error', parsed.usage)
      if (!parsed.terminal || !parsed.text.trim()) throw new AgentExecutionError(`${this.provider} exited without a successful final result`, 'incomplete_response', parsed.usage)
      if (request.maxTokens !== undefined) {
        if (parsed.usage.inputTokens === null || parsed.usage.outputTokens === null) throw new AgentExecutionError(`${this.provider} did not report usage needed for the token limit`, 'usage_unavailable', parsed.usage)
        if (parsed.usage.inputTokens + parsed.usage.outputTokens > request.maxTokens) throw new AgentExecutionError('Agent token budget exceeded', 'token_budget', parsed.usage)
      }
      // The final text was already streamed as it arrived; re-emitting it would
      // print every summary twice in host logs.
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
