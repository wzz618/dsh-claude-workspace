import { join } from 'node:path'
import type { HostOps } from '../host/types.ts'
import { SerialQueue } from '../util/queue.ts'
import { AcpClient } from './client.ts'
import type { CloseReason } from './connection.ts'
import type { PermissionOutcome, RequestPermissionParams, SessionUpdate } from './types.ts'

/** Observable process state for one workspace. */
export type WorkspaceRuntimeState = 'stopped' | 'ready' | 'busy' | 'disconnected'

export interface AcpPoolOptions {
  readonly maxLineBytes: number
  readonly handshakeTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly promptTimeoutMs: number
  /** 0 disables idle recycling. */
  readonly idleRecycleMs: number
  /** Rotating stderr log directory on the DSH host. */
  readonly log?: { readonly dir: string; readonly maxBytes: number; readonly files: number }
  readonly onSessionUpdate: (workspaceId: string, sessionId: string, update: SessionUpdate) => void
  readonly onPermission: (workspaceId: string, params: RequestPermissionParams) => Promise<PermissionOutcome>
  readonly onDisconnect: (workspaceId: string, reason: CloseReason) => void
  readonly onIdleClose?: (workspaceId: string) => void
}

interface Entry {
  readonly client: AcpClient
  readonly hostId: string
  busy: number
  lastUsedAt: number
  idleTimer: NodeJS.Timeout | undefined
}

/**
 * One ACP process per workspace, shared by every session in that workspace.
 *
 * Starting is serialized per workspace so two concurrent first messages cannot
 * spawn two agents. A process closes after `idleRecycleMs` with no busy
 * sessions; the next use starts a new process and reloads the session. A
 * crashed process is never restarted automatically, which avoids a restart
 * storm against an unhealthy host.
 */
export class AcpPool {
  readonly #hostFor: (hostId: string) => HostOps
  readonly #options: AcpPoolOptions
  readonly #entries = new Map<string, Entry>()
  readonly #disconnected = new Set<string>()
  readonly #queue = new SerialQueue()

  constructor(hostFor: (hostId: string) => HostOps, options: AcpPoolOptions) {
    this.#hostFor = hostFor
    this.#options = options
  }

  /**
   * Returns a started client for a workspace, starting one if necessary.
   *
   * The caller owns one busy slot until it calls `release`.
   *
   * @param workspaceId - Workspace whose process is reused.
   * @param hostId - Host that owns the process.
   * @param processCwd - Local process cwd so project settings resolve.
   */
  async acquire(workspaceId: string, hostId: string, processCwd?: string): Promise<AcpClient> {
    return this.#queue.run(workspaceId, async () => {
      const existing = this.#entries.get(workspaceId)
      if (existing !== undefined && !existing.client.closed) {
        this.#clearIdle(existing)
        existing.busy += 1
        existing.lastUsedAt = Date.now()
        this.#disconnected.delete(workspaceId)
        return existing.client
      }
      if (existing !== undefined) {
        this.#entries.delete(workspaceId)
        await existing.client.stop().catch(() => undefined)
      }
      const client = await AcpClient.start(this.#hostFor(hostId), {
        maxLineBytes: this.#options.maxLineBytes,
        handshakeTimeoutMs: this.#options.handshakeTimeoutMs,
        requestTimeoutMs: this.#options.requestTimeoutMs,
        promptTimeoutMs: this.#options.promptTimeoutMs,
        ...(this.#options.log === undefined
          ? {}
          : { log: { ...this.#options.log, path: join(this.#options.log.dir, `${workspaceId}.log`) } }),
        onSessionUpdate: (sessionId, update) => this.#options.onSessionUpdate(workspaceId, sessionId, update),
        onPermission: (params) => this.#options.onPermission(workspaceId, params),
        onClose: (reason) => {
          const entry = this.#entries.get(workspaceId)
          if (entry?.client === client) {
            this.#clearIdle(entry)
            this.#entries.delete(workspaceId)
          }
          this.#disconnected.add(workspaceId)
          this.#options.onDisconnect(workspaceId, reason)
        },
      }, processCwd)
      const entry: Entry = {
        client,
        hostId,
        busy: 1,
        lastUsedAt: Date.now(),
        idleTimer: undefined,
      }
      this.#entries.set(workspaceId, entry)
      this.#disconnected.delete(workspaceId)
      return client
    })
  }

  /** Releases one busy slot and schedules idle recycling when none remain. */
  release(workspaceId: string): void {
    const entry = this.#entries.get(workspaceId)
    if (entry === undefined) return
    entry.busy = Math.max(0, entry.busy - 1)
    entry.lastUsedAt = Date.now()
    if (entry.busy === 0 && this.#options.idleRecycleMs > 0) {
      this.#clearIdle(entry)
      entry.idleTimer = setTimeout(() => {
        void this.close(workspaceId, 'idle')
      }, this.#options.idleRecycleMs)
      entry.idleTimer.unref?.()
    }
  }

  /** Current state for a workspace. */
  state(workspaceId: string): WorkspaceRuntimeState {
    const entry = this.#entries.get(workspaceId)
    if (entry !== undefined) return entry.busy > 0 ? 'busy' : 'ready'
    return this.#disconnected.has(workspaceId) ? 'disconnected' : 'stopped'
  }

  /** True when a live client is available for the workspace. */
  has(workspaceId: string): boolean {
    const entry = this.#entries.get(workspaceId)
    return entry !== undefined && !entry.client.closed
  }

  /** Whether the workspace's process has any busy session. */
  isBusy(workspaceId: string): boolean {
    return (this.#entries.get(workspaceId)?.busy ?? 0) > 0
  }

  /** The live client for a workspace, without starting one. */
  client(workspaceId: string): AcpClient | undefined {
    const entry = this.#entries.get(workspaceId)
    return entry !== undefined && !entry.client.closed ? entry.client : undefined
  }

  /** Closes every workspace process running on one host. */
  async closeHost(hostId: string): Promise<void> {
    const ids = [...this.#entries.entries()]
      .filter(([, entry]) => entry.hostId === hostId)
      .map(([id]) => id)
    await Promise.all(ids.map((id) => this.close(id, 'requested')))
  }

  /** Closes the workspace process, if any. */
  async close(workspaceId: string, reason: 'idle' | 'requested' | 'dispose' = 'requested'): Promise<void> {
    const entry = this.#entries.get(workspaceId)
    if (entry === undefined) return
    this.#clearIdle(entry)
    this.#entries.delete(workspaceId)
    await entry.client.stop().catch(() => undefined)
    if (reason === 'idle') this.#options.onIdleClose?.(workspaceId)
  }

  /** Closes every workspace process. */
  async closeAll(): Promise<void> {
    const ids = [...this.#entries.keys()]
    await Promise.all(ids.map((id) => this.close(id, 'dispose')))
  }

  #clearIdle(entry: Entry): void {
    if (entry.idleTimer === undefined) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }
}
