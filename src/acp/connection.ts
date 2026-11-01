import { CcwError } from '../util/errors.ts'
import type { JsonRpcErrorObject, JsonRpcResponse } from './types.ts'

/** How a connection ended. */
export type CloseReason =
  | { readonly kind: 'eof' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'protocol-error'; readonly message: string }

export interface ConnectionStreams {
  readonly stdin: NodeJS.WritableStream
  readonly stdout: NodeJS.ReadableStream
}

export interface AcpConnectionOptions {
  /** Maximum bytes in one NDJSON line; larger lines close the connection. */
  readonly maxLineBytes: number
  /** Handles agent-initiated requests such as `session/request_permission`. */
  readonly onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown
  /** Handles agent notifications such as `session/update`. */
  readonly onNotification?: (method: string, params: unknown) => void
  /** Called exactly once when the transport ends or the protocol fails. */
  readonly onClose?: (reason: CloseReason) => void
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly timer: NodeJS.Timeout | undefined
}

/**
 * NDJSON JSON-RPC 2.0 connection to one ACP agent process.
 *
 * Every write is one complete line. Lines are split on LF and decoded only
 * after a complete line is available, so a UTF-8 sequence split across chunks
 * is never corrupted. A line larger than `maxLineBytes` is a protocol failure:
 * responding to it would require unbounded memory.
 */
export class AcpConnection {
  readonly #streams: ConnectionStreams
  readonly #options: AcpConnectionOptions
  readonly #pending = new Map<number | string, PendingRequest>()
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  #nextId = 1
  #closed = false
  #closeReason: CloseReason | undefined
  readonly #onData: (chunk: Buffer | string) => void
  readonly #onEnd: () => void
  readonly #onStreamError: (error: Error) => void

  constructor(streams: ConnectionStreams, options: AcpConnectionOptions) {
    this.#streams = streams
    this.#options = options
    this.#onData = (chunk) => this.#consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    this.#onEnd = () => this.#finish({ kind: 'eof' })
    this.#onStreamError = (error) => this.#finish({ kind: 'protocol-error', message: error.message })
    streams.stdout.on('data', this.#onData)
    streams.stdout.on('end', this.#onEnd)
    streams.stdout.on('close', this.#onEnd)
    streams.stdout.on('error', this.#onStreamError)
    streams.stdin.on('error', this.#onStreamError)
  }

  /** True once the transport has ended or failed. */
  get closed(): boolean {
    return this.#closed
  }

  /** The reason the connection ended, when it has. */
  get closeReason(): CloseReason | undefined {
    return this.#closeReason
  }

  /**
   * Sends one request and resolves with its result.
   *
   * @param method - ACP method name.
   * @param params - Request parameters.
   * @param timeoutMs - Timeout; 0 disables it.
   * @returns The `result` member of the response.
   */
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.#closed) {
      return Promise.reject(this.#disconnected(method))
    }
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new CcwError('acp-protocol-error', `${method} timed out after ${timeoutMs} ms`, { method, timeoutMs }))
        }, timeoutMs)
        timer.unref?.()
      }
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Sends a notification (no response expected). */
  notify(method: string, params: unknown): void {
    if (this.#closed) throw this.#disconnected(method)
    this.#write({ jsonrpc: '2.0', method, params })
  }

  /** Answers an agent request. */
  respond(id: number | string, result: unknown): void {
    if (this.#closed) return
    this.#write({ jsonrpc: '2.0', id, result })
  }

  /** Answers an agent request with a JSON-RPC error. */
  respondError(id: number | string, code: number, message: string): void {
    if (this.#closed) return
    const error: JsonRpcErrorObject = { code, message }
    this.#write({ jsonrpc: '2.0', id, error })
  }

  /** Ends the connection locally and rejects every pending request. */
  close(): void {
    this.#finish({ kind: 'closed' })
  }

  /** Detaches stream listeners without writing to the transport. */
  dispose(): void {
    this.#streams.stdout.removeListener('data', this.#onData)
    this.#streams.stdout.removeListener('end', this.#onEnd)
    this.#streams.stdout.removeListener('close', this.#onEnd)
    this.#streams.stdout.removeListener('error', this.#onStreamError)
    this.#streams.stdin.removeListener('error', this.#onStreamError)
  }

  #write(message: unknown): void {
    try {
      this.#streams.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.#finish({ kind: 'protocol-error', message: error.message })
        }
      })
    } catch (error) {
      this.#finish({ kind: 'protocol-error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  #consume(chunk: Buffer<ArrayBufferLike>): void {
    if (this.#closed) return
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a)
      if (newline < 0) break
      const line = this.#buffer.subarray(0, newline)
      this.#buffer = this.#buffer.subarray(newline + 1)
      if (line.byteLength > this.#options.maxLineBytes) {
        this.#finish({ kind: 'protocol-error', message: `ACP line exceeded ${this.#options.maxLineBytes} bytes` })
        return
      }
      const text = line.toString('utf8').replace(/\r$/, '')
      if (text.trim().length === 0) continue
      if (!this.#handleLine(text)) return
    }
    if (this.#buffer.byteLength > this.#options.maxLineBytes) {
      this.#finish({ kind: 'protocol-error', message: `ACP line exceeded ${this.#options.maxLineBytes} bytes` })
    }
  }

  #handleLine(text: string): boolean {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.#finish({ kind: 'protocol-error', message: `invalid JSON from agent: ${text.slice(0, 200)}` })
      return false
    }
    if (!isRecord(message)) {
      this.#finish({ kind: 'protocol-error', message: 'agent message is not a JSON object' })
      return false
    }
    const method = message.method
    if (typeof method === 'string') {
      if (message.id !== undefined) {
        void this.#handleServerRequest(message.id as number | string, method, message.params)
      } else {
        this.#options.onNotification?.(method, message.params)
      }
      return true
    }
    if (message.id === undefined) {
      this.#finish({ kind: 'protocol-error', message: 'agent message has neither method nor id' })
      return false
    }
    this.#handleResponse(message as unknown as JsonRpcResponse)
    return true
  }

  async #handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.#options.onRequest
    if (handler === undefined) {
      this.respondError(id, -32601, `unsupported client method: ${method}`)
      return
    }
    try {
      const result = await handler(method, params)
      this.respond(id, result)
    } catch (error) {
      this.respondError(id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  #handleResponse(message: JsonRpcResponse): void {
    if (message.id === null) return
    const pending = this.#pending.get(message.id)
    if (pending === undefined) return
    this.#pending.delete(message.id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (message.error !== undefined) {
      pending.reject(
        new CcwError('acp-protocol-error', `${pending.method} failed: ${message.error.message}`, {
          method: pending.method,
          code: message.error.code,
          data: message.error.data,
        }),
      )
      return
    }
    pending.resolve(message.result)
  }

  #finish(reason: CloseReason): void {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = reason
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(this.#disconnected(pending.method))
    }
    this.#pending.clear()
    this.#options.onClose?.(reason)
  }

  #disconnected(method: string): CcwError {
    return new CcwError('acp-disconnected', `ACP connection closed during ${method}`, { method })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
