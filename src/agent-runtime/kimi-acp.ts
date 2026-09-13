import { toolEvent } from './tool-event.js'
import { normalizeKimiCliModel } from '../installer/runtime/kimi.js'
import { AgentExecutionError, unknownUsage, validateAgentRequest, type AgentRequest, type AgentResult } from './executor-types.js'
import { runCliProcess, type CliDuplexControl, type CliProcessRunner } from './cli-process.js'
import { parseStructuredText } from './openai-executor.js'
import { WorkspaceTools } from './workspace-tools.js'

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
/** Native ACP v1 keeps Kimi 0.27 read-only roles usable without a platform skill or a model call during capability negotiation. */
export async function executeKimiReadonlyAcp(request: AgentRequest, options: { runProcess?: CliProcessRunner; env?: NodeJS.ProcessEnv; openspecBridge?: { command: string; args: string[] } } = {}): Promise<AgentResult> {
  validateAgentRequest(request)
  if (request.role === 'developer' && !options.openspecBridge) throw new AgentExecutionError('Read-only ACP transport cannot execute developer roles', 'invalid_request')
  if (request.maxCostUsd !== undefined) throw new AgentExecutionError('Kimi cannot enforce a strict USD cap', 'cost_limit_unsupported')
  if (request.maxTokens !== undefined) throw new AgentExecutionError('Kimi 0.27 ACP does not report authoritative token usage. Remove the token cap or choose another provider for this role.', 'usage_unavailable')
  const readOnly = request.role !== 'developer'
  const mode = readOnly ? 'plan' : 'auto'
  const tools = new WorkspaceTools(request.cwd, request.allowedRoots, request.role)
  let transport: CliDuplexControl | undefined, nextId = 0, sessionId: string | undefined, text = '', completed = false, turns = 0, permissionDenied = false
  const calls = new Map<number, { method: string; success: (result: Record<string, unknown>) => void }>()
  const send = (method: string, params: Record<string, unknown>, success: (result: Record<string, unknown>) => void): void => {
    const id = ++nextId
    calls.set(id, { method, success })
    transport!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  }
  const prompt = (): void => {
    send('session/prompt', { sessionId, prompt: [{ type: 'text', text: request.prompt }] }, result => {
      if (result.stopReason !== 'end_turn' || !text.trim()) throw new AgentExecutionError('Kimi ACP did not return a complete final result', 'incomplete_response')
      if (permissionDenied) throw new AgentExecutionError('Kimi requested a forbidden operation during a read-only role', 'tool_policy_violation')
      completed = true
      transport!.complete()
    })
  }
  const selectMode = (): void => {
    send('session/set_mode', { sessionId, modeId: mode }, () => {
      if (request.model) send('session/set_config_option', { sessionId, configId: 'model', value: normalizeKimiCliModel(request.model) }, prompt)
      else prompt()
    })
  }
  const onMessage = (line: string): void => {
    let message: Record<string, unknown>
    try { message = record(JSON.parse(line)) } catch { throw new AgentExecutionError('Kimi emitted malformed ACP framing', 'invalid_response') }
    if (message.jsonrpc !== '2.0') throw new AgentExecutionError('Kimi emitted an invalid JSON-RPC envelope', 'invalid_response')
    if (typeof message.method === 'string') {
      const params = record(message.params)
      if (message.method === 'session/update' && message.id === undefined) {
        if (!sessionId || params.sessionId !== sessionId) return
        const update = record(params.update)
        if (update.sessionUpdate === 'agent_message_chunk') {
          const content = record(update.content)
          if (content.type === 'text' && typeof content.text === 'string') { text += content.text; request.onEvent?.({ kind: 'text', text: content.text }) }
        }
        if (update.sessionUpdate === 'tool_call') {
          // Progress text remains in onEvent; structured results contain only
          // the assistant turn after the last tool invocation.
          text = ''
          turns++
          if (turns > (request.maxTurns ?? 100)) throw new AgentExecutionError('Kimi ACP exceeded its tool limit', 'max_turns')
          request.onEvent?.(toolEvent(typeof update.title === 'string' ? update.title : 'kimi-tool', { ...record(update.rawInput), paths: Array.isArray(update.locations) ? update.locations.map(location => record(location).path) : [] }))
        }
        if (update.sessionUpdate === 'current_mode_update' && update.currentModeId !== mode) throw new AgentExecutionError('Kimi left its read-only mode', 'tool_policy_violation')
        if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
          const mode = update.configOptions.map(record).find(option => option.id === 'mode')
          if (mode && mode.currentValue !== (readOnly ? 'plan' : 'auto')) throw new AgentExecutionError('Kimi left its read-only mode', 'tool_policy_violation')
        }
        return
      }
      if (message.id === undefined) return
      const respond = (result: Record<string, unknown>): void => transport!.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      const deny = (): void => {
        permissionDenied = true
        transport!.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Operation unavailable in a read-only Specrails role' } }))
      }
      if (!sessionId || params.sessionId !== sessionId) { deny(); return }
      if (message.method === 'fs/read_text_file') {
        let content: string
        try {
          if (typeof params.path !== 'string') throw new Error('Missing path')
          content = tools.execute('read_file', { path: params.path })
          if (params.line !== undefined || params.limit !== undefined) {
            const start = params.line ?? 1, limit = params.limit ?? Number.MAX_SAFE_INTEGER
            if (!Number.isSafeInteger(start) || (start as number) < 1 || !Number.isSafeInteger(limit) || (limit as number) < 1) throw new Error('Invalid line range')
            content = content.split('\n').slice((start as number) - 1, (start as number) - 1 + (limit as number)).join('\n')
          }
        } catch { deny(); return }
        respond({ content })
        return
      }
      if (message.method === 'session/request_permission') {
        // Only an explicit read/search of a validated workspace path may be approved.
        const tool = record(params.toolCall), input = record(tool.rawInput)
        const file = input.path ?? input.file_path
        const choices = Array.isArray(params.options) ? params.options.map(record) : []
        const allow = choices.find(option => option.kind === 'allow_once')
        if (options.openspecBridge && ['mcp__specrails_openspec__workflow', 'mcp__specrails_openspec__read_verification_evidence'].includes(typeof tool.title === 'string' ? tool.title : '') && typeof allow?.optionId === 'string') {
          respond({ outcome: { outcome: 'selected', optionId: allow.optionId } }); return
        }
        if (!readOnly && typeof allow?.optionId === 'string') {
          respond({ outcome: { outcome: 'selected', optionId: allow.optionId } }); return
        }
        if (['read', 'search'].includes(String(tool.kind)) && typeof file === 'string' && typeof allow?.optionId === 'string') {
          try {
            tools.execute(tool.kind === 'read' ? 'read_file' : 'list_files', { path: file })
            respond({ outcome: { outcome: 'selected', optionId: allow.optionId } })
            return
          } catch { /* reject an unscoped or unsupported read */ }
        }
        // No pre-existing provider permission can authorize a write/shell/mode switch for this role.
        permissionDenied = true
        respond({ outcome: { outcome: 'cancelled' } })
        return
      }
      deny()
      return
    }
    if (typeof message.id !== 'number') throw new AgentExecutionError('Kimi returned an unexpected ACP response', 'invalid_response')
    const call = calls.get(message.id)
    if (!call) throw new AgentExecutionError('Kimi returned an unknown ACP response id', 'invalid_response')
    calls.delete(message.id)
    if (message.error) throw new AgentExecutionError(`Kimi ACP ${call.method} failed. Check CLI capabilities, authentication and the configured model.`, 'provider_execution_error')
    if (!message.result || typeof message.result !== 'object') throw new AgentExecutionError('Kimi ACP response is missing its result', 'invalid_response')
    call.success(record(message.result))
  }
  const result = await (options.runProcess ?? runCliProcess)({ command: 'kimi', args: ['acp'] }, {
    cwd: tools.cwd, signal: request.signal, timeoutMs: request.timeoutMs ?? 15 * 60_000, env: options.env, onLine: onMessage,
    duplex: control => {
      transport = control
      send('initialize', { protocolVersion: 1, clientInfo: { name: 'specrails-core', version: '1' }, clientCapabilities: { fs: { readTextFile: readOnly, writeTextFile: readOnly }, terminal: readOnly } }, initialized => {
        if (initialized.protocolVersion !== 1) throw new AgentExecutionError('Kimi ACP protocol version is unsupported', 'provider_capability_unsupported')
        const capabilities = record(record(initialized.agentCapabilities).sessionCapabilities)
        if (tools.roots.length > 1 && capabilities.additionalDirectories === undefined) throw new AgentExecutionError('This Kimi ACP version cannot expose multiple repositories. Upgrade Kimi or use another provider for this read-only role.', 'provider_capability_unsupported')
        send('session/new', { cwd: tools.cwd, mcpServers: options.openspecBridge ? [{ name: 'specrails_openspec', ...options.openspecBridge, env: [] }] : [], ...(tools.roots.length > 1 ? { additionalDirectories: tools.roots.filter(root => root !== tools.cwd) } : {}) }, session => {
          if (typeof session.sessionId !== 'string' || !session.sessionId) throw new AgentExecutionError('Kimi ACP returned no session id', 'invalid_response')
          sessionId = session.sessionId
          const modes = record(session.modes)
          const modeOption = Array.isArray(session.configOptions) ? session.configOptions.map(record).find(option => option.id === 'mode') : undefined
          const available = Array.isArray(modes.availableModes) ? modes.availableModes.map(record) : []
          const modeValues = Array.isArray(modeOption?.options) ? modeOption.options.map(record) : []
          if (!available.some(item => item.id === mode) && !modeValues.some(item => item.value === mode)) throw new AgentExecutionError('Kimi ACP does not expose enforced plan mode; upgrade Kimi Code before using a read-only role', 'provider_capability_unsupported')
          selectMode()
        })
      })
    },
  })
  if (result.exitCode !== 0 || !completed) throw new AgentExecutionError('Kimi ACP exited before completing the role', 'incomplete_response')
  const usage = unknownUsage()
  request.onEvent?.({ kind: 'usage', usage })
  return { text, usage, sessionId, structured: parseStructuredText(text) }
}
