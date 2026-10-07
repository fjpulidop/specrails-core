/** Minimal JSON-RPC 2.0 peer over newline-delimited frames (Codex app-server). */
type Json = Record<string, unknown>

export class RpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); this.name = 'RpcError' }
}

export interface RpcHandlers {
  /** Server notification. */
  onNotification(method: string, params: Json): void
  /** Server request; return the result (or throw RpcError to answer with an error). */
  onRequest(method: string, params: Json): Json
}

export class JsonRpcPeer {
  private nextId = 1
  private readonly pending = new Map<number, { method: string; resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private closedError: Error | null = null

  constructor(private readonly write: (line: string) => boolean, private readonly handlers: RpcHandlers, private readonly timeoutMs = 60_000) {}

  request(method: string, params: Json): Promise<Json> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = this.nextId++
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(`Codex app-server did not answer ${method} in time`))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      if (!this.write(JSON.stringify({ id, method, params }))) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new RpcError('Codex app-server input is closed'))
      }
    })
  }

  notify(method: string, params?: Json): void {
    this.write(JSON.stringify(params ? { method, params } : { method }))
  }

  /** Feed one stdout line. */
  receive(frame: Json): void {
    const id = frame.id
    if (typeof frame.method === 'string') {
      if (typeof id === 'number' || typeof id === 'string') {
        try { this.write(JSON.stringify({ id, result: this.handlers.onRequest(frame.method, (frame.params ?? {}) as Json) })) }
        catch (error) { this.write(JSON.stringify({ id, error: { code: error instanceof RpcError ? error.code ?? -32603 : -32603, message: (error as Error).message } })) }
      } else this.handlers.onNotification(frame.method, (frame.params ?? {}) as Json)
      return
    }
    if (typeof id !== 'number') return
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    clearTimeout(request.timer)
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as Json
      request.reject(new RpcError(typeof error.message === 'string' ? error.message : `Codex rejected ${request.method}`, typeof error.code === 'number' ? error.code : undefined))
    } else request.resolve((frame.result ?? {}) as Json)
  }

  /** Reject everything in flight (process ended). */
  close(reason: string): void {
    this.closedError = new RpcError(reason)
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer)
      request.reject(this.closedError)
      this.pending.delete(id)
    }
  }
}
