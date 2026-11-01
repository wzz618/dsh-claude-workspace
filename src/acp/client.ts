import type { HostOps } from '../host/types.ts'
import { CcwError } from '../util/errors.ts'
import { AcpConnection, type CloseReason, type ConnectionStreams } from './connection.ts'
import { AcpProcess, startAcpProcess } from './transport.ts'
import {
  ACP_PROTOCOL_VERSION,
  type InitializeResult,
  type LoadSessionParams,
  type LoadSessionResult,
  type NewSessionParams,
  type NewSessionResult,
  type PermissionOutcome,
  type PromptParams,
  type PromptResult,
  type RequestPermissionParams,
  type SetConfigOptionParams,
  type SessionUpdate,
} from './types.ts'

const PLUGIN_NAME = 'dsh-claude-workspace'
const PLUGIN_VERSION = '0.1.0'

export interface AcpClientOptions {
  readonly maxLineBytes: number
  readonly handshakeTimeoutMs: number
  readonly requestTimeoutMs: number
  /** 0 disables the prompt timeout. */
  readonly promptTimeoutMs: number
  /** Rotating stderr log written on the DSH host. */
  readonly log?: { readonly path: string; readonly maxBytes: number; readonly files: number }
  readonly onSessionUpdate: (sessionId: string, update: SessionUpdate) => void
  readonly onPermission: (params: RequestPermissionParams) => Promise<PermissionOutcome>
  readonly onClose: (reason: CloseReason) => void
}

/**
 * One initialized ACP connection to a Claude Code agent process.
 *
 * The client declares no filesystem, terminal, or elicitation capabilities:
 * Claude Code uses its own native tools, and declaring capabilities it does not
 * need would create calls the client must then reject. Permission requests are
 * routed to the owning gate; everything else is answered as unsupported.
 */
export class AcpClient {
  readonly #process: AcpProcess
  readonly #connection: AcpConnection
  readonly #options: AcpClientOptions
  readonly #sessions = new Set<string>()
  #closed = false
  #initializeResult: InitializeResult | undefined

  private constructor(process: AcpProcess, options: AcpClientOptions) {
    this.#process = process
    this.#options = options
    const streams: ConnectionStreams = { stdin: process.stdin, stdout: process.stdout }
    this.#connection = new AcpConnection(streams, {
      maxLineBytes: options.maxLineBytes,
      onRequest: (method, params) => this.#handleRequest(method, params),
      onNotification: (method, params) => this.#handleNotification(method, params),
      onClose: (reason) => {
        this.#closed = true
        options.onClose(reason)
      },
    })
  }

  /**
   * Starts the agent process and completes the ACP handshake.
   *
   * @param host - Host that owns the process.
   * @param options - Timeouts, event callbacks, and line limit.
   * @param processCwd - Working directory for local hosts; remote hosts derive it from `session/new`.
   * @returns An initialized client.
   * @throws {CcwError} When the process fails to start or the protocol version differs.
   */
  static async start(host: HostOps, options: AcpClientOptions, processCwd?: string): Promise<AcpClient> {
    const process = await startAcpProcess(host, {
      ...(processCwd === undefined ? {} : { cwd: processCwd }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })
    const client = new AcpClient(process, options)
    try {
      await client.#initialize()
    } catch (error) {
      await process.stop().catch(() => undefined)
      throw error
    }
    return client
  }

  /** Agent identity and capabilities reported by `initialize`. */
  get agent(): InitializeResult | undefined {
    return this.#initializeResult
  }

  /** True after the agent process or transport ended. */
  get closed(): boolean {
    return this.#closed
  }

  /** Bounded stderr tail for diagnostics. */
  stderrTail(limit = 2000): string {
    return this.#process.stderrTail(limit)
  }

  /** True when this connection has a session with the given ACP id. */
  hasSession(sessionId: string): boolean {
    return this.#sessions.has(sessionId)
  }

  /** Creates a new agent session in the given working directory. */
  async newSession(params: NewSessionParams): Promise<NewSessionResult> {
    assertAbsoluteCwd(params.cwd)
    const result = await this.#connection.request<NewSessionResult>('session/new', params, this.#options.requestTimeoutMs)
    if (typeof result.sessionId !== 'string' || result.sessionId.length === 0) {
      throw new CcwError('acp-protocol-error', 'session/new returned no session id', {})
    }
    this.#sessions.add(result.sessionId)
    return result
  }

  /** Loads an existing agent session, replaying its history as notifications. */
  async loadSession(params: LoadSessionParams): Promise<LoadSessionResult> {
    assertAbsoluteCwd(params.cwd)
    const result = await this.#connection.request<LoadSessionResult>('session/load', params, this.#options.requestTimeoutMs)
    this.#sessions.add(params.sessionId)
    return result
  }

  /** Sends one user prompt and waits for the turn to finish. */
  async prompt(params: PromptParams): Promise<PromptResult> {
    return this.#connection.request<PromptResult>('session/prompt', params, this.#options.promptTimeoutMs)
  }

  /** Requests cancellation of the current turn. */
  cancel(sessionId: string): void {
    this.#connection.notify('session/cancel', { sessionId })
  }

  /** Switches the session's permission mode. */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.#connection.request('session/set_mode', { sessionId, modeId }, this.#options.requestTimeoutMs)
  }

  /** Sets one config option such as model or effort. */
  async setConfigOption(params: SetConfigOptionParams): Promise<void> {
    await this.#connection.request('session/set_config_option', params, this.#options.requestTimeoutMs)
  }

  /** Ends the connection and stops the process. */
  async stop(): Promise<void> {
    this.#closed = true
    this.#connection.close()
    this.#connection.dispose()
    await this.#process.stop()
  }

  async #initialize(): Promise<void> {
    const result = await this.#connection.request<InitializeResult>(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
        clientCapabilities: {},
      },
      this.#options.handshakeTimeoutMs,
    )
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new CcwError(
        'acp-protocol-error',
        `agent speaks ACP protocol ${result.protocolVersion}; this plugin supports ${ACP_PROTOCOL_VERSION}`,
        { agentProtocolVersion: result.protocolVersion },
      )
    }
    this.#initializeResult = result
  }

  async #handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'session/request_permission': {
        const request = params as RequestPermissionParams
        let outcome: PermissionOutcome
        try {
          outcome = await this.#options.onPermission(request)
        } catch {
          outcome = { outcome: 'cancelled' }
        }
        return { outcome }
      }
      case 'fs/read_text_file':
      case 'fs/write_text_file':
      case 'terminal/create':
      case 'terminal/output':
      case 'terminal/wait_for_exit':
      case 'terminal/kill':
      case 'terminal/release':
      case 'elicitation/create':
        throw new CcwError('acp-protocol-error', `client capability not declared: ${method}`, { method })
      default:
        throw new CcwError('acp-protocol-error', `unsupported agent request: ${method}`, { method })
    }
  }

  #handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    if (!isRecord(params)) return
    const sessionId = params.sessionId
    const update = params.update
    if (typeof sessionId !== 'string' || !isRecord(update) || typeof update.sessionUpdate !== 'string') return
    this.#options.onSessionUpdate(sessionId, update as unknown as SessionUpdate)
  }
}

function assertAbsoluteCwd(cwd: string): void {
  if (!cwd.startsWith('/')) {
    throw new CcwError('config-invalid', `ACP session cwd must be absolute, got "${cwd}"`, { cwd })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
