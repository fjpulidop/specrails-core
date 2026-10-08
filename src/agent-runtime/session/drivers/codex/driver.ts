import type { DriverDescriptor } from '../../domain/types.js'
import type { CloseReason, DriverEventSink, DriverFactory, DriverInput, DriverOpenSpec, DriverSession } from '../../ports.js'
import { spawnResidentProcess, type ProcessSpawner, type ProviderProcess } from '../common/process.js'
import { codexArgs, codexSandbox, declaredCodexMcpServers } from './argv.js'
import { JsonRpcPeer, RpcError } from './rpc.js'
import { CodexTranslator } from './translator.js'

export const CODEX_DESCRIPTOR: DriverDescriptor = Object.freeze({
  id: 'codex',
  displayName: 'Codex',
  testedVersions: ['0.153.4', '0.160.1'],
  capabilities: Object.freeze({
    resident: true,
    // Codex starts a turn per request; the application holds input while one runs.
    nativeInputQueue: false,
    subagents: 'supported' as const,
    subagentDisable: true,
    subagentModel: true,
    subagentEffort: true,
    // The parent only reacts to finished sub-agents through `wait` or new input.
    autonomousContinuation: false,
    steer: true,
    toolFiltering: false,
    usage: Object.freeze({ costUsd: 'none' as const, tokens: 'cumulative' as const }),
  }),
})

export interface CodexDriverOptions {
  binary?: string
  spawner?: ProcessSpawner
  env?: NodeJS.ProcessEnv
  terminateGraceMs?: number
  rpcTimeoutMs?: number
  /** Override discovery of the user's declared MCP servers (tests). */
  declaredMcpServers?: string[]
}

function userInput(input: DriverInput): Array<Record<string, unknown>> {
  const images = (input.attachments ?? []).filter((item) => item.kind === 'image')
  const files = (input.attachments ?? []).filter((item) => item.kind === 'file')
  const text = files.length ? `${input.text}\n\nAttached files:\n${files.map((file) => `- ${file.path}`).join('\n')}` : input.text
  return [{ type: 'text', text, text_elements: [] }, ...images.map((image) => ({ type: 'localImage', path: image.path }))]
}

class CodexDriverSession implements DriverSession {
  private closing: Promise<void> | null = null

  constructor(
    private readonly child: ProviderProcess,
    private readonly peer: JsonRpcPeer,
    private readonly translator: CodexTranslator,
    private readonly threadId: string,
    private readonly spec: DriverOpenSpec,
    private readonly sink: DriverEventSink,
    private readonly graceMs: number,
    private readonly markClosing: () => void,
    /** Children asked to stop before their first turn started (0.160 announces them first). */
    private readonly pendingStops: Set<string>,
  ) {}

  async send(input: DriverInput): Promise<void> {
    const activeTurn = this.translator.activeTurnId
    if (activeTurn && input.delivery === 'steer') {
      await this.peer.request('turn/steer', { threadId: this.threadId, expectedTurnId: activeTurn, clientUserMessageId: input.inputId, input: userInput(input) })
      this.sink({ kind: 'input.receipt', inputId: input.inputId, state: 'started' })
      return
    }
    this.translator.noteTurnRequested(input.inputId)
    await this.peer.request('turn/start', {
      threadId: this.threadId,
      clientUserMessageId: input.inputId,
      input: userInput(input),
      model: this.spec.model,
      ...(this.spec.effort ? { effort: this.spec.effort } : {}),
    })
    this.sink({ kind: 'input.receipt', inputId: input.inputId, state: 'started' })
  }

  async interrupt(): Promise<void> {
    const turnId = this.translator.activeTurnId
    if (!turnId) return
    this.translator.noteInterrupt()
    await this.peer.request('turn/interrupt', { threadId: this.threadId, turnId })
  }

  /** Children are threads: each live one is interrupted on its own thread. */
  async stopSubagents(ids?: string[]): Promise<string[]> {
    const targets = this.translator.liveChildren().filter((child) => !ids || ids.includes(child.threadId))
    const stopped: string[] = []
    // A child announced but not yet running is interrupted as soon as its turn starts.
    for (const id of ids ?? []) {
      if (this.translator.isChild(id) && !this.translator.childTurnOf(id)) { this.pendingStops.add(id); stopped.push(id) }
    }
    for (const target of targets) {
      try {
        await this.peer.request('turn/interrupt', { threadId: target.threadId, turnId: target.turnId })
        stopped.push(target.threadId)
      } catch (error) {
        this.sink({ kind: 'diagnostic', level: 'warning', code: 'provider.stop_failed', message: `${target.threadId}: ${(error as Error).message}` })
      }
    }
    return stopped
  }

