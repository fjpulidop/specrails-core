import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { DriverDescriptor } from '../../domain/types.js'
import type { CloseReason, DriverEventSink, DriverFactory, DriverInput, DriverOpenSpec, DriverSession } from '../../ports.js'
import { spawnResidentProcess, type ProcessSpawner, type ProviderProcess } from '../common/process.js'
import { claudeArgs } from './argv.js'
import { ClaudeTranslator } from './translator.js'

export const CLAUDE_DESCRIPTOR: DriverDescriptor = Object.freeze({
  id: 'claude',
  displayName: 'Claude Code',
  testedVersions: ['2.1.285'],
  capabilities: Object.freeze({
    resident: true,
    nativeInputQueue: true,
    subagents: 'supported' as const,
    subagentDisable: true,
    autonomousContinuation: true,
    steer: true,
    usage: Object.freeze({ costUsd: 'session-cumulative' as const, tokens: 'per-turn' as const }),
  }),
})

export interface ClaudeDriverOptions {
  binary?: string
  spawner?: ProcessSpawner
  env?: NodeJS.ProcessEnv
  /** Grace between SIGTERM and SIGKILL; Claude reports stopped tasks while it shuts down. */
  terminateGraceMs?: number
  /** Inline system prompts longer than this go through a private temp file. */
  maxInlineSystemPrompt?: number
}

const IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' })

function userContent(input: DriverInput): unknown {
  const files = (input.attachments ?? []).filter((item) => item.kind === 'file' || !IMAGE_TYPES[path.extname(item.path).toLowerCase()])
  const images = (input.attachments ?? []).filter((item) => item.kind === 'image' && IMAGE_TYPES[path.extname(item.path).toLowerCase()])
  const text = files.length ? `${input.text}\n\nAttached files:\n${files.map((file) => `- ${file.path}`).join('\n')}` : input.text
  if (images.length === 0) return text
  return [
    ...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType ?? IMAGE_TYPES[path.extname(image.path).toLowerCase()], data: readFileSync(image.path).toString('base64') } })),
    { type: 'text', text },
  ]
}

class ClaudeDriverSession implements DriverSession {
  private closing: Promise<void> | null = null

  constructor(private readonly process: ProviderProcess, private readonly translator: ClaudeTranslator, private readonly graceMs: number, private readonly cleanup: () => void) {}

  async send(input: DriverInput): Promise<void> {
    this.translator.noteInput(input.inputId)
    const frame = {
      type: 'user',
      uuid: input.inputId,
      session_id: '',
      parent_tool_use_id: null,
      // `next` delivers into the running turn; otherwise the CLI queues it for the next turn.
      ...(input.delivery === 'steer' ? { priority: 'next' } : {}),
      message: { role: 'user', content: userContent(input) },
    }
    if (!this.process.write(JSON.stringify(frame))) throw new Error('Claude input is closed')
  }

  async interrupt(): Promise<void> {
    this.translator.noteInterrupt()
    this.process.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }))
  }

  /** Claude Code exposes no per-task stop on stdin: stopping means ending the process. */
  async stopSubagents(): Promise<'process'> {
    return 'process'
  }

  close(_reason: CloseReason): Promise<void> {
    this.closing ??= (async () => {
      this.process.endInput()
      await this.process.terminate(this.graceMs)
      this.cleanup()
    })()
    return this.closing
  }
}

export class ClaudeDriverFactory implements DriverFactory {
  readonly descriptor = CLAUDE_DESCRIPTOR

  constructor(private readonly options: ClaudeDriverOptions = {}) {}

  async open(spec: DriverOpenSpec, sink: DriverEventSink): Promise<DriverSession> {
    const translator = new ClaudeTranslator()
    let promptDir: string | null = null
    let systemPromptFile: string | undefined
    const maxInline = this.options.maxInlineSystemPrompt ?? (process.platform === 'win32' ? 4_000 : 64_000)
    if (spec.systemPrompt && spec.systemPrompt.length > maxInline) {
      promptDir = mkdtempSync(path.join(tmpdir(), 'specrails-session-'))
      systemPromptFile = path.join(promptDir, 'system-prompt.md')
      writeFileSync(systemPromptFile, spec.systemPrompt, { mode: 0o600 })
    }
    const cleanup = () => { if (promptDir) rmSync(promptDir, { recursive: true, force: true }) }
    let closed = false
    const spawner = this.options.spawner ?? spawnResidentProcess
    const child = spawner(
      { command: this.options.binary ?? 'claude', args: claudeArgs(spec, systemPromptFile ? { systemPromptFile } : {}), cwd: spec.cwd, env: { ...(this.options.env ?? process.env) } },
      {
        onLine: (line) => {
          if (closed) return
          let frame: Record<string, unknown>
          try { frame = JSON.parse(line) as Record<string, unknown> } catch {
            sink({ kind: 'diagnostic', level: 'warning', code: 'provider.unparseable', message: line.slice(0, 500) })
            return
          }
          for (const event of translator.translate(frame)) sink(event)
        },
      },
    )
    const session = new ClaudeDriverSession(child, translator, this.options.terminateGraceMs ?? 5_000, cleanup)
    let closeRequested = false
    void child.exited.then((exit) => {
      cleanup()
      // An exit we asked for is not a crash; lines printed while stopping were already delivered.
      if (!closed && !closeRequested) sink({ kind: 'process.exited', exitCode: exit.exitCode, signal: exit.signal })
      closed = true
    })
    const originalClose = session.close.bind(session)
    session.close = async (reason) => {
      closeRequested = true
      await originalClose(reason)
      closed = true
    }
    sink({ kind: 'process.started', ...(child.pid !== undefined ? { pid: child.pid } : {}) })
    return session
  }
}