  close(_reason: CloseReason): Promise<void> {
    this.closing ??= (async () => {
      this.markClosing()
      this.peer.close('Codex session closed')
      this.child.endInput()
      await this.child.terminate(this.graceMs)
    })()
    return this.closing
  }
}

export class CodexDriverFactory implements DriverFactory {
  readonly descriptor = CODEX_DESCRIPTOR

  constructor(private readonly options: CodexDriverOptions = {}) {}

  async open(spec: DriverOpenSpec, sink: DriverEventSink): Promise<DriverSession> {
    const env = { ...(this.options.env ?? process.env) }
    const declared = this.options.declaredMcpServers ?? declaredCodexMcpServers(env)
    const translator = new CodexTranslator()
    const pendingStops = new Set<string>()
    let closeRequested = false
    let ended = false
    let peer: JsonRpcPeer | null = null
    const spawner = this.options.spawner ?? spawnResidentProcess
    const child = spawner(
      { command: this.options.binary ?? 'codex', args: codexArgs(spec.policy, declared), cwd: spec.cwd, env },
      {
        onLine: (line) => {
          if (ended) return
          let frame: Record<string, unknown>
          try { frame = JSON.parse(line) as Record<string, unknown> } catch {
            sink({ kind: 'diagnostic', level: 'warning', code: 'provider.unparseable', message: line.slice(0, 500) })
            return
          }
          peer?.receive(frame)
        },
      },
    )
    peer = new JsonRpcPeer((line) => child.write(line), {
      onNotification: (method, params) => {
        for (const event of translator.notification(method, params)) sink(event)
        const threadId = typeof params.threadId === 'string' ? params.threadId : null
        const turnId = threadId ? translator.childTurnOf(threadId) : null
        if (method === 'turn/started' && threadId && turnId && pendingStops.delete(threadId)) {
          void peer?.request('turn/interrupt', { threadId, turnId }).catch((error: Error) => sink({ kind: 'diagnostic', level: 'warning', code: 'provider.stop_failed', message: `${threadId}: ${error.message}` }))
        }
      },
      onRequest: (method) => {
        // approvalPolicy is `never`; a request still arriving is declined (the sandbox is the boundary).
        if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' }
        if (method === 'item/tool/requestUserInput') return { answers: {} }
        throw new RpcError(`Unsupported client request ${method}`, -32601)
      },
    }, this.options.rpcTimeoutMs ?? 60_000)

    void child.exited.then((exit) => {
      peer?.close('Codex app-server exited')
      if (!ended && !closeRequested) sink({ kind: 'process.exited', exitCode: exit.exitCode, signal: exit.signal })
      ended = true
    })

    try {
      await peer.request('initialize', { clientInfo: { name: 'specrails_core', title: 'Specrails Core', version: '1' }, capabilities: { experimentalApi: true } })
      peer.notify('initialized')
      const thread = await peer.request(spec.providerSessionRef ? 'thread/resume' : 'thread/start', {
        ...(spec.providerSessionRef ? { threadId: spec.providerSessionRef } : {}),
        model: spec.model,
        cwd: spec.cwd,
        approvalPolicy: 'never',
        sandbox: codexSandbox(spec.policy.permissions),
        ...(spec.systemPrompt ? { developerInstructions: spec.systemPrompt } : {}),
      })
      const threadId = typeof (thread.thread as Record<string, unknown> | undefined)?.id === 'string' ? (thread.thread as Record<string, string>).id! : null
      if (!threadId) throw new Error('Codex did not return a thread id')
      if (spec.providerSessionRef && threadId !== spec.providerSessionRef) throw new Error('Codex resumed an unexpected thread')
      translator.setRoot(threadId, spec.model)
      sink({ kind: 'process.started', ...(child.pid !== undefined ? { pid: child.pid } : {}) })
      sink({ kind: 'provider.ref', providerSessionRef: threadId })
      return new CodexDriverSession(child, peer, translator, threadId, spec, sink, this.options.terminateGraceMs ?? 5_000, () => { closeRequested = true }, pendingStops)
    } catch (error) {
      closeRequested = true
      peer.close('Codex session failed to start')
      await child.terminate(this.options.terminateGraceMs ?? 5_000)
      throw error
    }
  }
}
